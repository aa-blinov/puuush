'use strict';
/**
 * Тесты без внешних зависимостей: node:test в комплекте Node 18+.
 *
 *     node --test test/
 *
 * Проверяем то, что ломается тихо: разбор multipart, приведение имён,
 * сравнение секретов, маршруты сервера и откат на следующий хостинг.
 * Сеть в тесты не ходит по-настоящему, хостинг подменяется заглушкой.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');

const upload = require('../src/upload.js');

// Проверка ссылки сверяет первые байты файла, поэтому заглушка обязана
// отдавать именно их, а не что-то произвольное.
const FILE = Buffer.from('данные');

// ---------------------------------------------------------------------------
// safeName: имя для ссылки и для диска
// ---------------------------------------------------------------------------

test('safeName оставляет нормальное имя в покое', () => {
  // Хвост из хеша не угадываем: проверяем форму и стабильность, а не значение.
  const n = upload.safeName('screen.png');
  assert.match(n, /^screen-[0-9a-f]{6}\.png$/);
  assert.strictEqual(upload.safeName('screen.png'), n, 'должно быть детерминированно');
  assert.strictEqual(upload.safeName('screen.png', 'x.png'), n, 'запасное имя не должно влиять');
});

test('safeName выкидывает кириллицу, но сохраняет расширение', () => {
  const n = upload.safeName('Скриншот экрана.png');
  assert.match(n, /^[A-Za-z0-9._-]+\.png$/);
  assert.ok(!/[^\x00-\x7F]/.test(n), 'в имени не должно остаться кириллицы');
});

test('safeName два одинаковых русских имени не сливаются в одно', () => {
  const a = upload.safeName('скриншот.png');
  const b = upload.safeName('скрин.png');
  assert.notStrictEqual(a, b);
});

test('safeName не пускает путь и не выходит из каталога', () => {
  const n = upload.safeName('../../etc/passwd');
  assert.ok(!n.includes('/'), `имя не должно содержать слешей: ${n}`);
  assert.ok(!n.includes('..'), `имя не должно содержать ..: ${n}`);
});

test('safeName переживает пустое и экзотическое имя', () => {
  assert.match(upload.safeName(''), /^[A-Za-z0-9._-]+$/);
  assert.match(upload.safeName('...'), /^[A-Za-z0-9._-]+$/);
  assert.match(upload.safeName('файл.БЕЗ_РАСШИРЕНИЯ'), /^[A-Za-z0-9._-]+$/);
  assert.ok(upload.safeName('a'.repeat(500)).length <= 64, 'имя должно быть коротким');
});

test('safeName не оставляет расширение-двойник', () => {
  assert.ok(!upload.safeName('x.tar.gz').includes('..'));
});

// ---------------------------------------------------------------------------
// secretEquals: сравнение без утечки по времени
// ---------------------------------------------------------------------------

test('secretEquals отличает ключ от похожего', async () => {
  const mod = await importServerHelpers();
  const k = 'a'.repeat(64);
  assert.strictEqual(mod.secretEquals(k, k), true);
  assert.strictEqual(mod.secretEquals(k, 'a'.repeat(63)), false);
  assert.strictEqual(mod.secretEquals(k, 'b' + 'a'.repeat(63)), false);
  assert.strictEqual(mod.secretEquals(k, ''), false);
  assert.strictEqual(mod.secretEquals('', k), false);
});

/** Внутренние функции сервера. Файл при require ничего не запускает. */
async function importServerHelpers() {
  return require('../server/index.js');
}

// ---------------------------------------------------------------------------
// parseMultipart: разбор тела, собранного целиком в память
// ---------------------------------------------------------------------------

function buildMultipart(boundary, name, filename, content) {
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="${name}"; filename="${filename}"\r\n` +
    `Content-Type: application/octet-stream\r\n\r\n`,
    'utf8'
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');
  return Buffer.concat([head, content, tail]);
}

test('parseMultipart достаёт файл целиком, включая переводы строк', async () => {
  const h = await importServerHelpers();
  const payload = Buffer.from('строка\r\nещё\r\n\x00\x01\x02 конец');
  const body = buildMultipart('BOUND123', 'file', 'screen.png', payload);
  const parts = h.parseMultipart(body, 'BOUND123');
  assert.strictEqual(parts.length, 1);
  assert.strictEqual(parts[0].filename, 'screen.png');
  assert.deepStrictEqual(parts[0].data, payload);
});

test('parseMultipart не путает границу, встречающуюся внутри данных', async () => {
  const h = await importServerHelpers();
  // Именно этот случай ломает наивный split по строке.
  const payload = Buffer.from('до--BOUND123 не конец\r\nпосле');
  const body = buildMultipart('BOUND123', 'file', 'a.txt', payload);
  const parts = h.parseMultipart(body, 'BOUND123');
  assert.deepStrictEqual(parts[0].data, payload);
});

test('parseMultipart переживает файл размером с лимит', async () => {
  const h = await importServerHelpers();
  const payload = crypto.randomBytes(300 * 1024);
  const body = buildMultipart('B', 'file', 'big.bin', payload);
  const parts = h.parseMultipart(body, 'B');
  assert.strictEqual(parts[0].data.length, payload.length);
  assert.ok(parts[0].data.equals(payload));
});

test('parseMultipart на мусоре не падает', async () => {
  const h = await importServerHelpers();
  assert.deepStrictEqual(h.parseMultipart(Buffer.from('ничего тут'), 'B'), []);
  assert.deepStrictEqual(h.parseMultipart(Buffer.alloc(0), 'B'), []);
});

// ---------------------------------------------------------------------------
// publish: выбор хостинга, откат, проверка ссылки
// ---------------------------------------------------------------------------

test('publish откатывается со сломанного хостинга на следующий', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'puuush-t-'));
  const file = path.join(dir, 'a.png');
  fs.writeFileSync(file, Buffer.from('данные'));

  // Подменяем сеть: первый хост отвечает «не работает», ссылка у второго
  // не вывозится, третий отдаёт годный URL.
  const origRequest = upload.__setRequestForTests(async (url, opts = {}) => {
    // Проверка ссылки тоже идёт через request(). Ссылку good3 отдаём живой,
    // а ссылку broken2 — битой: именно на этом проверке publish должен её
    // отвергнуть и дойти до третьего хостинга.
    if (url === 'https://ok/3') return { status: 200, headers: {}, body: FILE };
    if (url === 'https://ok/1') return { status: 404, headers: {}, body: Buffer.alloc(0) };
    if (url.includes('broken1')) return { status: 500, headers: {}, body: Buffer.from('бум') };
    const j = (u) => Buffer.from(JSON.stringify({ files: [{ url: u }] }));
    if (url.includes('broken2')) return { status: 200, headers: {}, body: j('https://ok/1') };
    if (url.includes('good3')) return { status: 200, headers: {}, body: j('https://ok/3') };
    throw new Error('незапланированный запрос: ' + url);
  });
  const origHosts = upload.__setHostsForTests([
    { name: 'broken1', url: 'https://broken1/u', fields: {}, fileField: 'file', temp: false },
    { name: 'broken2', url: 'https://broken2/u', fields: {}, fileField: 'file', temp: false, json: 'files.0.url' },
    { name: 'good3', url: 'https://good3/u', fields: {}, fileField: 'file', temp: false, json: 'files.0.url' },
  ]);

  try {
    const r = await upload.publish(file, { host: 'auto' });
    assert.strictEqual(r.host, 'good3');
    assert.strictEqual(r.url, 'https://ok/3');
  } finally {
    upload.__restoreRequestForTests(origRequest);
    upload.__restoreHostsForTests(origHosts);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('publish отдаёт понятную ошибку, когда не сработал никто', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'puuush-t-'));
  const file = path.join(dir, 'a.png');
  fs.writeFileSync(file, Buffer.from('данные'));

  const origRequest = upload.__setRequestForTests(async () => ({
    status: 503, headers: {}, body: Buffer.from('недоступно'),
  }));
  const origHosts = upload.__setHostsForTests([
    { name: 't', url: 'https://t/u', fields: {}, fileField: 'file', temp: false },
  ]);

  try {
    await assert.rejects(
      () => upload.publish(file, { host: 't' }),
      /не отдал рабочую ссылку|503/
    );
  } finally {
    upload.__restoreRequestForTests(origRequest);
    upload.__restoreHostsForTests(origHosts);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('publish отказывается грузить пустой файл', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'puuush-t-'));
  const file = path.join(dir, 'empty.png');
  fs.writeFileSync(file, Buffer.alloc(0));
  await assert.rejects(() => upload.publish(file, { host: 'auto' }), /пустой/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('publish ругается на отсутствующий файл', async () => {
  await assert.rejects(() => upload.publish('/нет/такого.png', {}), /нет файла/);
});

test('свой box в авторежиме не роняет загрузку, а уходит дальше', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'puuush-t-'));
  const file = path.join(dir, 'a.png');
  fs.writeFileSync(file, Buffer.from('данные'));

  const origRequest = upload.__setRequestForTests(async (url) => {
    if (url.startsWith('https://ok/')) return { status: 200, headers: {}, body: FILE };
    if (url.includes('my-server')) throw new Error('соединение отвергнуто');
    if (url.includes('fallback')) {
      return { status: 200, headers: {}, body: Buffer.from(JSON.stringify({ files: [{ url: 'https://ok/x' }] })) };
    }
    throw new Error('незапланированный: ' + url);
  });
  const origHosts = upload.__setHostsForTests([
    { name: 'fallback', url: 'https://fallback/u', fields: {}, fileField: 'file', temp: false, json: 'files.0.url' },
  ]);

  try {
    const r = await upload.publish(file, {
      host: 'auto',
      own: { base_url: 'https://my-server', write_key: 'k'.repeat(64) },
    });
    assert.strictEqual(r.host, 'fallback');
  } finally {
    upload.__restoreRequestForTests(origRequest);
    upload.__restoreHostsForTests(origHosts);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('свой box в режиме only обязан упасть, если не работает', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'puuush-t-'));
  const file = path.join(dir, 'a.png');
  fs.writeFileSync(file, Buffer.from('данные'));

  const origRequest = upload.__setRequestForTests(async (url) => {
    if (url.includes('my-server')) return { status: 401, headers: {}, body: Buffer.from('{"error":"нет ключа"}') };
    throw new Error('незапланированный: ' + url);
  });

  try {
    await assert.rejects(
      () => upload.publish(file, {
        host: 'own',
        own: { base_url: 'https://my-server', write_key: 'k'.repeat(64) },
      }),
      /отклонил ключ|401/
    );
  } finally {
    upload.__restoreRequestForTests(origRequest);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('свой box: ключ с кириллицей даёт внятную ошибку, а не ошибку Node', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'puuush-t-'));
  const file = path.join(dir, 'a.png');
  fs.writeFileSync(file, Buffer.from('данные'));
  await assert.rejects(
    () => upload.publish(file, {
      host: 'own',
      own: { base_url: 'https://my-server', write_key: 'ключ-с-кириллицей' },
    }),
    /нелатинские символы/
  );
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Сервер целиком: поднимаем на случайном порту и бьём по-настоящему
// ---------------------------------------------------------------------------

async function withServer(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'puuush-srv-'));
  const configPath = path.join(dir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({
    host: '127.0.0.1',
    port: 0,
    dir,
    write_key: 'b'.repeat(64),
    public_base: 'https://example.test',
    max_bytes: 1024 * 1024,
    max_total_bytes: 10 * 1024 * 1024,
    max_files: 100,
    keep_days: 30,
  }));

  const prevConfig = process.env.PUUUSH_CONFIG;
  process.env.PUUUSH_CONFIG = configPath;
  const mod = require('../server/index.js');
  const server = mod.createServer(mod.loadConfig());

  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn({ base, dir });
  } finally {
    await new Promise((res) => server.close(res));
    if (prevConfig === undefined) delete process.env.PUUUSH_CONFIG;
    else process.env.PUUUSH_CONFIG = prevConfig;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('сервер: без ключа 401, с ключом 201 и ссылка отдаёт файл', async () => {
  await withServer(async ({ base, dir }) => {
    const noKey = await fetch(`${base}/v1/uploads`, { method: 'POST', body: 'x' });
    assert.strictEqual(noKey.status, 401);

    const form = new FormData();
    form.append('file', new Blob([Buffer.from('привет, файл')], { type: 'image/png' }), 'screen.png');
    const ok = await fetch(`${base}/v1/uploads`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${'b'.repeat(64)}` },
      body: form,
    });
    assert.strictEqual(ok.status, 201);
    const meta = await ok.json();
    assert.match(meta.id, /^[0-9a-f]{24}$/);
    assert.ok(meta.url.startsWith('https://example.test/f/'));

    // Файл действительно лежит на диске и совпадает с исходным.
    const onDisk = fs.readFileSync(path.join(dir, meta.id, meta.name), 'utf8');
    assert.strictEqual(onDisk, 'привет, файл');
    assert.ok(fs.existsSync(path.join(dir, meta.id, 'meta.json')));
  });
});

test('сервер: файл больше лимита даёт 413, а не обрыв', async () => {
  await withServer(async ({ base }) => {
    const form = new FormData();
    form.append('file', new Blob([Buffer.alloc(2 * 1024 * 1024)]), 'big.bin');
    const res = await fetch(`${base}/v1/uploads`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${'b'.repeat(64)}` },
      body: form,
    });
    assert.strictEqual(res.status, 413);
    const body = await res.json();
    assert.ok(body.max_bytes, 'в ответе должен быть лимит, чтобы клиент понял причину');
  });
});

test('сервер: health открыт, info требует ключа', async () => {
  await withServer(async ({ base }) => {
    const h = await fetch(`${base}/v1/health`);
    assert.strictEqual(h.status, 200);
    assert.strictEqual((await h.json()).ok, true);

    const i = await fetch(`${base}/v1/info`);
    assert.strictEqual(i.status, 401);
  });
});

test('сервер: удаление убирает файл, повтор даёт 404', async () => {
  await withServer(async ({ base, dir }) => {
    const form = new FormData();
    form.append('file', new Blob([Buffer.from('данные')]), 'a.txt');
    const ok = await fetch(`${base}/v1/uploads`, {
      method: 'POST', headers: { Authorization: `Bearer ${'b'.repeat(64)}` }, body: form,
    });
    const meta = await ok.json();

    const del = await fetch(`${base}/v1/uploads/${meta.id}`, {
      method: 'DELETE', headers: { Authorization: `Bearer ${'b'.repeat(64)}` },
    });
    assert.strictEqual(del.status, 200);
    assert.ok(!fs.existsSync(path.join(dir, meta.id)));

    const again = await fetch(`${base}/v1/uploads/${meta.id}`, {
      method: 'DELETE', headers: { Authorization: `Bearer ${'b'.repeat(64)}` },
    });
    assert.strictEqual(again.status, 404);
  });
});

test('сервер: id вне формата не достаёт файл с диска', async () => {
  await withServer(async ({ base }) => {
    const auth = { Authorization: `Bearer ${'b'.repeat(64)}` };
    for (const evil of ['../../etc/passwd', '..', 'AAAA', 'a'.repeat(23), 'a'.repeat(25)]) {
      const r = await fetch(`${base}/v1/uploads/${encodeURIComponent(evil)}`, { headers: auth });
      assert.strictEqual(r.status, 404, `на ${evil} ждали 404`);
    }
  });
});

test('сервер: id из 24 hex, но чужой, тоже 404', async () => {
  await withServer(async ({ base }) => {
    const r = await fetch(`${base}/v1/uploads/${'f'.repeat(24)}`, {
      headers: { Authorization: `Bearer ${'b'.repeat(64)}` },
    });
    assert.strictEqual(r.status, 404);
  });
});

test('сервер: лимит попыток без ключа срабатывает', async () => {
  await withServer(async ({ base }) => {
    const codes = [];
    for (let i = 0; i < 34; i++) {
      const r = await fetch(`${base}/v1/uploads`, { method: 'POST', body: 'x' });
      codes.push(r.status);
    }
    assert.ok(codes.includes(429), `ожидался 429 среди ${codes.slice(-5)}`);
    // И верный ключ после серии неудач продолжает работать.
    const form = new FormData();
    form.append('file', new Blob([Buffer.from('ok')]), 'a.txt');
    const ok = await fetch(`${base}/v1/uploads`, {
      method: 'POST', headers: { Authorization: `Bearer ${'b'.repeat(64)}` }, body: form,
    });
    assert.strictEqual(ok.status, 201);
  });
});

test('сервер: ключ в лог не попадает', async () => {
  await withServer(async ({ base }) => {
    const written = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk, ...rest) => { written.push(String(chunk)); return true; };
    try {
      await fetch(`${base}/v1/uploads`, {
        method: 'POST', headers: { Authorization: 'Bearer s3cret-key-value-that-must-not-appear' }, body: 'x',
      });
      await new Promise((r) => setTimeout(r, 50));
    } finally {
      process.stdout.write = origWrite;
    }
    const log = written.join('');
    assert.ok(!log.includes('s3cret-key-value-that-must-not-appear'), 'ключ не должен писаться в лог');
  });
});

test('сервер: картинка отдаётся с правильным типом из расширения', async () => {
  await withServer(async ({ base, dir }) => {
    const png = Buffer.from(
      '89504e470d0a1a0a0000000d4948445200000001000000010806000000' +
      '1f15c4890000000d4944415478da63fccfc0f01f0005fe02fea735c9c1a0000000049454e44ae426082',
      'hex'
    );
    const form = new FormData();
    form.append('file', new Blob([png], { type: 'image/png' }), 'screen.png');
    const ok = await fetch(`${base}/v1/uploads`, {
      method: 'POST', headers: { Authorization: `Bearer ${'b'.repeat(64)}` }, body: form,
    });
    const meta = await ok.json();
    assert.strictEqual(meta.mime, 'image/png');
    assert.ok(meta.name.endsWith('.png'), `имя должно сохранить расширение: ${meta.name}`);
    assert.ok(fs.existsSync(path.join(dir, meta.id, meta.name)));
  });
});

test('сервер: сырое тело без multipart тоже принимается', async () => {
  await withServer(async ({ base }) => {
    const res = await fetch(`${base}/v1/uploads`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${'b'.repeat(64)}`,
        'Content-Type': 'image/png',
        'X-Filename': 'raw.png',
      },
      body: Buffer.from('как будто картинка'),
    });
    assert.strictEqual(res.status, 201);
    const meta = await res.json();
    assert.match(meta.name, /\.png$/);
  });
});

test('сервер: два id не совпадают', async () => {
  await withServer(async ({ base }) => {
    const ids = new Set();
    for (let i = 0; i < 5; i++) {
      const form = new FormData();
      form.append('file', new Blob([Buffer.from('x' + i)]), 'a.txt');
      const r = await fetch(`${base}/v1/uploads`, {
        method: 'POST', headers: { Authorization: `Bearer ${'b'.repeat(64)}` }, body: form,
      });
      ids.add((await r.json()).id);
    }
    assert.strictEqual(ids.size, 5, 'id должны быть уникальными');
  });
});
// ---------------------------------------------------------------------------
// Регрессии, найденные при подготовке к продакшну
// ---------------------------------------------------------------------------

test('publish отказывает файл больше потолка и не читает его в память', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'puuush-t-'));
  const file = path.join(dir, 'huge.bin');
  fs.writeFileSync(file, Buffer.alloc(1024));
  await assert.rejects(
    () => upload.publish(file, { host: 'auto', maxBytes: 512 }),
    /больше потолка/
  );
  fs.rmSync(dir, { recursive: true, force: true });
});

test('publish по умолчанию пропускает файл в пределах потолка', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'puuush-t-'));
  const file = path.join(dir, 'a.png');
  fs.writeFileSync(file, Buffer.alloc(64));

  // Файл состоит из нулей, значит и ответ должен начинаться с нулей.
  const origRequest = upload.__setRequestForTests(async (url) => {
    if (url === 'https://ok/3') return { status: 200, headers: {}, body: Buffer.alloc(64) };
    return { status: 200, headers: {}, body: Buffer.from(JSON.stringify({ files: [{ url: 'https://ok/3' }] })) };
  });
  const origHosts = upload.__setHostsForTests([
    { name: 'good3', url: 'https://good3/u', fields: {}, fileField: 'file', temp: false, json: 'files.0.url' },
  ]);
  try {
    const r = await upload.publish(file, { host: 'good3' });
    assert.strictEqual(r.url, 'https://ok/3');
  } finally {
    upload.__restoreRequestForTests(origRequest);
    upload.__restoreHostsForTests(origHosts);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('setSettings бросает, если настройки не записались', () => {
  // store.js тянет app.getPath(), которого нет вне Electron. Подменяем его,
  // чтобы проверить именно поведение при отказе записи.
  const Module = require('node:module');
  const storePath = path.join(__dirname, '..', 'src', 'store.js');
  const original = require.cache[storePath];
  delete require.cache[storePath];

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'puuush-store-'));
  const electronShim = {
    app: { getPath: () => dir, getPath_: null },
  };
  const realLoad = Module._load;
  Module._load = function (req, parent, isMain) {
    if (req === 'electron') return electronShim;
    return realLoad.call(this, req, parent, isMain);
  };
  try {
    const store = require(storePath);

    // Сначала пишем нормально, потом делаем каталог только для чтения.
    store.setSettings({ host: 'uguu' });
    assert.strictEqual(store.getSettings().host, 'uguu');

    fs.chmodSync(dir, 0o500);
    assert.throws(
      () => store.setSettings({ host: 'catbox' }),
      /не смог записать settings\.json/,
      'молча возвращать успех нельзя'
    );
    // Значение на диске не должно было смениться.
    fs.chmodSync(dir, 0o700);
    assert.strictEqual(store.getSettings().host, 'uguu');
  } finally {
    Module._load = realLoad;
    delete require.cache[storePath];
    fs.chmodSync(dir, 0o700);
    fs.rmSync(dir, { recursive: true, force: true });
    if (original) require.cache[storePath] = original;
  }
});

test('битый settings.json не откатывается молча', () => {
  const Module = require('node:module');
  const storePath = path.join(__dirname, '..', 'src', 'store.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'puuush-store-'));
  fs.writeFileSync(path.join(dir, 'settings.json'), '{"host":"own","own":{"base_url":"https://x.ru","write_ke');

  const realLoad = Module._load;
  Module._load = function (req, parent, isMain) {
    if (req === 'electron') return { app: { getPath: () => dir } };
    return realLoad.call(this, req, parent, isMain);
  };
  try {
    delete require.cache[storePath];
    const errors = [];
    const origError = console.error;
    console.error = (m) => errors.push(String(m));
    try {
      const store = require(storePath);
      const s = store.getSettings();
      // Значения по умолчанию, но о факте поломки сказано вслух.
      assert.strictEqual(s.host, 'auto');
      assert.ok(errors.some((e) => e.includes('повреждён')),
        'о битом файле должно быть сказано в stderr');
    } finally {
      console.error = origError;
    }
  } finally {
    Module._load = realLoad;
    delete require.cache[storePath];
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('сервер: 500 не раскрывает путь файловой системы', async () => {
  await withServer(async ({ base, dir }) => {
    const auth = { Authorization: `Bearer ${'b'.repeat(64)}` };
    // Заменяем каталог хранилища файлом: mkdir упадёт с ENOTDIR, и мы получим
    // именно ошибку записи. Прежний вариант с chmod 0500 проходил без единой
    // проверки, когда тест запускали не от root: запись удавалась, статус был
    // 201, и условие просто не выполнялось.
    fs.rmSync(dir, { recursive: true, force: true });
    fs.writeFileSync(dir, 'это файл, а не каталог');
    try {
      const form = new FormData();
      form.append('file', new Blob([Buffer.from('данные')]), 'a.txt');
      const res = await fetch(`${base}/v1/uploads`, { method: 'POST', headers: auth, body: form });
      const body = await res.text();
      assert.strictEqual(res.status, 500, `ждали 500, получили ${res.status}: ${body}`);
      assert.ok(!body.includes(dir), `ответ не должен содержать путь: ${body}`);
      assert.ok(!/"\/tmp\/|\/home\/|\/srv\//.test(body),
        `ответ не должен содержать системные пути: ${body}`);
      assert.ok(!/ENOTDIR|EACCES|ENOENT/.test(body),
        `сырые коды ошибок Node утекать не должны: ${body}`);
    } finally {
      fs.rmSync(dir, { force: true });
      fs.mkdirSync(dir, { recursive: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Регрессии второго ревью (Claude CLI)
// ---------------------------------------------------------------------------

test('уборка удаляет самое старое, а не произвольное', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'puuush-sweep-'));
  const srv = require('../server/index.js');
  const cfg = {
    dir, writeKey: 'k'.repeat(64), publicBase: 'https://x.test',
    maxBytes: 1024, maxTotalBytes: 10 ** 12, maxFiles: 2, keepDays: 30,
  };

  // Пять файлов возрастом от 1 до 5 дней.
  const ages = {};
  for (const days of [5, 1, 3, 2, 4]) {
    const id = crypto.randomBytes(12).toString('hex');
    const d = path.join(dir, id);
    fs.mkdirSync(d, { recursive: true });
    const f = path.join(d, `f-${id}.txt`);
    fs.writeFileSync(f, 'x');
    const when = new Date(Date.now() - days * 86400e3);
    fs.utimesSync(f, when, when);
    ages[id] = days;
  }

  await srv.sweep(cfg);

  const left = fs.readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory()).map((e) => e.name);

  assert.strictEqual(left.length, 2, `остаться должно 2 файла, осталось ${left.length}`);
  const leftAges = left.map((id) => ages[id]).sort((a, b) => a - b);
  assert.deepStrictEqual(leftAges, [1, 2],
    'остаться должны самые свежие, а не первые попавшиеся');

  fs.rmSync(dir, { recursive: true, force: true });
});

test('уборка не трогает файлы моложе порога возраста', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'puuush-sweep2-'));
  const srv = require('../server/index.js');
  const cfg = {
    dir, writeKey: 'k'.repeat(64), publicBase: 'https://x.test',
    maxBytes: 1024, maxTotalBytes: 10 ** 12, maxFiles: 100, keepDays: 30,
  };
  const id = crypto.randomBytes(12).toString('hex');
  const d = path.join(dir, id);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'f.txt'), 'x');

  const r = await srv.sweep(cfg);
  assert.strictEqual(r.dropped, 0);
  assert.ok(fs.existsSync(d));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('сервер: HEAD /v1/health открыт, как и GET', async () => {
  // Мониторинги и балансировщики ходят именно HEAD. Раньше он уходил в
  // проверку ключа и отвечал 401 на живом сервисе.
  await withServer(async ({ base }) => {
    const get = await fetch(`${base}/v1/health`);
    assert.strictEqual(get.status, 200);

    const head = await fetch(`${base}/v1/health`, { method: 'HEAD' });
    assert.strictEqual(head.status, 200, 'HEAD на живость должен быть открыт');
  });
});

test('сервер: HEAD на закрытом эндпоинте всё ещё требует ключ', async () => {
  await withServer(async ({ base }) => {
    const r = await fetch(`${base}/v1/info`, { method: 'HEAD' });
    assert.strictEqual(r.status, 401);
  });
});

test('параллельные загрузки не мешают друг другу', async () => {
  await withServer(async ({ base }) => {
    const auth = `Bearer ${'b'.repeat(64)}`;
    const posts = [];
    for (let i = 0; i < 10; i++) {
      const form = new FormData();
      form.append('file', new Blob([Buffer.from('файл-' + i)]), `f${i}.txt`);
      posts.push(fetch(`${base}/v1/uploads`, { method: 'POST', headers: { Authorization: auth }, body: form }));
    }
    const results = await Promise.all(posts);
    assert.ok(results.every((r) => r.status === 201), 'все загрузки должны пройти');
    const ids = new Set((await Promise.all(results.map((r) => r.json()))).map((m) => m.id));
    assert.strictEqual(ids.size, 10, 'id не должны повторяться при параллельной загрузке');
  });
});

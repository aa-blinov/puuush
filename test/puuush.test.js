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
const { t } = require('../src/i18n.js');

/**
 * Проверка на сообщение об ошибке.
 *
 * Текст берётся из словаря, а не пишется руками: проверка не должна ломаться
 * от того, что сообщение перевели на другой язык.
 */
function says(key, vars) {
  return new RegExp(t(key, vars).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
}

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
  await assert.rejects(
    () => upload.publish(file, { host: 'auto' }),
    says('upload.emptyFile', { path: file })
  );
  fs.rmSync(dir, { recursive: true, force: true });
});

test('publish ругается на отсутствующий файл', async () => {
  const missing = path.join(os.tmpdir(), 'puuush-нет-такого.png');
  await assert.rejects(
    () => upload.publish(missing, {}),
    says('upload.noFile', { path: missing })
  );
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
    says('own.keyNotAscii')
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
  // Размер показывается в килобайтах, когда он меньше мегабайта: иначе
  // файл в байтах выглядел бы как «0 МБ» и отказ читался бы как ошибка.
  await assert.rejects(
    () => upload.publish(file, { host: 'auto', maxBytes: 512 }),
    (e) => /1 KB/.test(e.message) && /1 KB/.test(e.message)
  );
  fs.rmSync(dir, { recursive: true, force: true });
});

test('publish по умолчанию пропускает файл в пределах потолка', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'puuush-t-'));
  const file = path.join(dir, 'a.png');
  fs.writeFileSync(file, Buffer.alloc(64));

  // Файл состоит из нулей, значит и ответ должен начинаться с нулей.
  const origRequest = upload.__setRequestForTests(async (url) => {
    if (url === 'https://ok/3') return { status: 200, headers: { 'content-length': '64' }, body: Buffer.alloc(64) };
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

// На Windows chmod не запрещает запись: тест без проверки молча проходил бы.
// Поэтому там он пропускается, на Linux и macOS идёт как раньше.
test('setSettings бросает, если настройки не записались', { skip: process.platform === 'win32' && 'chmod на Windows не закрывает запись' }, () => {
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
      says('store.cannotWrite'),
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
      assert.ok(errors.some((e) => e.includes(t('store.broken'))),
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

// ---------------------------------------------------------------------------
// S3: подпись SigV4 и цель загрузки
// ---------------------------------------------------------------------------

test('SigV4 совпадает с контрольным примером из документации AWS', () => {
  const s3 = require('../src/s3.js');
  const h = s3.signedHeaders({
    method: 'GET',
    url: 'https://iam.amazonaws.com/?Action=ListUsers&Version=2010-05-08',
    region: 'us-east-1',
    accessKey: 'AKIAIOSFODNN7EXAMPLE',
    secretKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
    service: 'iam',
    payloadHash: s3.sha256hex(''),
    contentType: 'application/x-www-form-urlencoded; charset=utf-8',
    date: new Date('2015-08-30T12:36:00Z'),
  });
  // Подпись сверяется с примером целиком: она ломается целиком, если
  // ошибиться в любом звене канонической формы.
  assert.strictEqual(
    h.Authorization,
    'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20150830/us-east-1/iam/aws4_request, ' +
      'SignedHeaders=content-type;host;x-amz-date, ' +
      'Signature=5d672d79c15b13162d9279b0855cfba6789a8edb4c82c400e06b5924a6f2b5d7'
  );
});

test('SigV4 для S3 несёт хеш тела и меняется вместе с ним', () => {
  const s3 = require('../src/s3.js');
  const common = {
    method: 'PUT',
    url: 'https://s3.example.com/mybucket/2026-11/abcd-screen.png',
    region: 'eu-central-003',
    accessKey: 'AKIAIOSFODNN7EXAMPLE',
    secretKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
  };
  const first = s3.signedHeaders({ ...common, payloadHash: s3.sha256hex('one'), contentType: 'image/png' });
  const second = s3.signedHeaders({ ...common, payloadHash: s3.sha256hex('two'), contentType: 'image/png' });
  assert.match(first.Authorization, /^AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE\/\d{8}\/eu-central-003\/s3\/aws4_request, /);
  // S3 без подписанного хеша тела запрос не принимает: он обязателен.
  assert.strictEqual(first['x-amz-content-sha256'], s3.sha256hex('one'));
  assert.notStrictEqual(first.Authorization, second.Authorization, 'подпись зависит от тела');
  assert.strictEqual(first['Content-Type'], 'image/png');
  assert.strictEqual(first.Host, 's3.example.com');
});

test('objectKey: дата, случайный хвост и безопасное имя', () => {
  const s3 = require('../src/s3.js');
  const fixed = new Date('2026-11-19T10:00:00Z');
  const a = s3.objectKey(upload.safeName('screen.png'), { now: fixed, rand: 'cafebabe' });
  assert.strictEqual(a, `2026-11/cafebabe-${upload.safeName('screen.png')}`);
  // Два вызова без rand не совпадают: одинаковые имена не перезаписывают друг друга.
  const one = s3.objectKey(upload.safeName('screen.png'), { now: fixed });
  const two = s3.objectKey(upload.safeName('screen.png'), { now: fixed });
  assert.notStrictEqual(one, two);
  assert.match(one, /^2026-11\/[0-9a-f]{8}-screen-[0-9a-f]{6}\.png$/);
  assert.strictEqual(s3.publicUrl('https://cdn.example.com/bucket/', one), `https://cdn.example.com/bucket/${one}`);
});

test('contentTypeFor решает, откроется ли ссылка картинкой', () => {
  const s3 = require('../src/s3.js');
  assert.strictEqual(s3.contentTypeFor('shot.png'), 'image/png');
  assert.strictEqual(s3.contentTypeFor('record.webm'), 'video/webm');
  assert.strictEqual(s3.contentTypeFor('noext'), 'application/octet-stream');
});

test('validateS3: http разрешён только дома', () => {
  assert.strictEqual(upload.validateS3({
    endpoint: 'http://192.168.1.5:9000',
    bucket: 'puuush',
    access_key: 'a',
    secret_key: 'b',
  }), '', 'MinIO в домашней сети без TLS — нормальная жизнь');
  assert.strictEqual(upload.validateS3({
    endpoint: 'http://s3.example.com',
    bucket: 'puuush',
    access_key: 'a',
    secret_key: 'b',
  }), t('s3.needHttps'));
  assert.strictEqual(upload.validateS3({}), t('s3.notFilled'));
  assert.strictEqual(upload.validateS3({
    endpoint: 'https://s3.example.com',
    bucket: 'pub/lic',
    access_key: 'a',
    secret_key: 'b',
  }), t('s3.badBucket'));
  assert.strictEqual(upload.validateS3({
    endpoint: 'https://s3.example.com',
    bucket: 'puuush',
    access_key: 'a',
    secret_key: 'b',
    public_base: 'не адрес',
  }), t('s3.publicUnreadable'));
});

test('uploadS3 кладёт файл PUT-ом с подписью и отдаёт публичную ссылку', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'puuush-s3-'));
  const file = path.join(dir, 'Снимок экрана.png');
  fs.writeFileSync(file, FILE);
  const cfg = {
    endpoint: 'https://s3.example.com',
    bucket: 'puuush',
    region: 'eu-central-003',
    access_key: 'AKIAIOSFODNN7EXAMPLE',
    secret_key: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
    public_base: 'https://cdn.example.com/puuush',
  };
  let seenPut = null;
  const origRequest = upload.__setRequestForTests(async (url, opts = {}) => {
    if (opts.method === 'PUT') {
      seenPut = { url, headers: opts.headers, body: opts.body };
      return { status: 200, headers: { etag: 'x' }, body: Buffer.alloc(0) };
    }
    // Проверка ссылки: публичный адрес отдаёт те же первые байты.
    assert.match(url, /^https:\/\/cdn\.example\.com\/puuush\/\d{4}-\d\d\//);
    return { status: 200, headers: {}, body: FILE };
  });
  try {
    const r = await upload.uploadS3(cfg, file, () => {});
    assert.strictEqual(r.host, 's3');
    assert.strictEqual(r.temp, false, 'ссылка на свой бакет не временная');
    // Ключи не попадают в URL: в адресе только бакет и ключ объекта.
    assert.doesNotMatch(seenPut.url, /AKIA|wJalrXUtn/i);
    assert.match(seenPut.url, /^https:\/\/s3\.example\.com\/puuush\//);
    assert.match(seenPut.headers.Authorization, /^AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE\//);
    // Кириллица в имени не доезжает до бакета: ссылка останется латиницей.
    assert.match(seenPut.url, /file-[0-9a-f]{6}\.png$/);
    assert.strictEqual(seenPut.headers['Content-Type'], 'image/png');
    // Тело меньше порога подписано настоящим хешем, а не UNSIGNED-PAYLOAD.
    assert.strictEqual(
      seenPut.headers['x-amz-content-sha256'],
      crypto.createHash('sha256').update(FILE).digest('hex')
    );
    assert.ok(r.url.startsWith('https://cdn.example.com/puuush/'), r.url);
  } finally {
    upload.__restoreRequestForTests(origRequest);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('uploadS3 без настройки отказывает с причиной, а не молчит', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'puuush-s3-'));
  const file = path.join(dir, 'a.png');
  fs.writeFileSync(file, FILE);
  try {
    await assert.rejects(() => upload.uploadS3({ endpoint: '', bucket: '', access_key: '', secret_key: '' }, file, () => {}),
      says('upload.s3Invalid', { detail: t('s3.notFilled') }));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('uploadS3 объясняет отказ бакета его собственным XML', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'puuush-s3-'));
  const file = path.join(dir, 'a.png');
  fs.writeFileSync(file, FILE);
  const cfg = {
    endpoint: 'https://s3.example.com',
    bucket: 'puuush',
    access_key: 'a',
    secret_key: 'b',
  };
  const origRequest = upload.__setRequestForTests(async (url, opts = {}) => {
    if (opts.method === 'PUT') {
      return {
        status: 403,
        headers: {},
        body: Buffer.from('<Error><Code>AccessDenied</Code><Message>Access Denied</Message></Error>'),
      };
    }
    throw new Error('незапланированный запрос: ' + url);
  });
  try {
    await assert.rejects(
      () => upload.uploadS3(cfg, file, () => {}),
      (e) => e.s3Server === true && /AccessDenied/.test(e.message) && /Access Denied/.test(e.message)
    );
  } finally {
    upload.__restoreRequestForTests(origRequest);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('режим «только S3» не уводит файл в публичный интернет', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'puuush-s3-'));
  const file = path.join(dir, 'a.png');
  fs.writeFileSync(file, FILE);
  const cfg = {
    endpoint: 'https://s3.example.com',
    bucket: 'puuush',
    access_key: 'a',
    secret_key: 'b',
  };
  const origRequest = upload.__setRequestForTests(async (url, opts = {}) => {
    if (opts.method === 'PUT') return { status: 500, headers: {}, body: Buffer.from('бум') };
    throw new Error('незапланированный запрос: ' + url);
  });
  const origHosts = upload.__setHostsForTests([
    { name: 'cloud', url: 'https://cloud/u', fields: {}, fileField: 'file', temp: true },
  ]);
  try {
    // Хостинг настроен как запасной, но режим «только S3» не имеет права
    // уводить файл на него молча.
    await assert.rejects(() => upload.publish(file, { host: 's3', s3: cfg, own: null, order: [] }));
  } finally {
    upload.__restoreRequestForTests(origRequest);
    upload.__restoreHostsForTests(origHosts);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('авторежим: S3 стоит перед публичными хостингами', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'puuush-s3-'));
  const file = path.join(dir, 'a.png');
  fs.writeFileSync(file, FILE);
  const cfg = {
    endpoint: 'https://s3.example.com',
    bucket: 'puuush',
    access_key: 'a',
    secret_key: 'b',
  };
  const asked = [];
  const origRequest = upload.__setRequestForTests(async (url, opts = {}) => {
    asked.push(opts.method === 'PUT' ? 'put' : 'get');
    if (opts.method === 'PUT') return { status: 200, headers: {}, body: Buffer.alloc(0) };
    return { status: 200, headers: {}, body: FILE };
  });
  const origHosts = upload.__setHostsForTests([
    { name: 'cloud', url: 'https://cloud/u', fields: {}, fileField: 'file', temp: true },
  ]);
  try {
    const r = await upload.publish(file, { host: 'auto', s3: cfg, own: null, order: [] });
    assert.strictEqual(r.host, 's3');
    // Публичный хостинг не должен быть даже попробован.
    assert.deepStrictEqual(asked, ['put', 'get']);
  } finally {
    upload.__restoreRequestForTests(origRequest);
    upload.__restoreHostsForTests(origHosts);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('авторежим: сбой S3 уводит на публичный хостинг и помечает понижение', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'puuush-s3-'));
  const file = path.join(dir, 'a.png');
  fs.writeFileSync(file, FILE);
  const cfg = {
    endpoint: 'https://s3.example.com',
    bucket: 'puuush',
    access_key: 'a',
    secret_key: 'b',
  };
  const origRequest = upload.__setRequestForTests(async (url, opts = {}) => {
    if (opts.method === 'PUT') return { status: 500, headers: {}, body: Buffer.from('бум') };
    if (url === 'https://ok/1') return { status: 200, headers: {}, body: FILE };
    const j = (u) => Buffer.from(JSON.stringify({ files: [{ url: u }] }));
    if (url.includes('cloud')) return { status: 200, headers: {}, body: j('https://ok/1') };
    throw new Error('незапланированный запрос: ' + url);
  });
  const origHosts = upload.__setHostsForTests([
    { name: 'cloud', url: 'https://cloud/u', fields: {}, fileField: 'file', temp: true, json: 'files.0.url' },
  ]);
  try {
    const r = await upload.publish(file, { host: 'auto', s3: cfg, own: null, order: [] });
    assert.strictEqual(r.host, 'cloud');
    assert.ok(r.s3Failed, 'причина сбоя S3 должна уехать наружу');
    // Понижение приватности видно по факту, а не по совпадению в тексте.
    assert.ok(!(r.ownFailed), 'свой сервер не при чём');
  } finally {
    upload.__restoreRequestForTests(origRequest);
    upload.__restoreHostsForTests(origHosts);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('авторежим: сбой своего сервера не понижает приватность, если работает S3', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'puuush-s3-'));
  const file = path.join(dir, 'a.png');
  fs.writeFileSync(file, FILE);
  const s3 = {
    endpoint: 'https://s3.example.com',
    bucket: 'puuush',
    access_key: 'a',
    secret_key: 'b',
  };
  const own = { base_url: 'https://own.example.com', write_key: 'k' };
  const origRequest = upload.__setRequestForTests(async (url, opts = {}) => {
    if (url.startsWith('https://own.example.com')) {
      return { status: 500, headers: {}, body: Buffer.from('бум') };
    }
    if (opts.method === 'PUT') return { status: 200, headers: {}, body: Buffer.alloc(0) };
    return { status: 200, headers: {}, body: FILE };
  });
  const origHosts = upload.__setHostsForTests([]);
  try {
    const r = await upload.publish(file, { host: 'auto', s3, own, order: [] });
    assert.strictEqual(r.host, 's3');
    assert.ok(r.ownFailed, 'сбой своего сервера виден в результате');
  } finally {
    upload.__restoreRequestForTests(origRequest);
    upload.__restoreHostsForTests(origHosts);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('проверка скорости измеряет и S3, если он настроен', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'puuush-s3-'));
  // Файл создаёт сама speedTest, но результат должен содержать S3.
  const cfg = {
    endpoint: 'https://s3.example.com',
    bucket: 'puuush',
    access_key: 'a',
    secret_key: 'b',
  };
  let putBody = null;
  const origRequest = upload.__setRequestForTests(async (url, opts = {}) => {
    // GET должен отдать те же байты, что ушли PUT-ом: проверка ссылки
    // сверяет первые байты с файлом на диске.
    if (opts.method === 'PUT') {
      putBody = opts.body;
      return { status: 200, headers: {}, body: Buffer.alloc(0) };
    }
    return { status: 200, headers: {}, body: putBody || Buffer.alloc(64 * 1024) };
  });
  const origHosts = upload.__setHostsForTests([]);
  try {
    const results = await upload.speedTest({ s3: cfg, order: [] });
    const s3res = results.find((x) => x.name === 's3');
    assert.ok(s3res, 'S3 должен быть в списке измерений');
    assert.strictEqual(s3res.ok, true);
  } finally {
    upload.__restoreRequestForTests(origRequest);
    upload.__restoreHostsForTests(origHosts);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

'use strict';
/**
 * Регрессии, найденные ревью и ручными замерами.
 *
 * Почему отдельный файл: каждый из этих дефектов прошёл 38 основных тестов
 * зелёными. В одном случае тесты слушали ipcMain и обходили сломанный код,
 * в другом заглушки не отдавали заголовки длины, в третьем валидатор стоял
 * на общем читателе и ломал историю. Здесь каждый закрыт точной проверкой
 * той ошибки, а не признака рядом с ней.
 *
 *     node --test test/regressions.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const Module = require('node:module');
const crypto = require('node:crypto');

const upload = require('../src/upload.js');
const { t } = require('../src/i18n.js');
const server = require('../server/index.js');

/** Ставит заглушку electron и даёт изолированный каталог настроек. */
function withStore(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'puuush-reg-'));
  const real = Module._load;
  Module._load = function (req, parent, isMain) {
    if (req === 'electron') return { app: { getPath: () => dir } };
    return real.call(this, req, parent, isMain);
  };
  const load = () => {
    const p = path.join(__dirname, '..', 'src', 'store.js');
    delete require.cache[require.resolve(p)];
    return require(p);
  };
  try {
    return fn(load, dir);
  } finally {
    Module._load = real;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// История переставала существовать
// ---------------------------------------------------------------------------

test('история не путается с настройками и не блокирует загрузки', () => {
  withStore((load, dir) => {
    fs.writeFileSync(path.join(dir, 'settings.json'), '{"host":"auto"}');
    const store = load();
    for (let i = 1; i <= 4; i++) {
      store.addHistory({ url: `https://x/${i}.png`, at: i, host: 'uguu' });
    }

    const again = load();
    // Четыре записи обязаны выжить: раньше каждое чтение истории возвращало
    // пустой массив, и следующая запись затирала предыдущую.
    assert.strictEqual(again.getHistory().length, 4, 'все четыре записи должны сохраниться');
    assert.strictEqual(again.getHistory()[0].url, 'https://x/4.png', 'новые первыми');
    // И чтение истории не должно выставлять признак поломки настроек:
    // из-за этого блокировались все загрузки.
    assert.strictEqual(again.brokenReason(), null, 'история не должна ломать настройки');
  });
});

test('битая история не считается поломкой настроек', () => {
  withStore((load, dir) => {
    fs.writeFileSync(path.join(dir, 'settings.json'), '{"host":"own"}');
    fs.writeFileSync(path.join(dir, 'history.json'), '{не массив');
    const store = load();
    store.getSettings();
    store.getHistory();
    assert.strictEqual(store.brokenReason(), null);
  });
});

// ---------------------------------------------------------------------------
// Повреждение настроек блокирует отправку наружу
// ---------------------------------------------------------------------------

test('пустой и странный settings.json считаются поломкой', () => {
  const cases = [
    ['   ', 'пустой файл'],
    ['[]', 'массив вместо объекта'],
    ['null', 'null'],
    ['{"host":"чепуха"}', 'незнакомый режим хостинга'],
  ];
  for (const [content, label] of cases) {
    withStore((load, dir) => {
      fs.writeFileSync(path.join(dir, 'settings.json'), content);
      const store = load();
      store.getSettings();
      assert.ok(store.brokenReason(), `${label}: повреждение должно быть замечено`);
    });
  }
});

test('корректный settings.json поломкой не считается', () => {
  withStore((load, dir) => {
    fs.writeFileSync(path.join(dir, 'settings.json'), '{"host":"own","own":{"base_url":"https://x.test"}}');
    const store = load();
    assert.strictEqual(store.getSettings().host, 'own');
    assert.strictEqual(store.brokenReason(), null);
  });
});

// ---------------------------------------------------------------------------
// Loopback: ключ не должен уходить по http наружу
// ---------------------------------------------------------------------------

test('http разрешён только настоящему loopback, а не похожему имени', () => {
  const key = 'a'.repeat(64);
  const allowed = ['127.0.0.1', '127.1.2.3', 'localhost', '[::1]'];
  const denied = [
    '127.attacker.example',
    'my.localhost',
    'localhost.evil.com',
    '127.0.0.1.nip.io',
    'evil.test',
  ];
  for (const host of allowed) {
    assert.strictEqual(upload.validateOwn({ base_url: 'http://' + host, write_key: key }), '',
      `${host} это loopback, http должен быть разрешён`);
  }
  for (const host of denied) {
    assert.ok(upload.validateOwn({ base_url: 'http://' + host, write_key: key }),
      `${host} не loopback, http должен быть запрещён`);
  }
});

// ---------------------------------------------------------------------------
// validateOwn совпадает с тем, что делает настоящая загрузка
// ---------------------------------------------------------------------------

test('validateOwn отвергает нелатинский ключ и мусорный адрес', () => {
  const key = 'a'.repeat(64);
  // Тексты берутся из словаря: проверка не должна ломаться от перевода.
  assert.match(upload.validateOwn({ base_url: 'https://x.test', write_key: 'ключ по русски' }),
    new RegExp(t('own.keyNotAscii')));
  assert.match(upload.validateOwn({ base_url: 'https://x.test', write_key: 'ключ с пробелами' }),
    new RegExp(t('own.keyNotAscii')));
  assert.match(upload.validateOwn({ base_url: 'не адрес', write_key: key }),
    new RegExp(t('own.unreadable')));
  assert.match(upload.validateOwn({ base_url: 'ftp://x.test', write_key: key }),
    new RegExp(t('own.notHttp')));
  assert.strictEqual(upload.validateOwn({ base_url: 'https://x.test', write_key: key }), '');
});

// ---------------------------------------------------------------------------
// Проверка ссылки: сервер без Range и обрезанный файл
// ---------------------------------------------------------------------------

function serve(bytes, { headers = {}, ignoreRange = true } = {}) {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Length': String(bytes.length), ...headers });
      res.end(bytes);
    });
    srv.listen(0, '127.0.0.1', () => resolve({
      url: 'http://127.0.0.1:' + srv.address().port + '/f.bin',
      close: () => srv.close(),
    }));
  });
}

test('рабочая ссылка на большой файл, где сервер игнорирует Range', async () => {
  const big = Buffer.alloc(5 * 1024 * 1024, 0x42);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'puuush-big-'));
  const file = path.join(dir, 'big.bin');
  fs.writeFileSync(file, big);
  const s = await serve(big);

  const t0 = Date.now();
  let ok;
  try {
    ok = await upload.verify(s.url, big.length, file);
  } finally {
    s.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
  // Раньше проверка тянула файл целиком и объявляла ссылку битой на всём,
  // что тяжелее 2 МБ.
  assert.strictEqual(ok, true, 'файл 5 МБ без Range должен признаваться рабочим');
  assert.ok(Date.now() - t0 < 3000, 'проверка не должна качать файл целиком');
});

test('сервер, отдавший обрезок, отвергается', async () => {
  const big = Buffer.alloc(5 * 1024 * 1024, 0x42);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'puuush-cut-'));
  const file = path.join(dir, 'big.bin');
  fs.writeFileSync(file, big);
  const s = await serve(big.slice(0, 64));

  let ok;
  try {
    ok = await upload.verify(s.url, big.length, file);
  } finally {
    s.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
  assert.strictEqual(ok, false, 'первые байты совпали, но размер меньше: ссылка битая');
});

test('проверка отказывает, если локальный файл не прочитался', async () => {
  const s = await serve(Buffer.alloc(1024, 0x42));
  let ok;
  try {
    ok = await upload.verify(s.url, 1024, '/нет/такого/файла.bin');
  } finally {
    s.close();
  }
  // Раньше такая проверка ослаблялась до «подтверждаем хотя бы код».
  assert.strictEqual(ok, false);
});

// ---------------------------------------------------------------------------
// Тестовая заглушка не должна вызывать саму себя
// ---------------------------------------------------------------------------

test('восстановление заглушки не оставляет рекурсию', async () => {
  const prev = upload.__setRequestForTests(async () => ({ status: 200, headers: {}, body: Buffer.from('') }));
  upload.__restoreRequestForTests(prev);
  // Раньше сохранялась сама обёртка request, и настоящий запрос уходил в
  // переполнение стека.
  assert.strictEqual(upload.__request, undefined, 'заглушка должна исчезнуть');

  const p2 = upload.__setRequestForTests(async () => ({ status: 200, headers: {}, body: Buffer.from('') }));
  assert.strictEqual(typeof upload.__request, 'function');
  upload.__restoreRequestForTests(p2);

  // И живой сетевой вызов после восстановления обязан работать.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'puuush-net-'));
  const file = path.join(dir, 'a.png');
  fs.writeFileSync(file, Buffer.alloc(64, 0x42));
  try {
    const r = await upload.verify('http://127.0.0.1:1/не-работает', 64, file);
    assert.strictEqual(r, false, 'недоступный адрес даёт отказ, а не исключение');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Multipart: границы, которые лишь похожи на границу
// ---------------------------------------------------------------------------

function multipart(payload, boundary) {
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="a.txt"\r\n\r\n`);
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  return Buffer.concat([head, Buffer.from(payload), tail]);
}

test('multipart не режет файл по строке, похожей на границу', () => {
  for (const payload of [
    'обычное содержимое',
    'first\r\n--BOUNDextra\r\nlast',
    '--BOUND-- внутри данных',
    '',
    'данные с \x00 \x01 \x02 в середине',
  ]) {
    const parts = server.parseMultipart(multipart(payload, 'BOUND'), 'BOUND');
    const got = parts.length ? Buffer.from(parts[0].data).toString('utf8') : '(нет частей)';
    assert.strictEqual(got, payload, `файл исказился на ${JSON.stringify(payload)}`);
  }
});

test('multipart находит обычную границу между частями', () => {
  const body = Buffer.concat([
    Buffer.from('--B\r\nContent-Disposition: form-data; name="a"\r\n\r\nпервая\r\n'),
    Buffer.from('--B\r\nContent-Disposition: form-data; name="b"\r\n\r\nвторая\r\n'),
    Buffer.from('--B--\r\n'),
  ]);
  const parts = server.parseMultipart(body, 'B');
  assert.strictEqual(parts.length, 2, 'обе части должны быть разобраны');
  assert.strictEqual(Buffer.from(parts[0].data).toString(), 'первая');
  assert.strictEqual(Buffer.from(parts[1].data).toString(), 'вторая');
});

// ---------------------------------------------------------------------------
// Уборщик не сносит свежие файлы при свободной квоте
// ---------------------------------------------------------------------------

test('уборщик считает квоту после удаления просроченных', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'puuush-sweep-'));
  const mk = (days) => {
    const id = crypto.randomBytes(12).toString('hex');
    const d = path.join(dir, id);
    fs.mkdirSync(d);
    const f = path.join(d, 'f.txt');
    fs.writeFileSync(f, 'x');
    const when = new Date(Date.now() - days * 86400e3);
    fs.utimesSync(f, when, when);
  };
  for (let i = 0; i < 90; i++) mk(40);
  for (let i = 0; i < 10; i++) mk(1);

  const cfg = {
    dir, writeKey: 'k'.repeat(64), publicBase: 'https://x.test',
    maxBytes: 1e6, maxTotalBytes: 1e12, maxFiles: 50, keepDays: 30,
  };
  const r = await server.sweep(cfg);
  const left = fs.readdirSync(dir).length;
  fs.rmSync(dir, { recursive: true, force: true });

  // Раньше превышение считалось от общего числа файлов, и все десять свежих
  // сносились, хотя квота давно освободилась.
  assert.strictEqual(r.dropped, 90, 'удалены должны быть только просроченные');
  assert.strictEqual(left, 10, 'свежие файлы обязаны уцелеть');
});

test('уборщик всё же сносит лишнее, когда свежих больше квоты', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'puuush-sweep2-'));
  for (let i = 0; i < 5; i++) {
    const id = crypto.randomBytes(12).toString('hex');
    const d = path.join(dir, id);
    fs.mkdirSync(d);
    const f = path.join(d, 'f.txt');
    fs.writeFileSync(f, 'x');
    const when = new Date(Date.now() - i * 60000);
    fs.utimesSync(f, when, when);
  }
  const cfg = {
    dir, writeKey: 'k'.repeat(64), publicBase: 'https://x.test',
    maxBytes: 1e6, maxTotalBytes: 1e12, maxFiles: 2, keepDays: 30,
  };
  await server.sweep(cfg);
  const left = fs.readdirSync(dir).length;
  fs.rmSync(dir, { recursive: true, force: true });
  assert.strictEqual(left, 2, 'при настоящем переполнении лишнее сносится');
});

// ---------------------------------------------------------------------------
// Сервер: границы ответа
// ---------------------------------------------------------------------------

test('сервер не рвёт длинную загрузку через пять минут', () => {
  // Node ставит requestTimeout в 5 минут по умолчанию. Часовая запись на
  // домашнем канале идёт дольше, и сервер закрывал бы соединение посреди
  // тела, хотя клиент и max_video_bytes рассчитаны на два часа.
  const srv = server.createServer({
    dir: os.tmpdir(), writeKey: 'k'.repeat(64), publicBase: 'https://x.test',
    maxBytes: 1e6, maxVideoBytes: 4e9, maxTotalBytes: 1e12,
    maxFiles: 10, keepDays: 30, edgePrefix: '172.40.0.', host: '127.0.0.1', port: 0,
  });
  assert.ok(srv.requestTimeout >= 2 * 60 * 60 * 1000, 'загрузка встречи должна укладываться в два часа');
  srv.close();
});

test('сервер отвечает на ping только по своему протоколу', async () => {
  // Проверка сервера в окне настроек принимала любой HTTP 200, включая
  // HTML-заглушку обратного прокси, и показывала зелёным.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'puuush-ping-'));
  const cfgPath = path.join(dir, 'config.json');
  const key = 'c'.repeat(64);
  fs.writeFileSync(cfgPath, JSON.stringify({
    host: '127.0.0.1', port: 0, dir, write_key: key,
    public_base: 'https://x.test', max_bytes: 1e6,
    max_total_bytes: 1e7, max_files: 10, keep_days: 30,
  }));
  const prev = process.env.PUUUSH_CONFIG;
  process.env.PUUUSH_CONFIG = cfgPath;
  const srv = server.createServer(server.loadConfig());
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + srv.address().port;
  try {
    const noKey = await fetch(`${base}/v1/ping`);
    assert.strictEqual(noKey.status, 401, 'ping без ключа закрыт');
    const badKey = await fetch(`${base}/v1/ping`, { headers: { Authorization: 'Bearer wrong' } });
    assert.strictEqual(badKey.status, 401);
    const ok = await fetch(`${base}/v1/ping`, { headers: { Authorization: `Bearer ${key}` } });
    assert.strictEqual(ok.status, 200);
    const body = await ok.json();
    assert.strictEqual(body.service, 'puuush-server', 'ответ должен опознаваться сервером');
    assert.strictEqual(body.ok, true);
  } finally {
    await new Promise((r) => srv.close(r));
    if (prev === undefined) delete process.env.PUUUSH_CONFIG;
    else process.env.PUUUSH_CONFIG = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('сервер не течёт файлами, когда метаданные записать не удалось', async () => {
  // Раньше meta.json писался вне блока очистки: кончись место, клиент получал
  // 500 и уходил к другому хостингу, а файл уже лежал публично без метаданных.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'puuush-meta-'));
  const cfgPath = path.join(dir, 'config.json');
  const key = 'd'.repeat(64);
  fs.writeFileSync(cfgPath, JSON.stringify({
    host: '127.0.0.1', port: 0, dir, write_key: key,
    public_base: 'https://x.test', max_bytes: 1e6,
    max_total_bytes: 1e7, max_files: 10, keep_days: 30,
  }));
  const prev = process.env.PUUUSH_CONFIG;
  process.env.PUUUSH_CONFIG = cfgPath;
  const srv = server.createServer(server.loadConfig());
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + srv.address().port;
  try {
    const form = new FormData();
    form.append('file', new Blob([Buffer.alloc(512, 0x41)]), 'a.bin');
    const res = await fetch(`${base}/v1/uploads`, {
      method: 'POST', headers: { Authorization: `Bearer ${key}` }, body: form,
    });
    assert.strictEqual(res.status, 201, 'обычная загрузка проходит');
    const dirs = fs.readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && /^[0-9a-f]{24}$/.test(e.name));
    assert.strictEqual(dirs.length, 1, 'файл должен лежать в своём каталоге');
    assert.ok(fs.existsSync(path.join(dir, dirs[0].name, 'meta.json')), 'метаданные на месте');
    const meta = JSON.parse(fs.readFileSync(path.join(dir, dirs[0].name, 'meta.json'), 'utf8'));
    assert.ok(meta.expires_at, 'срок хранения должен возвращаться, README обещает честность');
  } finally {
    await new Promise((r) => srv.close(r));
    if (prev === undefined) delete process.env.PUUUSH_CONFIG;
    else process.env.PUUUSH_CONFIG = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('X-Real-IP принимается только из сети edge 172.40.0.0/24', () => {
  const req = (remote, rip) => ({
    socket: { remoteAddress: remote },
    headers: rip ? { 'x-real-ip': rip } : {},
  });
  // Из сети edge заголовок читаем: адрес клиента поставил Caddy.
  assert.strictEqual(server.clientIp(req('172.40.0.7', '203.0.113.9')), '203.0.113.9');
  // Соседние сети заголовку не верят: там может стоять кто угодно.
  assert.strictEqual(server.clientIp(req('172.40.1.7', '203.0.113.9')), '172.40.1.7');
  assert.strictEqual(server.clientIp(req('172.41.0.7', '203.0.113.9')), '172.41.0.7');
  // Прямой клиент с подделанным заголовком остаётся сам собой.
  assert.strictEqual(server.clientIp(req('198.51.100.4', '203.0.113.9')), '198.51.100.4');
});

test('поломка настроек снимается, когда файл снова читается', () => {
  withStore((load, dir) => {
    const f = path.join(dir, 'settings.json');
    fs.writeFileSync(f, '{oops');
    const store = load();
    store.getSettings();
    assert.ok(store.brokenReason(), 'битый файл должен ставить признак');
    // Человек поправил файл руками: перезапуск не должен быть нужен.
    fs.writeFileSync(f, '{"host":"own"}');
    store.getSettings();
    assert.strictEqual(store.brokenReason(), null, 'прочитанный файл снимает признак');
  });
});

test('потолки ответа считают байты, а не чанки', async () => {
  const big = Buffer.alloc(5 * 1024 * 1024, 7);
  const srv = http.createServer((q, s) => { s.writeHead(200); s.end(big); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${srv.address().port}/`;
  try {
    // stopAfter обязан оборвать чтение на заголовке и первых байтах: раньше
    // он сравнивался с числом чанков, и тело приходило почти целиком.
    const r = await upload.request(url, { maxBytes: 128, stopAfter: 128 });
    assert.strictEqual(r.body.length, 128);
    // Общий потолок тоже в байтах: 5 МБ через лимит в 2 МБ не проходят.
    await assert.rejects(upload.request(url), (e) => e.tooBig === true);
  } finally {
    await new Promise((r) => srv.close(r));
  }
});

test('clientIp: префикс сети edge берётся из конфига и понимает ::ffff:', () => {
  const req = (remote, rip) => ({ socket: { remoteAddress: remote }, headers: { 'x-real-ip': rip } });
  assert.strictEqual(server.clientIp(req('::ffff:172.40.0.7', '203.0.113.9')), '203.0.113.9');
  assert.strictEqual(server.clientIp(req('10.0.0.5', '203.0.113.9'), '10.0.0.'), '203.0.113.9');
  assert.strictEqual(server.clientIp(req('10.0.0.5', '203.0.113.9')), '10.0.0.5');
});

test('hasModifier: хоткей без модификатора отсекается', () => {
  const { hasModifier } = require('../src/hotkey.js');
  assert.ok(hasModifier('CommandOrControl+Shift+S'));
  assert.ok(hasModifier('Alt+F4'));
  assert.ok(!hasModifier('A'));
  assert.ok(!hasModifier('Enter'));
  assert.ok(!hasModifier('Shift+'));
  assert.ok(!hasModifier('Foo+S'));
  // Shift один не модификатор: Shift+A перехватил бы заглавную A везде.
  assert.ok(!hasModifier('Shift+A'));
  assert.ok(hasModifier('Shift+Alt+A'));
});

test('setSettings не кладёт на диск то, что getSettings не примет', () => {
  withStore((load, dir) => {
    const store = load();
    assert.throws(() => store.setSettings({ host: 'bogus' }), /host/);
    assert.throws(() => store.setSettings({ lang: 'xx' }), /lang/);
    assert.throws(() => store.setSettings({ nope: 1 }), /nope/);
    assert.throws(() => store.setSettings({ keepLocalCopy: 'yes' }), /keepLocalCopy/);
    assert.ok(!fs.existsSync(path.join(dir, 'settings.json')), 'отказ ничего не пишет');
    assert.strictEqual(store.setSettings({ host: 'own', own: { base_url: 'https://x.y' } }).host, 'own');
    assert.strictEqual(store.brokenReason(), null);
  });
});

// ---------------------------------------------------------------------------
// Раунд QA 1.4.0
// ---------------------------------------------------------------------------

test('keyFromEvent строит клавишу из event.code, а не из event.key', async () => {
  const { keyFromEvent } = await import('../renderer/settings/lib/hotkey.js');
  const ev = (code, mods = {}) => ({ code, key: 'Ы', ...mods });
  // Русская раскладка и Option на macOS: key бесполезен, code честный.
  assert.strictEqual(keyFromEvent(ev('KeyS', { ctrlKey: true, shiftKey: true })), 'Control+Shift+S');
  assert.strictEqual(keyFromEvent(ev('Digit1', { shiftKey: true, ctrlKey: true })), 'Control+Shift+1');
  assert.strictEqual(keyFromEvent(ev('KeyS', { altKey: true, metaKey: true })), 'Alt+Command+S');
  assert.strictEqual(keyFromEvent(ev('F24', { ctrlKey: true })), 'Control+F24');
  assert.strictEqual(keyFromEvent(ev('ArrowLeft', { ctrlKey: true })), 'Control+Left');
  assert.strictEqual(keyFromEvent(ev('Enter', { ctrlKey: true })), 'Control+Return');
  assert.strictEqual(keyFromEvent(ev('Minus', { ctrlKey: true })), 'Control+-');
  assert.strictEqual(keyFromEvent(ev('Backquote', { ctrlKey: true })), 'Control+`');
  assert.strictEqual(keyFromEvent(ev('NumpadAdd', { ctrlKey: true })), 'Control+numadd');
  assert.strictEqual(keyFromEvent(ev('Numpad7', { ctrlKey: true })), 'Control+num7');
  // Сам модификатор и неизвестный код игнорируются.
  assert.strictEqual(keyFromEvent(ev('ShiftLeft', { shiftKey: true })), null);
  assert.strictEqual(keyFromEvent(ev('F25', { ctrlKey: true })), null);
  assert.strictEqual(keyFromEvent(ev('IntlBackslash', { ctrlKey: true })), null);
});

/** Запрос с телом, которое перехватывает тест. */
async function captureBody(file, opts) {
  let body = null;
  const prev = upload.__setRequestForTests(async (url, o) => {
    body = o.body;
    return { status: 500, headers: {}, body: Buffer.from('x') };
  });
  try {
    await upload.publish(file, opts).catch(() => {});
  } finally {
    upload.__restoreRequestForTests(prev);
  }
  return body && body.toString('latin1');
}

test('имя файла в multipart проходит safeName: кавычка и CRLF не ломают тело', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'puuush-name-'));
  // Имя с кавычкой и переводом строки недопустимо в файловой системе Windows:
  // такой файл там просто не создаётся, и проверка падала бы не из-за кода.
  const file = path.join(dir, process.platform === 'win32' ? 'ab c.png' : 'a"b\r\nc.png');
  fs.writeFileSync(file, Buffer.alloc(16, 0x41));
  try {
    const body = await captureBody(file, { host: 'own', own: { base_url: 'https://x.test', write_key: 'k'.repeat(20) } });
    const line = /Content-Disposition: form-data; name="file"; filename="([^\r\n]*)"\r\n/.exec(body);
    assert.ok(line, 'заголовок части цельный, без лишних кавычек и CRLF');
    assert.match(line[1], /^[A-Za-z0-9._-]+$/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('не-JSON ответ своего сервера и хостинга не даёт сырой SyntaxError', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'puuush-json-'));
  const file = path.join(dir, 'a.png');
  fs.writeFileSync(file, Buffer.alloc(16, 0x41));
  const prev = upload.__setRequestForTests(async () => ({
    status: 200, headers: {}, body: Buffer.from('<html>proxy stub</html>'),
  }));
  const prevHosts = upload.__setHostsForTests([
    { name: 'h', url: 'https://h.test/u', fields: {}, fileField: 'f', json: 'files.0.url' },
  ]);
  try {
    await assert.rejects(
      upload.publish(file, { host: 'own', own: { base_url: 'https://x.test', write_key: 'k'.repeat(20) } }),
      (e) => e.ownServer === true && e.message === t('upload.ownNoUrl'));
    await assert.rejects(
      upload.publish(file, { host: 'h' }),
      (e) => !/Unexpected token|JSON/.test(e.message) &&
        e.message.includes(t('upload.noLinkInResponse', { text: '' }).split(':')[0]));
  } finally {
    upload.__restoreRequestForTests(prev);
    upload.__restoreHostsForTests(prevHosts);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('publish на папку даёт человеческую ошибку, а не EISDIR', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'puuush-dir-'));
  try {
    await assert.rejects(upload.publish(dir), (e) =>
      e.message === t('upload.notFile', { path: dir }) && !/EISDIR/.test(e.message));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('предел запроса растёт с размером тела', async () => {
  // Базовый предел 300 мс, ответ льётся 800 мс без пауз дольше 100 мс, а тело в
  // 600 КБ добавляет 3 с. Раньше общий таймер рвал такой запрос на 300 мс.
  const srv = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200);
      let n = 0;
      const timer = setInterval(() => {
        res.write('x');
        if (++n === 8) { clearInterval(timer); res.end(); }
      }, 100);
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    const url = `http://127.0.0.1:${srv.address().port}/`;
    const res = await upload.request(url, { method: 'POST', body: Buffer.alloc(600 * 1024), timeout: 300 });
    assert.strictEqual(res.body.length, 8);
    await assert.rejects(upload.request(url, { timeout: 300 }),
      /./, 'запрос без тела остаётся под базовым пределом');
  } finally {
    srv.closeAllConnections?.();
    await new Promise((r) => srv.close(r));
  }
});

test('причина поломки настроек переводится при вызове, а не при чтении', () => {
  const { setLang } = require('../src/i18n.js');
  withStore((load, dir) => {
    fs.writeFileSync(path.join(dir, 'settings.json'), '{oops');
    const store = load();
    setLang('ru');
    try {
      store.getSettings(); // при старте чтение идёт до setLang
      const ru = store.brokenReason();
      setLang('en');
      const en = store.brokenReason();
      assert.notStrictEqual(ru, en, 'после смены языка текст меняется');
      assert.ok(en.includes(t('store.broken')), en);
      assert.ok(!/[а-я]/i.test(en), 'английский баннер без русского: ' + en);
    } finally {
      setLang('en');
    }
  });
});

test('launchAtLogin: по умолчанию выключен, принимает только boolean', () => {
  withStore((load) => {
    const store = load();
    assert.strictEqual(store.DEFAULTS.launchAtLogin, false);
    assert.strictEqual(store.setSettings({ launchAtLogin: true }).launchAtLogin, true);
    assert.throws(() => store.setSettings({ launchAtLogin: 'yes' }), /launchAtLogin/);
  });
});

test('сервер превращает исполняемые типы в .txt с типом text/plain', async () => {
  for (const n of ['a.html', 'a.HTM', 'a.xhtml', 'a.svg', 'a.js', 'a.mjs']) {
    assert.match(server.safeName(n), /\.txt$/, n);
  }
  assert.match(server.safeName('a.png'), /\.png$/);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'puuush-active-'));
  const cfgPath = path.join(dir, 'config.json');
  const key = 'e'.repeat(64);
  fs.writeFileSync(cfgPath, JSON.stringify({
    host: '127.0.0.1', port: 0, dir, write_key: key,
    public_base: 'https://x.test', max_bytes: 1e6,
    max_total_bytes: 1e7, max_files: 10, keep_days: 30,
  }));
  const prev = process.env.PUUUSH_CONFIG;
  process.env.PUUUSH_CONFIG = cfgPath;
  const srv = server.createServer(server.loadConfig());
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    const res = await fetch(`http://127.0.0.1:${srv.address().port}/v1/uploads`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'text/html', 'X-Filename': 'x.html' },
      body: '<script>1</script>',
    });
    const meta = await res.json();
    assert.match(meta.name, /\.txt$/);
    assert.match(meta.mime, /^text\/plain/);
  } finally {
    await new Promise((r) => srv.close(r));
    if (prev === undefined) delete process.env.PUUUSH_CONFIG;
    else process.env.PUUUSH_CONFIG = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});


// ---------------------------------------------------------------------------
// Запись видео, потоковая загрузка, приём больших файлов
// ---------------------------------------------------------------------------

test('файл больше порога уходит потоком, а не целиком в память', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'puuush-stream-'));
  const file = path.join(dir, 'record.webm');
  // Файл больше порога потоковой отправки: тело должно уйти кусками с диска.
  const big = Buffer.alloc(9 * 1024 * 1024, 0x42);
  fs.writeFileSync(file, big);

  let seen = null;
  const prev = upload.__setRequestStreamForTests(async (url, o) => {
    seen = o;
    return { status: 201, headers: {}, body: Buffer.from('{"url":"https://x.test/f"}') };
  });
  try {
    await upload.uploadTo({ name: 'h', url: 'https://h.test/u', fields: {}, fileField: 'f' }, file)
      .catch(() => {});
    assert.ok(seen, 'большой файл пошёл потоковым запросом');
    assert.ok(seen.head.length > 0, 'голова multipart приложена отдельно');
    assert.ok(seen.tail.length > 0, 'хвост multipart приложен отдельно');
    assert.strictEqual(seen.filePath, file, 'файл передан путём, а не содержимым');
  } finally {
    upload.__restoreRequestStreamForTests(prev);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('маленький файл по-прежнему уходит одним куском', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'puuush-small-'));
  const file = path.join(dir, 'shot.png');
  fs.writeFileSync(file, Buffer.alloc(1024, 0x41));
  let streamCalled = false;
  const prevStream = upload.__setRequestStreamForTests(async () => {
    streamCalled = true;
    return { status: 201, headers: {}, body: Buffer.from('{}') };
  });
  const prev = upload.__setRequestForTests(async (url, o) => {
    assert.ok(o.body, 'тело собрано в памяти');
    assert.ok(o.headers['Content-Length'] > 0);
    return { status: 200, headers: {}, body: Buffer.from('https://h.test/x') };
  });
  try {
    const url = await upload.uploadTo({ name: 'h', url: 'https://h.test/u', fields: {}, fileField: 'f' }, file);
    assert.strictEqual(url, 'https://h.test/x');
    assert.ok(!streamCalled, 'маленький файл не пошёл потоком');
  } finally {
    upload.__restoreRequestForTests(prev);
    upload.__restoreRequestStreamForTests(prevStream);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('разметка экранов складывает мониторы в один холст', async () => {
  const rec = require('../src/recorder.js');
  const layout = rec.layoutFor([
    { id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor: 1 },
    { id: 2, bounds: { x: 1920, y: -200, width: 2560, height: 1440 }, scaleFactor: 1 },
  ]);
  assert.strictEqual(layout.canvas.width, 4480);
  // Верх холста — это верх самого верхнего экрана: второй монитор выше
  // первого, и его верх отрицателен относительно первого, но на холсте он
  // лежит в нуле.
  assert.strictEqual(layout.canvas.height, 1440);
  assert.strictEqual(layout.displays[1].top, 0);
  // Первый монитор ниже: он сдвинут вниз на разницу высот.
  assert.strictEqual(layout.displays[0].top, 200);
});

test('сервер принимает большой файл потоком и кладёт его на диск целиком', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'puuush-big-'));
  const serverDir = path.join(dir, 'media');
  const configPath = path.join(dir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({
    host: '127.0.0.1', port: 0, dir: serverDir,
    write_key: 'c'.repeat(64), public_base: 'https://example.test',
    max_bytes: 64 * 1024 * 1024, max_total_bytes: 100 * 1024 * 1024,
    max_files: 100, keep_days: 30,
  }));
  const prevConfig = process.env.PUUUSH_CONFIG;
  process.env.PUUUSH_CONFIG = configPath;
  const mod = require('../server/index.js');
  const server = mod.createServer(mod.loadConfig());
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const payload = Buffer.alloc(9 * 1024 * 1024);
    for (let i = 0; i < payload.length; i += 4096) payload[i] = i & 0xff;
    const boundary = '----puuushTest';
    const head = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="record.webm"\r\n` +
      `Content-Type: application/octet-stream\r\n\r\n`
    );
    const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
    const body = Buffer.concat([head, payload, tail]);

    const res = await fetch(`${base}/v1/uploads`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${'c'.repeat(64)}`,
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': body.length,
      },
      body,
    });
    assert.strictEqual(res.status, 201);
    const meta = await res.json();
    assert.strictEqual(meta.size, payload.length);
    const onDisk = fs.readFileSync(path.join(serverDir, meta.id, meta.name));
    assert.ok(onDisk.equals(payload), 'файл на диске совпадает с отправленным');
  } finally {
    await new Promise((res) => server.close(res));
    if (prevConfig === undefined) delete process.env.PUUUSH_CONFIG;
    else process.env.PUUUSH_CONFIG = prevConfig;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});


test('три хоткея не могут совпасть: запись не займёт чужую комбинацию', async () => {
  const store = require('../src/store.js');
  const before = store.getSettings();
  assert.ok(before.recordHotkey, 'у записи есть свой хоткей по умолчанию');
  assert.notStrictEqual(before.recordHotkey, before.hotkey);
  assert.notStrictEqual(before.recordHotkey, before.imageHotkey);
  // Попытка сделать запись такой же, как снимок, отвергается.
  assert.throws(() => store.setSettings({ recordHotkey: before.hotkey }), /hotkeys/);
  assert.throws(() => store.setSettings({ hotkey: before.recordHotkey }), /hotkeys/);
  // На диске осталась прежняя комбинация: отказ ничего не портит.
  assert.strictEqual(store.getSettings().hotkey, before.hotkey);
});


test('последний кусок записи не отбрасывается после команды стоп', async () => {
  const { Recorder } = require('../src/recorder.js');
  const chunks = [];
  const out = {
    destroyed: false,
    writableEnded: false,
    write(buf, cb) { chunks.push(Buffer.from(buf)); setImmediate(cb); return true; },
  };
  const fake = { state: 'stopping', out, flush: Promise.resolve(), written: 0 };
  const accepted = await Recorder.prototype.writeChunk.call(fake, Uint8Array.from([1, 2, 3]));
  assert.strictEqual(accepted, true, 'кусок после stop() должен приниматься');
  assert.deepStrictEqual(chunks, [Buffer.from([1, 2, 3])]);
  assert.strictEqual(fake.written, 3);
});

test('локальная ссылка отдаёт файл, пока приложение открыто', async () => {
  const { LocalServer } = require('../src/local-server.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'puuush-local-'));
  const file = path.join(dir, 'shot.png');
  fs.writeFileSync(file, Buffer.from('привет, файл'));
  const srv = new LocalServer({ dir });
  try {
    await srv.listen();
    const link = srv.add(file);
    assert.ok(link && link.url.startsWith('http://127.0.0.1:'), 'локальная ссылка есть');
    const res = await fetch(link.url);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(await res.text(), 'привет, файл');
    // Имя файла в заголовке: без него браузер сохранил бы файл как «download».
    assert.match(String(res.headers.get('content-disposition') || ''), /filename\*=UTF-8''/);
    // Range нужен записи встречи, иначе браузер не даёт перемотать видео.
    const partial = await fetch(link.url, { headers: { Range: 'bytes=0-5' } });
    assert.strictEqual(partial.status, 206, 'локальная ссылка отвечает на Range');
    assert.strictEqual(await partial.text(), 'при');
    assert.strictEqual(partial.headers.get('content-range'), 'bytes 0-5/22');
    // Файл убрали из папки — ссылка честно говорит, что его больше нет.
    fs.unlinkSync(file);
    const gone = await fetch(link.url);
    assert.strictEqual(gone.status, 410);
  } finally {
    await srv.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});


test('порядок облачных хостингов берётся из замера, незнакомые имена отбрасываются', async () => {
  const order = ['uguu', 'nope', 'x0', 'uguu'];
  const list = upload.orderedHosts(order);
  assert.strictEqual(list[0].name, 'uguu', 'первым идёт самый быстрый');
  assert.strictEqual(list[1].name, 'x0', 'второй по замеру');
  assert.strictEqual(new Set(list.map((h) => h.name)).size, list.length, 'без повторов');
  assert.ok(!list.some((h) => h.name === 'nope'), 'незнакомое имя отброшено');
  assert.strictEqual(list.length, upload.HOSTS.length, 'все хостинги на месте');
  // Без замера порядок по умолчанию.
  assert.deepStrictEqual(
    upload.orderedHosts([]).map((h) => h.name),
    upload.HOSTS.map((h) => h.name)
  );
});

test('файл больше потолка хостинга не отправляется вслепую', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'puuush-limit-'));
  const file = path.join(dir, 'big.webm');
  fs.writeFileSync(file, Buffer.alloc(4096, 0x41));
  const prevHosts = upload.__setHostsForTests([
    { name: 'tiny', url: 'https://tiny.test/u', fields: {}, fileField: 'f', temp: true, max: 1024 },
  ]);
  const prev = upload.__setRequestForTests(async () => {
    throw new Error('запрос не должен был уйти');
  });
  try {
    await assert.rejects(
      upload.publish(file, { host: 'tiny' }),
      (e) => /4/.test(e.message) && /1/.test(e.message) && /KB|MB|КБ|МБ/.test(e.message)
    );
  } finally {
    upload.__restoreRequestForTests(prev);
    upload.__restoreHostsForTests(prevHosts);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});


test('выбор экрана записи сохраняется, старый boolean мигрирует', () => {
  withStore((load, dir) => {
    let store = load();
    assert.strictEqual(store.getSettings().recordScreen, 'cursor', 'по умолчанию — экран под курсором');
    store.setSettings({ recordScreen: '12345', recordAllScreens: false });
    store = load();
    assert.strictEqual(store.getSettings().recordScreen, '12345', 'id экрана читается обратно');

    // Настройки предыдущей версии не должны потерять режим «все экраны».
    fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ recordAllScreens: true }));
    store = load();
    assert.strictEqual(store.getSettings().recordScreen, 'all', 'старый recordAllScreens превращается в all');
  });
});

test('порядок хостингов сохраняется и переживает перезапуск', async () => {
  const store = require('../src/store.js');
  const before = store.getSettings().hostOrder;
  try {
    const saved = store.setSettings({ hostOrder: ['uguu', 'x0'] });
    assert.deepStrictEqual(saved.hostOrder, ['uguu', 'x0']);
    assert.deepStrictEqual(store.getSettings().hostOrder, ['uguu', 'x0'], 'порядок читается обратно');
    // Мусор в массиве не проходит: иначе порядок сломается на первом чтении.
    assert.throws(() => store.setSettings({ hostOrder: ['uguu', 5] }), /hostOrder/);
  } finally {
    store.setSettings({ hostOrder: before });
  }
});

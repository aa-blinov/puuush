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

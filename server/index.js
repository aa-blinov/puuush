'use strict';
/**
 * puuush server — приём файлов от клиента puuush и раздача их по ссылке.
 *
 * Раздачу делает Caddy (file_server), этот процесс только принимает загрузки и
 * ведёт учёт. Разделение не случайное: Caddy на этой машине отдаёт файлы
 * всем остальным проектам, и лишний Node в горячем пути только бы замедлял.
 *
 * Без зависимостей: только node:http. На хосте уже есть Node 22, ставить
 * ничего не нужно, обновляется копированием файла и restart systemd-юнита.
 *
 * Ключ передаётся заголовком Authorization, а не в URL. Иначе он попал бы в
 * access-лог Caddy открытым текстом на каждой загрузке.
 */

const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { URL } = require('node:url');

// ---------------------------------------------------------------------------
// Конфигурация
// ---------------------------------------------------------------------------

function loadConfig() {
  const path_ = process.env.PUUUSH_CONFIG ||
    '/srv/puuush-server/config.json';
  const raw = JSON.parse(fs.readFileSync(path_, 'utf8'));
  const cfg = {
    host: raw.host || '127.0.0.1',
    port: Number(raw.port || 8099),
    dir: raw.dir || '/srv/media',
    writeKey: String(raw.write_key || ''),
    publicBase: String(raw.public_base || '').replace(/\/+$/, ''),
    maxBytes: Number(raw.max_bytes || 64 * 1024 * 1024),
    maxTotalBytes: Number(raw.max_total_bytes || 2 * 1024 * 1024 * 1024),
    keepDays: Number(raw.keep_days || 30),
    maxFiles: Number(raw.max_files || 5000),
    edgePrefix: String(raw.edge_prefix || EDGE_PREFIX),
  };
  if (!cfg.writeKey) throw new Error('в конфиге нет write_key');
  if (!cfg.publicBase) throw new Error('в конфиге нет public_base');
  return cfg;
}

// ---------------------------------------------------------------------------
// Утилиты
// ---------------------------------------------------------------------------

const MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif',
  '.svg': 'image/svg+xml', '.bmp': 'image/bmp', '.ico': 'image/x-icon',
  '.pdf': 'application/pdf', '.mp4': 'video/mp4', '.webm': 'video/webm',
  '.mov': 'video/quicktime', '.mp3': 'audio/mpeg', '.wav': 'audio/wav',
  '.txt': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8',
  '.json': 'application/json', '.log': 'text/plain; charset=utf-8',
  '.zip': 'application/zip', '.gz': 'application/gzip',
};

/**
 * Имя файла для ссылки и для диска.
 *
 * Только латиница: русское имя кодируется в процентах, и часть чатов и
 * загрузчиков такой URL обрезает. Символы вне набора заменяем на дефис,
 * длину режем, а чтобы два разных файла с одинаковым кириллическим именем
 * не слились в один — дописываем хвост хеша.
 */
function safeName(raw, fallback = 'file.bin') {
  const ext = (path.extname(raw || '') || '').toLowerCase().replace(/[^a-z0-9.]/g, '');
  let stem = path.basename(raw || '', path.extname(raw || ''))
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[-_.]+|[-_.]+$/g, '');
  if (!stem) stem = fallback.replace(/\.[^.]*$/, '');
  stem = stem.slice(0, 48) || 'file';
  const tail = crypto.createHash('sha1').update(String(raw || stem)).digest('hex').slice(0, 6);
  const cleanExt = ext.replace(/^\./, '').slice(0, 8);
  return cleanExt ? `${stem}-${tail}.${cleanExt}` : `${stem}-${tail}`;
}

function mimeFor(name) {
  return MIME[path.extname(name).toLowerCase()] || 'application/octet-stream';
}

/** Сравнение секретов без утечки времени по длине и по содержимому. */
function secretEquals(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false;
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  // Сравниваем хеши фиксированной длины: иначе timingSafeEqual падает на
  // разной длине, и сама длина становится наблюдаемым сигналом.
  const ha = crypto.createHash('sha256').update(ba).digest();
  const hb = crypto.createHash('sha256').update(bb).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function json(res, status, obj) {
  const body = Buffer.from(JSON.stringify(obj, null, 2) + '\n');
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(body);
}

const started = Date.now();

function log(req, status, ms, extra = '') {
  // Секретов тут нет по построению: ключ приходит заголовком и не пишется.
  process.stdout.write(
    `${new Date().toISOString()} ${req.method} ${req.url} ${status} ${ms}ms${extra ? ' ' + extra : ''}\n`
  );
}

// ---------------------------------------------------------------------------
// Разбор multipart/form-data
// ---------------------------------------------------------------------------

/**
 * Достаёт один файл из multipart, разобранного из буфера целиком.
 *
 * Потоковый разбор не нужен: скриншоты маленькие, а лимит тела всё равно
 * держится в памяти. Зато границы нельзя потерять на границе чанков.
 */
/**
 * Следующая граница начиная с позиции from.
 *
 * Разделитель ищется только там, где он стоит в начале строки. Иначе файл,
 * внутри которого случилась строка вида «--граница», обрезался бы по этому
 * совпадению: наивный indexOf находит подстроку в данных и объявляет конец
 * части. У бинарного файла такое совпадение вполне возможно.
 */
function findBoundary(buf, delim, from) {
  const atLineStart = (pos) => pos === 0 || (buf[pos - 2] === 0x0d && buf[pos - 1] === 0x0a);
  for (let pos = buf.indexOf(delim, from); pos !== -1; pos = buf.indexOf(delim, pos + 1)) {
    if (!atLineStart(pos)) continue;
    // Проверяем и окончание разделителя, а не только начало строки. Строка
    // «--граница-дополнительно» внутри файла границей не является: раньше она
    // ею считалась, и файл молча обрезался по ней.
    const after = buf[pos + delim.length];
    // обычная граница: «--граница» + перевод строки или конец буфера
    if (after === 0x0d || after === 0x0a || pos + delim.length >= buf.length) return pos;
    if (after === 0x2d && buf[pos + delim.length + 1] === 0x2d) {
      // закрывающая граница: «--граница--», то есть ровно два дефиса после
      // имени, и дальше перевод строки или конец буфера
      const end2 = buf[pos + delim.length + 2];
      if (end2 === 0x0d || end2 === 0x0a || pos + delim.length + 2 >= buf.length) return pos;
    }
  }
  return -1;
}

function parseMultipart(buf, boundary) {
  const delim = Buffer.from(`--${boundary}`);
  const parts = [];

  let pos = findBoundary(buf, delim, 0);
  if (pos === -1) return parts;
  pos += delim.length;

  for (;;) {
    // «--» сразу после границы означает конец всего тела.
    if (buf[pos] === 0x2d && buf[pos + 1] === 0x2d) break;
    if (buf[pos] === 0x0d) pos += 2;

    const headerEnd = buf.indexOf('\r\n\r\n', pos, 'utf8');
    if (headerEnd === -1) break;
    const header = buf.slice(pos, headerEnd).toString('utf8');
    const bodyStart = headerEnd + 4;

    const next = findBoundary(buf, delim, bodyStart);
    let bodyEnd = next === -1 ? buf.length : next;
    // У найденной границы два байта \r\n принадлежат разделителю, не файлу.
    if (bodyEnd >= 2 && buf[bodyEnd - 2] === 0x0d && buf[bodyEnd - 1] === 0x0a) bodyEnd -= 2;

    const nameMatch = /name="([^"]*)"/i.exec(header);
    const fileMatch = /filename="([^"]*)"/i.exec(header);
    parts.push({
      name: nameMatch ? nameMatch[1] : '',
      filename: fileMatch ? fileMatch[1] : null,
      data: buf.slice(bodyStart, bodyEnd),
    });

    if (next === -1) break;
    pos = next + delim.length;
    if (pos >= buf.length) break;
  }
  return parts;
}

// ---------------------------------------------------------------------------
// Хранилище
// ---------------------------------------------------------------------------

/**
 * /srv/media/<24симв>/<файл>. Рядом meta.json — для учёта.
 *
 * Без шардирования по подкаталогам сознательно: Caddy раздаёт файл по
 * `handle_path /f/*` без единого регулярного выражения, а лимит в 5000
 * файлов ext4 переваривает без проблем. Шардинг стоил бы regex-правила в
 * общем конфиге Caddy — того самого, который обслуживает ещё шесть проектов.
 */
function idDir(root, id) {
  return path.join(root, id);
}

function newId() {
  return crypto.randomBytes(12).toString('hex'); // 96 бит энтропии
}

async function writeUpload(cfg, rawName, data, extra = {}) {
  const id = newId();
  const name = safeName(rawName);
  const dir = idDir(cfg.dir, id);
  await fsp.mkdir(dir, { recursive: true });

  const meta = {
    id,
    name,
    size: data.length,
    mime: extra.mime || mimeFor(name),
    sha256: crypto.createHash('sha256').update(data).digest('hex'),
    created: new Date().toISOString(),
    url: `${cfg.publicBase}/f/${id}/${encodeURIComponent(name)}`,
    // Ссылка своего сервера не вечна: уборщик режет по возрасту и квоте.
    // Раньше клиент подписывал её как постоянную, и человек рассчитывал на
    // сохранность того, что исчезнет через месяц.
    expires_at: new Date(Date.now() + cfg.keepDays * 86400e3).toISOString(),
    ...extra,
  };

  // Временный файл лежит в целевом каталоге, а не в общем tmp: rename
  // атомарен только внутри одного устройства, а при попытке перенести файл
  // из отдельного tmp-каталога сервис под systemd получал EXDEV даже при
  // одинаковом dev в df. Своего каталога для временных файлов теперь нет.
  const final = path.join(dir, name);
  const tmp = path.join(dir, `.${name}.part`);
  try {
    const fh = await fsp.open(tmp, 'w');
    try {
      await fh.writeFile(data);
      await fh.sync(); // не отдавать файл, пока он не на диске
    } finally {
      await fh.close();
    }
    await fsp.rename(tmp, final);

    // Метаданные пишутся внутри той же операции. Раньше запись была после
    // блока очистки: кончись место на meta.json, сервер отвечал 500, клиент
    // уходил к другому хостингу, а файл уже лежал в публичном каталоге без
    // метаданных, и удалить его через API было нечем.
    const metaTmp = path.join(dir, '.meta.json.part');
    await fsp.writeFile(metaTmp, JSON.stringify(meta, null, 2));
    await fsp.rename(metaTmp, path.join(dir, 'meta.json'));
  } catch (e) {
    // Не оставляем после себя огрызок: кончился диск или кончились права.
    // Иначе мусор копится до следующей уборки и ест то самое место,
    // которого и не хватило.
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
    const err = new Error('не удалось сохранить файл на сервере');
    err.cause = e;
    throw err;
  }
  return meta;
}

async function readMeta(cfg, id) {
  if (!/^[0-9a-f]{24}$/.test(id)) return null;
  const dir = idDir(cfg.dir, id);
  try {
    return JSON.parse(await fsp.readFile(path.join(dir, 'meta.json'), 'utf8'));
  } catch (e) {
    return null;
  }
}

async function removeUpload(cfg, id) {
  const meta = await readMeta(cfg, id);
  if (!meta) return false;
  await fsp.rm(idDir(cfg.dir, id), { recursive: true, force: true });
  return true;
}

/**
 * Перечисление загруженных файлов: всё, что лежит в корне в подкаталогах.
 * Плоские файлы, оставшиеся от прежней схемы, игнорируются — они не наши,
 * и уборка их не должна трогать.
 */
async function listUploads(cfg) {
  const out = [];
  for (const e of await fsp.readdir(cfg.dir, { withFileTypes: true }).catch(() => [])) {
    if (!e.isDirectory()) continue;
    if (!/^[0-9a-f]{24}$/.test(e.name)) continue;
    const d = path.join(cfg.dir, e.name);
    for (const f of await fsp.readdir(d, { withFileTypes: true }).catch(() => [])) {
      if (!f.isFile() || f.name === 'meta.json') continue;
      const st = await fsp.stat(path.join(d, f.name)).catch(() => null);
      if (st) out.push({ dir: d, path: path.join(d, f.name), size: st.size, mtime: st.mtimeMs });
    }
  }
  return out;
}

/**
 * Уборка: сперва то, что старше keepDays, затем лишнее по размеру и числу
 * файлов. Отсортировано по времени, удаляется с конца — свежее переживает
 * старый при нехватке места.
 */
async function sweep(cfg) {
  const files = await listUploads(cfg);
  // Сортировка обязательна. listUploads отдаёт файлы в порядке readdir,
  // то есть как вышло, и без неё уборка при переполнении квоты сносила
  // произвольные файлы, включая только что загруженный. Ссылка, которую
  // положили в буфер, после этого переставала работать.
  files.sort((a, b) => a.mtime - b.mtime);
  let bytes = files.reduce((a, f) => a + f.size, 0);

  const cutoff = Date.now() - cfg.keepDays * 86400e3;
  const deadDirs = new Set();
  let dropped = 0;

  for (const f of files) {
    if (f.mtime < cutoff) {
      deadDirs.add(f.dir);
      bytes -= f.size;
      dropped++;
    }
  }
  // Из files.length уже вычтены те, что помечены deadDirs выше. Если этого
  // не сделать, при 100 файлах, из которых 90 просрочены, и maxFiles = 50
  // превышение считалось как 50, и уборщик сносил все оставшиеся свежие
  // файлы, хотя квота давно освободилась.
  let over = Math.max(0, (files.length - deadDirs.size) - cfg.maxFiles);
  let overBytes = Math.max(0, bytes - cfg.maxTotalBytes);
  for (const f of files) {
    if (over <= 0 && overBytes <= 0) break;
    if (deadDirs.has(f.dir)) continue;
    deadDirs.add(f.dir);
    over--;
    overBytes -= f.size;
    dropped++;
  }
  for (const d of deadDirs) {
    await fsp.rm(d, { recursive: true, force: true }).catch(() => {});
  }
  return { files: files.length, bytes, dropped };
}

async function usage(cfg) {
  const files = await listUploads(cfg);
  return { count: files.length, bytes: files.reduce((a, f) => a + f.size, 0) };
}

// ---------------------------------------------------------------------------
// Тело запроса с лимитом
// ---------------------------------------------------------------------------

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let over = false;
    let done = false;
    const finish = (fn, arg) => { if (!done) { done = true; fn(arg); } };
    const tooLarge = () => Object.assign(new Error('файл больше лимита'), { code: 413, tooLarge: true });
    req.on('data', (c) => {
      total += c.length;
      // Лишнее тело дочитываем без буферизации: ответ 413 уходит только после
      // конца запроса. Иначе сервер закрывал бы сокет с недочитанным телом,
      // и клиент получал сброс вместо ответа (macOS, Windows). Потолок
      // четыре лимита: дальше рвём соединение, это уже злоупотребление.
      if (total > limit * 4) {
        finish(reject, tooLarge());
        req.destroy();
        return;
      }
      if (total > limit) { over = true; return; }
      chunks.push(c);
    });
    req.on('end', () => (over ? finish(reject, tooLarge()) : finish(resolve, Buffer.concat(chunks))));
    req.on('error', (e) => finish(reject, e));
  });
}

// ---------------------------------------------------------------------------
// Ограничение частоты
// ---------------------------------------------------------------------------

/**
 * Скользящее окно по каждому адресу. Ключ 256 бит, перебрать его бессмысленно
 * даже без лимита, но поток мусорных запросов на публичный эндпоинт это
 * расходуемые ядра и полоса. Счётчики чистим по ttl, иначе память растёт
 * вместе с числом разных адресов.
 */
function makeLimiter({ windowMs = 60_000, max = 30 } = {}) {
  const hits = new Map();
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [ip, ts] of hits) {
      if (ts.every((t) => now - t > windowMs)) hits.delete(ip);
    }
  }, windowMs);
  sweep.unref();

  return function limit(ip) {
    const now = Date.now();
    let ts = hits.get(ip);
    if (!ts) { ts = []; hits.set(ip, ts); }
    ts = ts.filter((t) => now - t <= windowMs);
    ts.push(now);
    hits.set(ip, ts);
    return { count: ts.length, over: ts.length > max };
  };
}

function authOk(req, cfg) {
  const h = req.headers.authorization || '';
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  return m ? secretEquals(m[1].trim(), cfg.writeKey) : false;
}

/**
 * Сеть edge: Caddy на этой машине ходит в сервис с адресов 172.40.0.0/24.
 * Только оттуда заголовку X-Real-IP верим. Порт в ufw открыт только для этой
 * сети, так что снаружи до сервиса не достать. Другая раскладка сети задаётся
 * в конфиге: edge_prefix, например "10.0.0.".
 */
const EDGE_PREFIX = '172.40.0.';

function clientIp(req, edgePrefix = EDGE_PREFIX) {
  // IPv4 за двойным стеком приходит как ::ffff:172.40.0.7.
  const remote = (req.socket.remoteAddress || 'unknown').replace(/^::ffff:/, '');
  // Заголовок ставит прокси. Если соединение пришло не из сети edge, перед нами
  // прямой клиент, и он волен написать в любой заголовок что угодно: лимит
  // тогда обходится простой ротацией значения. Поэтому верим заголовки только
  // рядом с настоящим прокси.
  if (!remote.startsWith(edgePrefix)) return remote;

  // Именно X-Real-IP, а не первый элемент X-Forwarded-For. Caddy дописывает
  // свой адрес в конец XFF, поэтому клиентский, подделанный, остаётся
  // первым: читать его означало бы доверять тому, что прислал атакующий.
  // Сниппет proxy_headers перезаписывает X-Real-IP реальным адресом.
  const rip = req.headers['x-real-ip'];
  if (typeof rip === 'string' && rip.trim()) return rip.trim();
  return remote;
}

async function handleUpload(req, res, cfg) {
  const ct = req.headers['content-type'] || '';
  const body = await readBody(req, cfg.maxBytes + 64 * 1024);
  if (!body.length) return json(res, 400, { error: 'пустое тело запроса' });

  let data;
  let filename;
  let mime;

  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(ct);
  if (/multipart\/form-data/i.test(ct) && m) {
    const parts = parseMultipart(body, (m[1] || m[2]).trim());
    const file = parts.find((p) => p.filename !== null || p.name === 'file') ||
                 parts.find((p) => p.filename !== null);
    if (!file) return json(res, 400, { error: 'в запросе нет файла' });
    data = file.data;
    filename = file.filename;
  } else {
    // Сырое тело без multipart: curl --data-binary @файл
    data = body;
    filename = req.headers['x-filename'] || 'file.bin';
    mime = ct.split(';')[0].trim();
  }

  if (!data.length) return json(res, 400, { error: 'файл пустой' });
  if (data.length > cfg.maxBytes) {
    return json(res, 413, { error: `файл больше лимита ${cfg.maxBytes} байт` });
  }

  const meta = await writeUpload(cfg, filename, data, { mime: mime || mimeFor(filename) });
  return json(res, 201, meta);
}

function createServer(cfg) {
  const limit = makeLimiter({ windowMs: 60_000, max: 30 });
  return http.createServer((req, res) => {
    // Обёртка сделана намеренно. Раньше async-обработчик стоял напрямую, и
    // любое исключение внутри него, включая URIError от битого процентного
    // кодирования в пути, убивало процесс целиком: запрос `GET /%E0%A4%A`
    // ронял сервер, за которым стоит ещё шесть проектов. Отклонённый промис
    // никто не ловил.
    handleRequest(req, res, cfg, limit).catch((e) => {
      process.stderr.write(`обработчик упал: ${e.stack || e}\n`);
      if (!res.headersSent) {
        json(res, 500, { error: 'внутренняя ошибка сервера, подробности в его логе' });
      } else {
        res.end();
      }
    });
  });
}

async function handleRequest(req, res, cfg, limit) {
  const t0 = Date.now();
  res.on('finish', () => log(req, res.statusCode, Date.now() - t0));

  let path_;
  try {
    // decodeURIComponent бросает URIError на неполной последовательности,
    // например на «/%E0%A4%A». Это плохой запрос, а не сбой сервера.
    path_ = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch (e) {
    return json(res, 400, { error: 'нечитаемый путь запроса' });
  }

  try {
    // Открытый путь — только живость, для мониторинга.
    // HEAD обрабатывается так же, как GET: мониторинги и балансировщики
    // ходят именно HEAD, и раньше он уходил в проверку ключа и получал 401
    // на живом сервисе.
    if ((req.method === 'GET' || req.method === 'HEAD') && path_ === '/v1/health') {
      const body = Buffer.from(JSON.stringify({
        ok: true, uptime: Math.floor((Date.now() - started) / 1000),
      }) + '\n');
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': body.length,
        'Cache-Control': 'no-store',
      });
      return res.end(req.method === 'HEAD' ? undefined : body);
    }

    if (path_.startsWith('/v1/')) {
      const ip = clientIp(req, cfg.edgePrefix);

      // Лимит считаем по каждому неудачному ключу отдельно: нормальный
      // клиент ошибается редко, а подбор ключа с одного адреса упирается в
      // стену. Успешные запросы не штрафуем, иначе серия скриншотов за минуту
      // упрётся в лимит.
      if (!authOk(req, cfg)) {
        const { count, over } = limit(ip);
        if (over) {
          return json(res, 429, {
            error: `слишком много попыток без ключа (${count} за минуту), подожди`,
          });
        }
        res.setHeader('WWW-Authenticate', 'Bearer realm="puuush"');
        return json(res, 401, { error: 'нужен ключ: Authorization: Bearer <write_key>' });
      }

      if (req.method === 'POST' && path_ === '/v1/uploads') {
        return await handleUpload(req, res, cfg);
      }
      // Проверка «сервер вообще живой и ключ подходит» без записи файла.
      // Нужна окну настроек: иначе неверный ключ обнаруживается только тем,
      // что скриншот ушёл наружу.
      if ((req.method === 'GET' || req.method === 'POST') && path_ === '/v1/ping') {
        const u = await usage(cfg);
        return json(res, 200, {
          ok: true,
          service: 'puuush-server',
          uptime: Math.floor((Date.now() - started) / 1000),
          files: u.count,
          bytes: u.bytes,
        });
      }

      if (req.method === 'GET' && path_ === '/v1/info') {
        const u = await usage(cfg);
        return json(res, 200, {
          service: 'puuush-server',
          dir: cfg.dir,
          files: u.count,
          bytes: u.bytes,
          max_bytes: cfg.maxBytes,
          max_total_bytes: cfg.maxTotalBytes,
          max_files: cfg.maxFiles,
          keep_days: cfg.keepDays,
        });
      }
      const del = /^\/v1\/uploads\/([0-9a-f]{24})$/.exec(path_);
      if (del && req.method === 'GET') {
        const meta = await readMeta(cfg, del[1]);
        return meta ? json(res, 200, meta) : json(res, 404, { error: 'не найдено' });
      }
      if (del && req.method === 'DELETE') {
        const ok = await removeUpload(cfg, del[1]);
        return ok ? json(res, 200, { deleted: del[1] })
                  : json(res, 404, { error: 'не найдено' });
      }
      return json(res, 404, { error: 'нет такого метода' });
    }

    return json(res, 404, { error: 'файлы раздаёт веб-сервер, здесь только /v1/' });
  } catch (e) {
    if (e.tooLarge || e.code === 413) {
      // Тело к этому моменту уже дочитано (см. readBody), поэтому обычный ответ.
      return json(res, 413, {
        error: `файл больше лимита ${cfg.maxBytes} байт`,
        max_bytes: cfg.maxBytes,
      });
    }
    // Наружу нейтральный текст: сырое сообщение Node уносит в клиент
    // абсолютный путь файловой системы и намекает на раскладку каталогов.
    process.stderr.write(`внутренняя ошибка: ${e.stack || e}\n`);
    return json(res, 500, { error: 'внутренняя ошибка сервера, подробности в его логе' });
  }
}

// ---------------------------------------------------------------------------

async function main() {
  const cfg = loadConfig();
  await fsp.mkdir(cfg.dir, { recursive: true });

  const server = createServer(cfg);
  server.listen(cfg.port, cfg.host, () => {
    process.stdout.write(`puuush-server слушает ${cfg.host}:${cfg.port}, файлы в ${cfg.dir}\n`);
  });

  const tick = async () => {
    try {
      const r = await sweep(cfg);
      if (r.dropped) process.stdout.write(`уборка: удалено ${r.dropped}\n`);
    } catch (e) {
      process.stdout.write(`уборка не удалась: ${e.message}\n`);
    }
  };
  tick();
  setInterval(tick, 15 * 60 * 1000).unref();
}

// При запуске как сервиса поднимаемся и слушаем. При require из тестов
// ничего не стартует, а наружу отдаются конструктор и чтение конфига: иначе
// тесту пришлось бы вырезать этот файл по кускам.
if (require.main === module) {
  main().catch((e) => {
    process.stderr.write(`не стартовал: ${e.stack || e}\n`);
    process.exit(1);
  });
} else {
  module.exports = {
    createServer, loadConfig, secretEquals, parseMultipart, safeName,
    // Наружу для тестов: уборку и перечисление файлов иначе нечем проверить.
    sweep, listUploads, writeUpload, readMeta, clientIp,
  };
}

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
    // Куда сваливать незаконченные загрузки. Должен быть на том же томе,
    // иначе rename между томами не атомарен.
    tmpDir: raw.tmpDir || '/srv/puuush-tmp',
    writeKey: String(raw.write_key || ''),
    publicBase: String(raw.public_base || '').replace(/\/+$/, ''),
    maxBytes: Number(raw.max_bytes || 32 * 1024 * 1024),
    maxTotalBytes: Number(raw.max_total_bytes || 2 * 1024 * 1024 * 1024),
    keepDays: Number(raw.keep_days || 30),
    maxFiles: Number(raw.max_files || 5000),
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
function parseMultipart(buf, boundary) {
  const delim = Buffer.from(`--${boundary}`);
  const parts = [];
  let pos = buf.indexOf(delim);
  if (pos === -1) return parts;
  pos += delim.length;
  for (;;) {
    if (buf[pos] === 0x2d && buf[pos + 1] === 0x2d) break; // "--" = конец
    if (buf[pos] === 0x0d) pos += 2;
    const headerEnd = buf.indexOf('\r\n\r\n', pos, 'utf8');
    if (headerEnd === -1) break;
    const header = buf.slice(pos, headerEnd).toString('utf8');
    const bodyStart = headerEnd + 4;
    let bodyEnd = buf.indexOf(delim, bodyStart);
    if (bodyEnd === -1) bodyEnd = buf.length;
    let stop = bodyEnd;
    if (buf[stop - 2] === 0x0d && buf[stop - 1] === 0x0a) stop -= 2;

    const nameMatch = /name="([^"]*)"/i.exec(header);
    const fileMatch = /filename="([^"]*)"/i.exec(header);
    parts.push({
      name: nameMatch ? nameMatch[1] : '',
      filename: fileMatch ? fileMatch[1] : null,
      data: buf.slice(bodyStart, stop),
    });
    pos = bodyEnd + delim.length;
    if (pos >= buf.length) break;
  }
  return parts;
}

/** Разбирает Content-Disposition на filename*, как это присылают браузеры. */
function filenameFromHeader(header) {
  const star = /filename\*=UTF-8''([^;]+)/i.exec(header || '');
  if (star) {
    try { return decodeURIComponent(star[1].trim()); } catch (e) { /* идём ниже */ }
  }
  const plain = /filename="([^"]*)"/i.exec(header || '');
  return plain ? plain[1] : null;
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
    ...extra,
  };

  // Временный файл лежит в целевом каталоге, а не в общем tmp: rename
  // атомарен только внутри одного устройства, а при попытке перенести файл
  // из отдельного tmp-каталога сервис под systemd получал EXDEV даже при
  // одинаковом dev в df. Своего каталога для временных файлов теперь нет.
  const final = path.join(dir, name);
  const tmp = path.join(dir, `.${name}.part`);
  const fh = await fsp.open(tmp, 'w');
  try {
    await fh.writeFile(data);
    await fh.sync(); // не отдавать файл, пока он не на диске
  } finally {
    await fh.close();
  }
  await fsp.rename(tmp, final);
  await fsp.writeFile(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2));
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
  let over = Math.max(0, files.length - cfg.maxFiles);
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
    let done = false;
    const finish = (fn, arg) => { if (!done) { done = true; fn(arg); } };
    req.on('data', (c) => {
      total += c.length;
      if (total > limit) {
        // Не рвём сокет здесь: клиент ещё досылает тело, и обрыв не даст ему
        // прочитать ответ. Ставим флаг, прекращаем копить и ждём, пока
        // обработчик отправит 413; соединение закрываем уже после отправки.
        finish(reject, Object.assign(new Error('файл больше лимита'), { code: 413, tooLarge: true }));
        req.pause();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => finish(resolve, Buffer.concat(chunks)));
    req.on('error', (e) => finish(reject, e));
  });
}

/** Ответ с телом, который клиент может не дослушать, — соединение закрываем. */
function jsonAbort(res, status, obj) {
  json(res, status, obj);
  res.on('finish', () => res.socket && res.socket.end());
}

// ---------------------------------------------------------------------------
// Обработчики
// ---------------------------------------------------------------------------

function authOk(req, cfg) {
  const h = req.headers.authorization || '';
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  return m ? secretEquals(m[1].trim(), cfg.writeKey) : false;
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
  return http.createServer(async (req, res) => {
    const t0 = Date.now();
    const url = new URL(req.url, 'http://localhost');
    const path_ = decodeURIComponent(url.pathname);

    res.on('finish', () => log(req, res.statusCode, Date.now() - t0));

    try {
      // Открытый путь — только живость, для мониторинга.
      if (req.method === 'GET' && path_ === '/v1/health') {
        return json(res, 200, { ok: true, uptime: Math.floor((Date.now() - started) / 1000) });
      }

      if (path_.startsWith('/v1/')) {
        if (!authOk(req, cfg)) {
          res.setHeader('WWW-Authenticate', 'Bearer realm="puuush"');
          return json(res, 401, { error: 'нужен ключ: Authorization: Bearer <write_key>' });
        }

        if (req.method === 'POST' && path_ === '/v1/uploads') {
          return await handleUpload(req, res, cfg);
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
        // Клиент может быть ещё в середине отправки — рвать соединение нельзя,
        // иначе он не прочитает код ответа и решит, что сеть отвалилась.
        res.setHeader('Connection', 'close');
        return jsonAbort(res, 413, {
          error: `файл больше лимита ${cfg.maxBytes} байт`,
          max_bytes: cfg.maxBytes,
        });
      }
      return json(res, 500, { error: String(e.message || e) });
    }
  });
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

main().catch((e) => {
  process.stderr.write(`не стартовал: ${e.stack || e}\n`);
  process.exit(1);
});
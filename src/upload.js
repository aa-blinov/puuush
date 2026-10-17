'use strict';
/**
 * Загрузка файлов наружу по списку хостингов.
 *
 * Порядок HOSTS важен: первым идёт хостинг с постоянным хранением, дальше
 * запасные. Каждый ответ проверяется настоящим запросом по ссылке — хостинг
 * может принять файл и отдать битую ссылку, и тогда молча уходим дальше.
 *
 * Логика перенесена из publish.py скилла media-publish, где эти хостеры были
 * проверены отправкой настоящего файла. Проверено: 0x0.st отключил загрузки
 * (лавина ботов), file.io отвечает редиректом вместо ссылки — их тут нет.
 */

const https = require('node:https');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// Браузерный заголовок обязателен: без него catbox отвечает отказом на запрос,
// который не похож на браузерный, и ссылка выглядит битой.
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/140.0 Safari/537.36';

const HOSTS = [
  {
    name: 'catbox',
    label: 'catbox — постоянно',
    url: 'https://catbox.moe/user/api.php',
    fields: { reqtype: 'fileupload' },
    fileField: 'fileToUpload',
    temp: false,
  },
  {
    name: 'pomf2',
    label: 'pomf2.lain.la — постоянно',
    url: 'https://pomf2.lain.la/upload.php',
    fields: {},
    fileField: 'files[]',
    temp: false,
    json: 'files.0.url',
  },
  {
    name: 'uguu',
    label: 'uguu.se — на несколько часов',
    url: 'https://uguu.se/upload.php',
    fields: {},
    fileField: 'files[]',
    temp: true,
    json: 'files.0.url',
  },
  // litterbox в цепочку не входит: проверено 2026-10-17, отвечает HTTP 412
  // «No file!» на любой запрос. Если хостинг оживёт — добавить обратно сюда.
];

/** Собирает multipart тело. Возвращает Buffer и заголовок с границей. */
function multipart(fields, fileField, filePath, filename) {
  const boundary =
    '----puuush' + crypto.randomBytes(16).toString('hex');
  const chunks = [];
  const push = (s) => chunks.push(Buffer.from(s, 'utf8'));

  for (const [k, v] of Object.entries(fields || {})) {
    push(
      `--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`
    );
  }
  push(`--${boundary}\r\nContent-Disposition: form-data; name="${fileField}"; ` +
    `filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`);
  chunks.push(fs.readFileSync(filePath));
  push(`\r\n--${boundary}--\r\n`);

  return {
    body: Buffer.concat(chunks),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

/** HTTP(S) запрос с телом. Возвращает { status, headers, body }. Редиректы — вручную. */
function request(url, { method = 'GET', headers = {}, body = null, timeout = 60000, redirects = 3 } = {}) {
  return new Promise((resolve, reject) => {
    const send = (target, left) => {
      let u;
      try {
        u = new URL(target);
      } catch (e) {
        return reject(new Error('плохой адрес: ' + target));
      }
      const lib = u.protocol === 'http:' ? http : https;
      const req = lib.request(
        u,
        { method, headers: { 'User-Agent': UA, ...headers } },
        (res) => {
          const code = res.statusCode || 0;
          if (code >= 300 && code < 400 && res.headers.location && left > 0) {
            res.resume();
            return send(new URL(res.headers.location, u).toString(), left - 1);
          }
          const out = [];
          res.on('data', (c) => out.push(c));
          res.on('end', () =>
            resolve({ status: code, headers: res.headers, body: Buffer.concat(out) })
          );
        }
      );
      req.setTimeout(timeout, () => req.destroy(new Error('превышено время ожидания')));
      req.on('error', reject);
      if (body) req.write(body);
      req.end();
    };
    send(url, redirects);
  });
}

/** Достаёт значение из JSON по пути вида "files.0.url". */
function pick(obj, pathStr) {
  let cur = obj;
  for (const key of pathStr.split('.')) {
    if (cur == null) return null;
    cur = cur[Array.isArray(cur) ? Number(key) : key];
  }
  return cur;
}

/**
 * Свой box: загрузка в свой сервер через API.
 *
 * Раньше здесь был просто cp в каталог плюс проверка ссылки. Свой сервер
 * теперь принимает файлы по /v1/uploads с ключом в заголовке — так ключ не
 * попадает ни в access-лог Caddy, ни в ссылку.
 */
async function uploadOwn(host, filePath, onStep = () => {}) {
  const { base_url: base, write_key: key } = host;
  if (!base || !key) {
    onStep('свой box: не настроен адрес или ключ');
    return null;
  }
  // Node выбрасывает сырое «Invalid character in header content», если в
  // заголовок попал хоть один нелатинский символ. Ловим это сами и говорим
  // по-человечески, иначе в уведомление уедет нечитаемая ошибка Node.
  if (/[^\x21-\x7e]/.test(key)) {
    throw new Error('свой box: в ключе есть нелатинские символы или пробелы');
  }
  const endpoint = base.replace(/\/+$/, '') + '/v1/uploads';
  const { body, contentType } = multipart({}, 'file', filePath, path.basename(filePath));

  onStep('свой box: загружаю');
  const res = await request(endpoint, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + key,
      'Content-Type': contentType,
      'Content-Length': body.length,
    },
    body,
  });

  if (res.status !== 200 && res.status !== 201) {
    // Сервер отвечает JSON: достаём его error, иначе в уведомление уедет
    // обрывок HTML и никакого смысла.
    let detail = res.body.toString('utf8').slice(0, 120);
    try {
      const parsed = JSON.parse(res.body.toString('utf8'));
      if (parsed && parsed.error) detail = parsed.error;
    } catch (e) { /* не JSON — покажем как есть */ }
    if (res.status === 401) throw new Error('свой box отклонил ключ (401)');
    throw new Error(`свой box: HTTP ${res.status} — ${detail}`);
  }

  const meta = JSON.parse(res.body.toString('utf8'));
  if (!meta || typeof meta.url !== 'string') throw new Error('свой box: в ответе нет url');

  onStep('свой box: проверяю ссылку');
  if (!(await verify(meta.url, fs.statSync(filePath).size))) {
    throw new Error('свой box: ссылка не отдаёт файл');
  }
  return { url: meta.url, host: 'свой box', temp: false };
}

/** Загрузка на один хостинг. */
async function uploadTo(host, filePath) {
  const { body, contentType } = multipart(
    host.fields,
    host.fileField,
    filePath,
    path.basename(filePath)
  );
  const res = await request(host.url, {
    method: 'POST',
    headers: { 'Content-Type': contentType, 'Content-Length': body.length },
    body,
  });
  if (res.status !== 200) {
    throw new Error(`HTTP ${res.status}: ${res.body.toString('utf8').slice(0, 80)}`);
  }
  const text = res.body.toString('utf8').trim();
  let url = text;
  if (host.json) {
    url = pick(JSON.parse(text), host.json);
  }
  if (typeof url !== 'string' || !/^https?:\/\//.test(url)) {
    throw new Error('в ответе нет ссылки: ' + text.slice(0, 80));
  }
  return url;
}

/** Проверяет, что ссылка правда отдаёт файл, а не отдаёт 404 на пустом каталоге. */
async function verify(url, size) {
  try {
    const res = await request(url, { headers: { Accept: '*/*' }, timeout: 30000 });
    if (res.status !== 200) return false;
    if (!size) return true;
    return res.body.length >= Math.floor(size / 2);
  } catch (e) {
    return false;
  }
}

/**
 * Имя файла для ссылки: латиница, цифры, точка, дефис.
 *
 * Русские имена кодируются в процентах, и чаты или плееры такой URL обрезают.
 * Поэтому не ascii-символы убираем, а к укороченному названию добавляем хвост
 * хеша: два разных файла с одинаковым русским именем не сольются в один.
 */
function safeName(p) {
  const ext = path.extname(p);
  let stem = path
    .basename(p, ext)
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[-_.]+|[-_.]+$/g, '');
  if (!stem) stem = 'file';
  stem = stem.slice(0, 48);
  const tail = crypto.createHash('sha1').update(path.basename(p)).digest('hex').slice(0, 6);
  const cleanExt = ext.replace(/[^A-Za-z0-9.]/g, '').slice(0, 8);
  return `${stem}-${tail}${cleanExt}`;
}

/**
 * Кладёт файл наружу.
 *
 * @param {string} filePath путь к файлу
 * @param {object} opts
 * @param {string} [opts.host] 'auto' | 'catbox' | 'uguu' | 'litterbox' | 'pomf2' | 'own'
 * @param {object} [opts.own] { base_url, dir }
 * @param {(msg:string)=>void} [opts.onStep]
 * @returns {Promise<{url:string, host:string, temp:boolean, size:number}>}
 */
async function publish(filePath, opts = {}) {
  const { host = 'auto', own = null, onStep = () => {} } = opts;
  if (!fs.existsSync(filePath)) throw new Error('нет файла: ' + filePath);
  const size = fs.statSync(filePath).size;
  if (!size) throw new Error('файл пустой: ' + filePath);

  if (host === 'own') {
    if (!own || !own.base_url || !own.write_key) {
      throw new Error('свой box не настроен: нужен адрес и ключ');
    }
    const r = await uploadOwn(own, filePath, onStep);
    if (r) return { ...r, size };
    throw new Error('свой box не отдал ссылку — проверь домен и каталог');
  }

  let chain = HOSTS;
  const single = host !== 'auto';
  if (single) {
    chain = HOSTS.filter((h) => h.name === host);
    if (!chain.length) throw new Error('неизвестный хостинг: ' + host);
  } else if (own && own.base_url && own.write_key) {
    // В авторежиме свой box не имеет права обрывать цепочку: любой его сбой —
    // неверный ключ, битый сервер, опечатка в адресе — должен молча уводить
    // на внешний хостинг, а не ронять всю загрузку.
    onStep('пробую свой box');
    try {
      const r = await uploadOwn(own, filePath, onStep);
      if (r) return { ...r, size };
    } catch (e) {
      onStep(`свой box не сработал: ${e.message}`);
    }
  }

  const reasons = [];
  for (const h of chain) {
    onStep('пробую ' + h.name);
    let url;
    try {
      url = await uploadTo(h, filePath);
    } catch (e) {
      onStep(`${h.name}: ${e.message}`);
      reasons.push(`${h.name} — ${e.message}`);
      continue;
    }
    onStep(`${h.name}: проверяю ссылку`);
    if (!(await verify(url, size))) {
      onStep(`${h.name}: ссылка не вывозит файл, иду дальше`);
      reasons.push(`${h.name} — ссылка не вывозит файл`);
      continue;
    }
    return { url, host: h.name, temp: !!h.temp, size };
  }

  if (single) {
    throw new Error(
      `${host} не отдал рабочую ссылку. ${reasons.join('; ') || 'причина неизвестна'}`
    );
  }
  throw new Error(
    'ни один хостинг не отдал рабочую ссылку: ' + (reasons.join('; ') || 'причина неизвестна')
  );
}

module.exports = { publish, verify, safeName, HOSTS };
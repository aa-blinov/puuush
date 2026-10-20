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
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { isIP } = require('node:net');

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

// Потолок одного файла. Верхняя цифра взята из лимитов публичных хостингов:
// файл больше отправлять всё равно некуда, а память под него тратится сразу.
const MAX_UPLOAD = 64 * 1024 * 1024;
// Ответ на проверку ссылки читается только до этого объёма: нам нужно знать
// «отдался ли файл», а не скачать его целиком.
const MAX_REPLY = 2 * 1024 * 1024;

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
function request(url, { method = 'GET', headers = {}, body = null, timeout = 60000, redirects = 3, maxBytes = MAX_REPLY, stopAfter = 0 } = {}) {
  if (module.exports.__request) return module.exports.__request(url, { method, headers, body, timeout });
  return realRequest(url, { method, headers, body, timeout, redirects, maxBytes, stopAfter });
}

function realRequest(url, { method = 'GET', headers = {}, body = null, timeout = 60000, redirects = 3, maxBytes = MAX_REPLY, stopAfter = 0 } = {}) {
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
            // Запрос с ключом по редиректу не идём никогда: иначе Bearer
            // уедет на чужой хост, который сам выбрал злоумышленник.
            if (headers.Authorization) {
              res.resume();
              return reject(new Error(
                'сервер ответил редиректом на другой адрес, запрос с ключом не повторяем'
              ));
            }
            let next;
            try {
              next = new URL(res.headers.location, u).toString();
            } catch (e) {
              // Раньше эта ошибка бросалась из обработчика ответа и уносила
              // процесс. Редирект на file:///etc/passname ронял процесс целиком.
              res.resume();
              return reject(new Error('сервер ответил редиректом на нечитаемый адрес'));
            }
            if (!/^https?:$/i.test(new URL(next).protocol)) {
              res.resume();
              return reject(new Error('сервер ответил редиректом на не-http адрес'));
            }
            res.resume();
            return send(next, left - 1);
          }
          // Тело склеивается целиком, поэтому потолок обязателен: без него
          // проверка ссылки на файле в сотни мегабайт съест столько же RAM.
          let size = 0;
          let done = false;
          const out = [];
          const finish = (fn, arg) => {
            if (done) return;
            done = true;
            clearTimeout(deadline);
            fn(arg);
          };

          res.on('data', (c) => {
            // Чанк может прийти целиком больше потолка: берём только нужную
            // часть. Раньше не бралась ничего, и рабочая ссылка на большой файл
            // объявлялась битой.
            const room = maxBytes - out.length;
            if (room > 0) out.push(c.length <= room ? c : c.slice(0, room));

            if (stopAfter && out.length >= stopAfter) {
              // Заголовки уже пришли, первых байт хватает. Досылать остальное
              // незачем: сервер без Range льёт весь файл, а нужен только кусок.
              finish(resolve, {
                status: code, headers: res.headers, body: Buffer.concat(out),
              });
              res.destroy();
              return;
            }
            if (out.length >= maxBytes) {
              // Потолок достигнут и останавливать рано: продолжать качать
              // незачем, соединение рвём.
              finish(reject, Object.assign(new Error('ответ больше лимита'), { tooBig: true }));
              res.destroy();
            }
          });
          res.on('end', () => finish(resolve, {
            status: code, headers: res.headers, body: Buffer.concat(out),
          }));
          res.on('error', (e) => finish(reject, e));
          // Сервер объявил Content-Length и оборвал соединение после заголовков.
          // Без этого обработчика событие end не наступает и промис живёт вечно:
          // загрузка застревает, а флаги busy и uploading не сбрасываются.
          res.on('aborted', () => finish(reject, new Error('соединение оборвано')));
          res.on('close', () => {
            if (!done) finish(reject, new Error('соединение закрыто раньше конца ответа'));
          });
        }
      );
      // setTimeout ограничивает простой между пакетами, а не всю операцию:
      // сервер, шлющий данные без пауз, держал бы нас вечно. Отдельный
      // предельный таймер ограничивает длительность целиком.
      const deadline = setTimeout(
        () => req.destroy(new Error('превышено время ожидания')),
        timeout
      );
      deadline.unref?.();
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
/**
 * Настоящий loopback.
 *
 * Прежняя проверка брала текст хоста, и через неё проходил домен вроде
 * 127.attacker.example: ключ уходил по http чужому серверу целиком.
 * Смотрим на тип адреса, а не на начало строки.
 */
function isLoopback(hostname) {
  const h = String(hostname || '').replace(/^\[|\]$/g, '').toLowerCase();
  if (h === 'localhost') return true; // точное имя, не my.localhost
  if (isIP(h) === 4) return h.split('.')[0] === '127';
  if (isIP(h) === 6) return h === '::1' || h === '::ffff:127.0.0.1';
  return false;
}

/**
 * Проверяет адрес и ключ до сетевого вызова.
 * Возвращает строку с причиной или пустую строку, если всё в порядке.
 * Используется и загрузкой, и кнопкой «Проверить сервер» в окне настроек:
 * расхождение правил означало бы зелёную галочку там, где загрузка упадёт.
 */
function validateOwn({ base_url: base, write_key: key } = {}) {
  if (!base || !key) return 'сервер или ключ не заполнены';
  let parsed;
  try {
    parsed = new URL(base);
  } catch (e) {
    return 'адрес нечитаемый';
  }
  if (!/^https?:$/i.test(parsed.protocol)) return 'адрес должен быть http или https';
  // По http ключ летел бы открытым текстом. Локальный адрес — исключение,
  // там TLS всё равно некуда вешать. Проверяем настоящий loopback, а не
  // начало строки: через «127.» проходил домен 127.attacker.example.
  if (!/^https:$/i.test(parsed.protocol) && !isLoopback(parsed.hostname)) {
    return 'нужен https, ключ не должен идти открытым текстом';
  }
  // Node бросает сырое «Invalid character in header content», если в
  // заголовок попал хоть один символ вне ASCII. Проверяем заранее.
  if (/[^\x21-\x7e]/.test(key)) {
    return 'в ключе есть нелатинские символы или пробелы';
  }
  return '';
}

async function uploadOwn(host, filePath, onStep = () => {}) {
  const { base_url: base, write_key: key } = host;
  if (!base || !key) {
    onStep('свой box: не настроен адрес или ключ');
    return null;
  }
  const why = validateOwn({ base_url: base, write_key: key });
  if (why) throw new Error('свой box: ' + why);
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
  if (!(await verify(meta.url, fs.statSync(filePath).size, filePath))) {
    throw new Error('свой box: ссылка не отдаёт файл');
  }
  // Срок хранения приходит с сервера: ссылка своего сервера не вечна.
  return { url: meta.url, host: 'свой box', temp: false, expiresAt: meta.expires_at || null };
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

/**
 * Проверяет, что ссылка правда отдаёт наш файл.
 *
 * Сверяются первые PROBE байт, а не размер. Размер сверять нельзя: чтобы его
 * узнать, файл надо скачать целиком, а ссылка может вести на сотни мегабайт.
 * Запрашивается только начало через Range, поэтому проверка стоит копейки и
 * работает для файла любого размера.
 *
 * Раньше здесь стояло `res.body.length >= size / 2` при обрезанном до 2 МБ
 * ответе, и любой файл тяжелее примерно 4 МБ объявлялся битым. Полноэкранный
 * снимок на Retina столько весит легко, то есть полноэкранные скрины были
 * сломаны полностью.
 */
const PROBE = 64;

async function verify(url, size, filePath) {
  let head;
  try {
    const fh = await fsp.open(filePath, 'r');
    try {
      const buf = Buffer.alloc(PROBE);
      const { bytesRead } = await fh.read(buf, 0, PROBE, 0);
      head = buf.slice(0, bytesRead);
    } finally {
      await fh.close();
    }
  } catch (e) {
    head = null;
  }

  if (!head) {
    // Локальный файл не прочитался: подтверждать нечем, доверять нечему.
    return false;
  }

  try {
    const res = await request(url, {
      headers: { Range: `bytes=0-${PROBE - 1}` },
      timeout: 30000,
      // Сервер может проигнорировать Range и прислать файл целиком. Он нам не
      // нужен: проверяем первые байты и размер из заголовков.
      stopAfter: PROBE + 64,
      maxBytes: PROBE + 64,
    });
    // 206 — сервер послушался Range, 200 — проигнорировал и отдал всё целиком.
    if (res.status !== 200 && res.status !== 206) return false;
    if (!res.body.length) return false;

    const got = res.body.slice(0, head.length);
    if (got.length !== head.length || !head.equals(got)) return false;

    // Совпадения первых байт мало: сервер мог хранить только их, обрезав файл.
    // Если сервер объявил полный размер, он обязан совпасть: 206 обязан нести
    // Content-Range, обычный ответ — Content-Length. Если размера не объявлено
    // вовсе (чанковый ответ), отказывать нельзя: ссылка может быть вполне
    // рабочей, и обрывка ради заголовка тут нечего.
    const cr = String(res.headers['content-range'] || '');
    const m = /bytes 0-(\d+)\/(\d+)/.exec(cr);
    if (m) return Number(m[2]) === size;
    const cl = Number(res.headers['content-length']);
    if (Number.isFinite(cl) && cl > 0) return cl === size;
    return true;
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
  const { host = 'auto', own = null, onStep = () => {}, maxBytes = MAX_UPLOAD } = opts;
  if (!fs.existsSync(filePath)) throw new Error('нет файла: ' + filePath);
  const size = fs.statSync(filePath).size;
  if (!size) throw new Error('файл пустой: ' + filePath);
  // Файл читается в память целиком и склеивается из чанков, то есть
  // занимает примерно удвоенный объём: 400 МБ файла съедали 880 МБ RAM.
  // Проверка ссылки ниже тянет ещё и сам файл. Потолок отсекает видео,
  // которые всё равно никто не отправит.
  if (size > maxBytes) {
    throw new Error(
      `файл ${Math.round(size / 1048576)} МБ больше потолка ${Math.round(maxBytes / 1048576)} МБ`
    );
  }

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
    if (!(await verify(url, size, filePath))) {
      onStep(`${h.name}: ссылка не вывозит файл, иду дальше`);
      reasons.push(`${h.name} — ссылка не вывозит файл`);
      continue;
    }
    return { url, host: h.name, temp: !!h.temp, size,
             expiresAt: h.name === 'own' ? new Date(Date.now() + 30 * 86400e3).toISOString() : null };
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

module.exports = { publish, verify, safeName, HOSTS, request, validateOwn, isLoopback };

// --- точки подмены для тестов -------------------------------------------------
// Зовёт их только тест. Проверка на каждый запрос стоит одно сравнение
// undefined, в горячем пути это заметить нельзя.
// Возвращают предыдущее значение, чтобы тест восстановил его в finally.
module.exports.__setRequestForTests = (fn) => {
  // Сохраняем именно текущую заглушку, а не обёртку request. Раньше
  // сохранялась сама request, и после восстановления обёртка вызывала через
  // __request саму себя: первый же настоящий запрос уходил в переполнение стека.
  const prev = module.exports.__request;
  module.exports.__request = fn;
  return prev;
};
module.exports.__restoreRequestForTests = (prev) => {
  if (prev === undefined) delete module.exports.__request;
  else module.exports.__request = prev;
};
module.exports.__setHostsForTests = (list) => {
  const prev = HOSTS.slice();
  HOSTS.length = 0;
  HOSTS.push(...list);
  return prev;
};
module.exports.__restoreHostsForTests = (prev) => {
  HOSTS.length = 0;
  HOSTS.push(...prev);
};

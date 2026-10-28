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
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { isIP } = require('node:net');
const { t } = require('./i18n');

// Браузерный заголовок обязателен: без него catbox отвечает отказом на запрос,
// который не похож на браузерный, и ссылка выглядит битой.
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/140.0 Safari/537.36';

/**
 * Облачные хостинги.
 *
 * Список собран по проверке настоящими загрузками, а не по описаниям:
 * - catbox принимает видео до 200 МБ и хранит постоянно;
 * - litterbox — его временная половина, до 1 ГБ, хранит 72 часа;
 * - x0.at принимает видео и отдаёт прямую ссылку с Range;
 * - uguu хранит несколько часов и отдаёт прямую ссылку;
 * - pomf2 оставлен запасным: он то работает, то нет, и это видно по
 *   проверке ссылки после загрузки.
 *
 * У каждого хостинга свой потолок файла: у временных он обычно больше, чем
 * у постоянных. Файл больше потолка пропускается, а не отправляется вслепую.
 *
 * Порядок здесь — порядок по умолчанию, а не догма. x0, uguu и pomf2 в
 * текущих проверках отвечают быстрее и надёжнее catbox/litterbox; из другого
 * региона порядок может быть иным, поэтому в настройках есть проверка
 * скорости: она меряет загрузку с этой машины и ставит быстрые хостинги вперёд.
 */
const MB = 1024 * 1024;

/**
 * Размер для человека.
 *
 * Раньше все размеры округлялись до мегабайт, и файл в 4096 байт
 * показывался как «0 МБ» — в сообщении об отказе это выглядело поломкой.
 */
function sizeText(bytes) {
  if (bytes < MB) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  const mb = bytes / MB;
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
}

const HOSTS = [
  {
    name: 'x0',
    url: 'https://x0.at',
    fields: {},
    fileField: 'file',
    temp: true,
    max: 512 * MB,
  },
  {
    name: 'uguu',
    url: 'https://uguu.se/upload.php',
    fields: {},
    fileField: 'files[]',
    temp: true,
    json: 'files.0.url',
    max: 128 * MB,
  },
  {
    name: 'pomf2',
    url: 'https://pomf2.lain.la/upload.php',
    fields: {},
    fileField: 'files[]',
    temp: false,
    json: 'files.0.url',
    max: 100 * MB,
  },
  {
    name: 'catbox',
    url: 'https://catbox.moe/user/api.php',
    fields: { reqtype: 'fileupload' },
    fileField: 'fileToUpload',
    temp: false,
    max: 200 * MB,
  },
  {
    name: 'litterbox',
    url: 'https://litterbox.catbox.moe/resources/internals/api.php',
    fields: { reqtype: 'fileupload', time: '72h' },
    fileField: 'fileToUpload',
    temp: true,
    max: 1024 * MB,
  },
];

/**
 * Хостинги в нужном порядке.
 *
 * `order` — имена, измеренные на этой машине. Незнакомые имена
 * игнорируются: список не должен ломаться от старой настройки.
 */
function orderedHosts(order) {
  if (!Array.isArray(order) || !order.length) return HOSTS.slice();
  const known = new Set(HOSTS.map((h) => h.name));
  const first = [];
  for (const name of order) {
    if (!known.has(name)) continue;
    const host = HOSTS.find((h) => h.name === name);
    if (host && !first.includes(host)) first.push(host);
  }
  for (const host of HOSTS) if (!first.includes(host)) first.push(host);
  return first;
}

// Потолок одного файла. Верхняя цифра взята из лимитов публичных хостингов:
// файл больше отправлять всё равно некуда, а память под него тратится сразу.
const MAX_UPLOAD = 64 * 1024 * 1024;

// Потолок для записи экрана. Запись встречи на час весит сотни мегабайт, и
// потолок публичных хостингов тут неприменим: своя машина примет столько,
// сколько настроено на сервере. Файл всё равно уходит потоком, а не целиком
// в память, поэтому большой потолок не стоит ничего.
const MAX_VIDEO_UPLOAD = 4 * 1024 * 1024 * 1024;
// Ответ на проверку ссылки читается только до этого объёма: нам нужно знать
// «отдался ли файл», а не скачать его целиком.
const MAX_REPLY = 2 * 1024 * 1024;

/**
 * Собирает multipart тело целиком в памяти.
 *
 * Годится для скриншотов и всего мелкого: там память не стоит ни копейки,
 * а тело уходит одним куском.
 */
function multipart(fields, fileField, filePath, filename) {
  const { head, tail, length, contentType } = multipartParts(fields, fileField, filePath, filename);
  return { body: Buffer.concat([head, fs.readFileSync(filePath), tail]), contentType };
}

/**
 * Собирает multipart тело по частям, файл не читая.
 *
 * Запись встречи весит сотни мегабайт, и чтение её целиком в память означало бы
 * две копии файла (тело плюс проверка ссылки) на машине, где памяти и так
 * мало. Здесь тело состоит из трёх кусков: голова, сам файл потоком и хвост.
 *
 * Длина известна заранее — размер файла на диске, — поэтому Content-Length
 * ставится сразу, и сервер начинает писать файл, не дожидаясь конца тела.
 */
function multipartParts(fields, fileField, filePath, filename) {
  const boundary = '----puuush' + crypto.randomBytes(16).toString('hex');
  const chunks = [];
  const push = (s) => chunks.push(Buffer.from(s, 'utf8'));

  for (const [k, v] of Object.entries(fields || {})) {
    push(
      `--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`
    );
  }
  push(`--${boundary}\r\nContent-Disposition: form-data; name="${fileField}"; ` +
    `filename="${safeName(filename)}"\r\nContent-Type: application/octet-stream\r\n\r\n`);
  const head = Buffer.concat(chunks);
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');
  const size = fs.statSync(filePath).size;
  return {
    head,
    tail,
    length: head.length + size + tail.length,
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

/** HTTP(S) запрос с телом. Возвращает { status, headers, body }. Редиректы — вручную. */
function request(url, { method = 'GET', headers = {}, body = null, timeout = 60000, redirects = 3, maxBytes = MAX_REPLY, stopAfter = 0 } = {}) {
  if (module.exports.__request) return module.exports.__request(url, { method, headers, body, timeout });
  return realRequest(url, { method, headers, body, timeout, redirects, maxBytes, stopAfter });
}

/**
 * Читает тело ответа, уважая потолок и раннюю остановку.
 *
 * Отдельно от запроса: и буферный, и потоковый запросы читают ответ одинаково,
 * а различаются только тем, как уходит тело запроса.
 */
function collectResponse(res, { maxBytes, stopAfter }) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let done = false;
    const out = [];
    const finish = (fn, arg) => {
      if (done) return;
      done = true;
      fn(arg);
    };
    const code = res.statusCode || 0;

    res.on('data', (c) => {
      // Чанк может прийти целиком больше потолка: берём только нужную
      // часть. Раньше не бралась ничего, и рабочая ссылка на большой файл
      // объявлялась битой.
      const room = maxBytes - size;
      if (room > 0) {
        const part = c.length <= room ? c : c.subarray(0, room);
        out.push(part);
        // Считаем байты, а не чанки: out.length это число кусков, и
        // оба потолка ниже раньше сравнивались с ним.
        size += part.length;
      }

      if (stopAfter && size >= stopAfter) {
        // Заголовки уже пришли, первых байт хватает. Досылать остальное
        // незачем: сервер без Range льёт весь файл, а нужен только кусок.
        finish(resolve, {
          status: code, headers: res.headers, body: Buffer.concat(out),
        });
        res.destroy();
        return;
      }
      if (size >= maxBytes) {
        // Потолок достигнут и останавливать рано: продолжать качать
        // незачем, соединение рвём.
        finish(reject, Object.assign(new Error(t('upload.tooLarge')), { tooBig: true }));
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
    res.on('aborted', () => finish(reject, new Error(t('upload.connDropped'))));
    res.on('close', () => {
      if (!done) finish(reject, new Error(t('upload.connClosed')));
    });
  });
}

/**
 * Следующий адрес после редиректа, либо ошибка.
 *
 * Запрос с ключом по редиректу не идёт никогда: иначе Bearer уедет на чужой
 * хост, который сам выбрал злоумышленник.
 */
function followRedirect(res, u, headers, left, send) {
  const code = res.statusCode || 0;
  if (code < 300 || code >= 400 || !res.headers.location || left <= 0) return false;
  if (headers.Authorization) {
    res.resume();
    throw new Error(t('upload.redirect'));
  }
  let next;
  try {
    next = new URL(res.headers.location, u).toString();
  } catch (e) {
    // Раньше эта ошибка бросалась из обработчика ответа и уносила
    // процесс. Редирект на file:///etc/passname ронял процесс целиком.
    res.resume();
    throw new Error(t('upload.redirectUnreadable'));
  }
  if (!/^https?:$/i.test(new URL(next).protocol)) {
    res.resume();
    throw new Error(t('upload.redirectNotHttp'));
  }
  res.resume();
  send(next, left - 1);
  return true;
}

function realRequest(url, { method = 'GET', headers = {}, body = null, timeout = 60000, redirects = 3, maxBytes = MAX_REPLY, stopAfter = 0 } = {}) {
  return new Promise((resolve, reject) => {
    const send = (target, left) => {
      let u;
      try {
        u = new URL(target);
      } catch (e) {
        return reject(new Error(t('upload.badUrl', { error: target })));
      }
      const lib = u.protocol === 'http:' ? http : https;
      const req = lib.request(
        u,
        { method, headers: { 'User-Agent': UA, ...headers } },
        (res) => {
          let gone = false;
          try {
            gone = followRedirect(res, u, headers, left, send);
          } catch (e) {
            return reject(e);
          }
          if (gone) return;
          const deadline = setTimeout(
            () => req.destroy(new Error(t('upload.timeout'))),
            Math.max(timeout, Math.min(timeout + Math.ceil((body ? body.length : 0) / 204800) * 1000, 600000))
          );
          deadline.unref?.();
          collectResponse(res, { maxBytes, stopAfter }).then(
            (r) => { clearTimeout(deadline); resolve(r); },
            (e) => { clearTimeout(deadline); reject(e); }
          );
        }
      );
      // setTimeout ограничивает простой между пакетами, а не всю операцию:
      // сервер, шлющий данные без пауз, держал бы нас вечно. Отдельный
      // предельный таймер ограничивает длительность целиком.
      // Предел растёт с телом: файл в 60 МБ на медленном канале льётся дольше
      // минуты, и общий предел в 60 с рвал его на каждом хостинге подряд.
      const limit = Math.min(timeout + Math.ceil((body ? body.length : 0) / 204800) * 1000, 600000);
      const deadline = setTimeout(
        () => req.destroy(new Error(t('upload.timeout'))),
        Math.max(timeout, limit)
      );
      deadline.unref?.();
      req.setTimeout(timeout, () => req.destroy(new Error(t('upload.timeout'))));
      req.on('error', reject);
      if (body) req.write(body);
      req.end();
    };
    send(url, redirects);
  });
}

/**
 * Порог, выше которого файл уходит потоком, а не целиком в память.
 *
 * Скриншот в памяти стоит копейки, а запись встречи весит сотни мегабайт:
 * читать её целиком значит держать в RAM ещё одну копию (тело плюс проверка
 * ссылки). Выше порога тело уходит потоком, и в памяти лежит только кусок.
 */
const STREAM_THRESHOLD = 8 * 1024 * 1024;

/**
 * Запрос с телом, уходящим потоком с диска.
 *
 * Тело multipart состоит из трёх частей: голова, файл и хвост. Длина известна
 * заранее, поэтому Content-Length ставится сразу и сервер начинает писать файл,
 * не дожидаясь конца.
 */
function requestStream(url, { method = 'POST', headers = {}, filePath, head = null, tail = null, length = null, timeout = 600000, redirects = 0, maxBytes = MAX_REPLY } = {}) {
  if (module.exports.__requestStream) {
    return module.exports.__requestStream(url, { method, headers, filePath, head, tail, length, timeout });
  }
  return realRequestStream(url, { method, headers, filePath, head, tail, length, timeout, redirects, maxBytes });
}

function realRequestStream(url, { method = 'POST', headers = {}, filePath, head = null, tail = null, length = null, timeout = 600000, redirects = 0, maxBytes = MAX_REPLY } = {}) {
  return new Promise((resolve, reject) => {
    const send = (target, left) => {
      let u;
      try {
        u = new URL(target);
      } catch (e) {
        return reject(new Error(t('upload.badUrl', { error: target })));
      }
      const lib = u.protocol === 'http:' ? http : https;
      const req = lib.request(
        u,
        { method, headers: { 'User-Agent': UA, ...headers } },
        (res) => {
          const code = res.statusCode || 0;
          // Поток с диска уже ушёл, и повторить его на другой адрес нельзя:
          // часть файла прочитана. Редирект здесь — честная ошибка, а не
          // повод отправить файл дважды.
          if (code >= 300 && code < 400) {
            res.resume();
            return reject(new Error(t('upload.redirectStream')));
          }
          const deadline = setTimeout(
            () => req.destroy(new Error(t('upload.timeout'))),
            timeout
          );
          deadline.unref?.();
          collectResponse(res, { maxBytes, stopAfter: 0 }).then(
            (r) => { clearTimeout(deadline); resolve(r); },
            (e) => { clearTimeout(deadline); reject(e); }
          );
        }
      );
      req.setTimeout(timeout, () => req.destroy(new Error(t('upload.timeout'))));
      req.on('error', reject);
      if (head && head.length) req.write(head);
      // Файл льётся кусками: в памяти одновременно лежит только один кусок.
      const rs = fs.createReadStream(filePath);
      rs.on('error', (e) => req.destroy(e));
      rs.pipe(req, { end: false });
      rs.on('end', () => {
        if (tail && tail.length) req.write(tail);
        req.end();
      });
    };
    send(url, redirects);
  });
}

/**
 * Потолок файла по его расширению.
 *
 * Видео — это запись встречи, и она весит сотни мегабайт. Всё остальное —
 * снимки и обычные файлы, и для них потолок публичных хостингов остаётся в
 * силе.
 */
function limitForFile(filePath) {
  if (/\.(webm|mp4|mkv|mov|m4v|avi)$/i.test(filePath)) return MAX_VIDEO_UPLOAD;
  return MAX_UPLOAD;
}

/**
 * Отправляет файл на сервер: тело multipart собирается в памяти или уходит
 * потоком, в зависимости от размера файла.
 */
function postFile(url, { headers = {}, fields = {}, fileField = 'file', filePath, filename, timeout = 600000 }) {
  const size = fs.statSync(filePath).size;
  if (size <= STREAM_THRESHOLD) {
    const { body, contentType } = multipart(fields, fileField, filePath, filename);
    return request(url, {
      method: 'POST',
      headers: { 'Content-Type': contentType, 'Content-Length': body.length, ...headers },
      body,
      timeout,
    });
  }
  const { head, tail, length, contentType } = multipartParts(fields, fileField, filePath, filename);
  // Предел времени для потока считается по размеру: запись встречи на
  // гигабайт по домашнему каналу льётся дольше десяти минут, и общий
  // десятиминутный предел рвал бы её на середине. Расчёт — примерно
  // 1,5 секунды на мегабайт, но не меньше десяти минут и не больше двух
  // часов.
  const streamTimeout = Math.min(
    2 * 60 * 60 * 1000,
    Math.max(10 * 60 * 1000, Math.ceil(size / MB) * 1500)
  );
  return requestStream(url, {
    method: 'POST',
    headers: { 'Content-Type': contentType, 'Content-Length': length, ...headers },
    filePath,
    head,
    tail,
    timeout: Math.max(timeout, streamTimeout),
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
  if (!base || !key) return t('own.notFilled');
  let parsed;
  try {
    parsed = new URL(base);
  } catch (e) {
    return t('own.unreadable');
  }
  if (!/^https?:$/i.test(parsed.protocol)) return t('own.notHttp');
  // По http ключ летел бы открытым текстом. Локальный адрес — исключение,
  // там TLS всё равно некуда вешать. Проверяем настоящий loopback, а не
  // начало строки: через «127.» проходил домен 127.attacker.example.
  if (!/^https:$/i.test(parsed.protocol) && !isLoopback(parsed.hostname)) {
    return t('own.needHttps');
  }
  // Node бросает сырое «Invalid character in header content», если в
  // заголовок попал хоть один символ вне ASCII. Проверяем заранее.
  if (/[^\x21-\x7e]/.test(key)) {
    return t('own.keyNotAscii');
  }
  return '';
}

/**
 * Ошибка своего сервера.
 *
 * Помечена, чтобы главный процесс узнал о сбое по факту, а не по совпадению
 * в тексте: текст переводится, и совпадение перестало бы работать.
 */
function ownError(message) {
  const err = new Error(message);
  err.ownServer = true;
  return err;
}

/**
 * Загрузка в свой сервер через API: файл идёт на /v1/uploads с ключом в
 * заголовке, так ключ не попадает ни в access-лог Caddy, ни в ссылку.
 */
async function uploadOwn(host, filePath, onStep = () => {}) {
  const { base_url: base, write_key: key } = host;
  if (!base || !key) {
    onStep(t('upload.ownNotConfigured'));
    return null;
  }
  const why = validateOwn({ base_url: base, write_key: key });
  if (why) throw ownError(t('upload.ownInvalid', { detail: why }));
  const endpoint = base.replace(/\/+$/, '') + '/v1/uploads';

  onStep(t('upload.ownUploading'));
  const res = await postFile(endpoint, {
    headers: { Authorization: 'Bearer ' + key },
    fields: {},
    fileField: 'file',
    filePath,
    filename: path.basename(filePath),
  });

  if (res.status !== 200 && res.status !== 201) {
    // Сервер отвечает JSON: достаём его error, иначе в уведомление уедет
    // обрывок HTML и никакого смысла.
    let detail = res.body.toString('utf8').slice(0, 120);
    try {
      const parsed = JSON.parse(res.body.toString('utf8'));
      if (parsed && parsed.error) detail = parsed.error;
    } catch (e) { /* не JSON — покажем как есть */ }
    if (res.status === 401) throw ownError(t('upload.ownRejectedKey'));
    throw ownError(t('upload.ownHttp', { status: res.status, detail }));
  }

  let meta;
  try {
    meta = JSON.parse(res.body.toString('utf8'));
  } catch (e) {
    // Заглушка прокси с HTML и кодом 200: сырое «Unexpected token '<'» не
    // помечено ownError и не объяснило бы человеку, что произошло.
    throw ownError(t('upload.ownNoUrl'));
  }
  if (!meta || typeof meta.url !== 'string') throw ownError(t('upload.ownNoUrl'));

  onStep(t('upload.ownChecking'));
  // Свой сервер отдаёт файл по прямой ссылке: сравнивать первые байты с
  // нашими бессмысленно, там нужен только размер.
  if (!(await verify(meta.url, fs.statSync(filePath).size, filePath, { own: true }))) {
    throw ownError(t('upload.ownNoFile'));
  }
  // Срок хранения приходит с сервера: ссылка своего сервера не вечна.
  return { url: meta.url, host: 'own', temp: false, expiresAt: meta.expires_at || null };
}

/** Загрузка на один хостинг. */
async function uploadTo(host, filePath) {
  const res = await postFile(host.url, {
    fields: host.fields,
    fileField: host.fileField,
    filePath,
    filename: path.basename(filePath),
  });
  if (res.status !== 200) {
    throw new Error(`HTTP ${res.status}: ${res.body.toString('utf8').slice(0, 80)}`);
  }
  const text = res.body.toString('utf8').trim();
  let url = text;
  if (host.json) {
    try {
      url = pick(JSON.parse(text), host.json);
    } catch (e) {
      url = null; // не JSON: ниже уйдёт в обычную ошибку «нет ссылки»
    }
  }
  if (typeof url !== 'string' || !/^https?:\/\//.test(url)) {
    throw new Error(t('upload.noLinkInResponse', { text: text.slice(0, 80) }));
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

/**
 * Недавно отказавшие хостинги.
 *
 * Мёртвый или заблокированный в этом регионе хостинг отвечает отказом
 * медленно: litterbox на проверке думал больше двадцати секунд. Держать
 * его в цепочке на каждом снимке — значит каждый раз ждать эти секунды.
 * Пять минут хостинг пропускается, потом снова пробуется: блокировки и
 * сбои проходят.
 */
const hostFailures = new Map();
const FAILURE_TTL = 5 * 60 * 1000;



/**
 * Проверяет, что ссылка правда отдаёт наш файл.
 *
 * Сверяются первые PROBE байт, а не размер. Размер сверять нельзя: чтобы его
 * узнать, файл надо скачать целиком, а ссылка может вести на сотни мегабайт.
 * Запрашивается только начало через Range, поэтому проверка стоит копейки и
 * работает для файла любого размера.
 *
 * Размер сверяется, когда сервер его объявил: 206 обязан нести
 * Content-Range, обычный ответ — Content-Length. Если размера не объявлено
 * вовсе (чанковый ответ), отказывать нельзя: ссылка может быть вполне
 * рабочей, и обрывка ради заголовка тут нечего.
 *
 * Отдельный случай — свой сервер: он отдаёт файл по прямой ссылке, и
 * сравнивать первые байты бессмысленно, потому что это ровно те же байты,
 * что лежат на диске. Там достаточно, что сервер отдал файл нужного размера.
 */
async function verify(url, size, filePath, opts = {}) {
  const { own = false } = opts;
  let head = null;
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

    const cr = String(res.headers['content-range'] || '');
    const m = /bytes 0-(\d+)\/(\d+)/.exec(cr);
    const cl = Number(res.headers['content-length']);
    const declared = m ? Number(m[2]) : (Number.isFinite(cl) && cl > 0 ? cl : null);

    // Свой сервер отдаёт файл целиком, и первые байты совпадут с нашими
    // заведомо. Требуем только размер: он доказывает, что файл доехал весь.
    if (own) return declared === null || declared === size;

    const got = res.body.slice(0, head.length);
    if (got.length !== head.length || !head.equals(got)) return false;

    // Совпадения первых байт мало: сервер мог хранить только их, обрезав файл.
    // Если сервер объявил полный размер, он обязан совпасть.
    if (declared !== null) return declared === size;
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
 *
 * Расширение при этом сохраняется: по ссылке с .webm браузер и плеер сразу
 * понимают, что это видео, и не тянут его как текст. Без расширения файл
 * отдавался бы под именем вроде «file», и человек получил бы неопознанный
 * кусок вместо записи встречи.
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
 * Проверка скорости облачных хостингов с этой машины.
 *
 * Задержка до одного и того же хостинга из разных стран разная, и знать её
 * заранее нельзя. Проверка загружает маленький файл в каждый хостинг и
 * возвращает время в миллисекундах: человек видит, что быстрее именно у
 * него, и выбирает сам. Список сортируется по времени, а порядок
 * сохраняется: в режиме «авто» быстрые хостинги пробуются первыми.
 *
 * Проверяется и свой сервер, если он настроен.
 *
 * @returns {Promise<Array<{name:string, ms:number, ok:boolean, error?:string}>>}
 */
async function speedTest({ own = null, order = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'puuush-speed-'));
  // 48 КБ — достаточно, чтобы измерить рукопожатие и первую передачу, и
  // мало, чтобы проверка не занимала полосу надолго.
  const file = path.join(dir, 'speed.png');
  fs.writeFileSync(file, crypto.randomBytes(48 * 1024));
  const results = [];
  try {
    for (const host of orderedHosts(order)) {
      const t0 = Date.now();
      try {
        const url = await uploadTo(host, file);
        // Скорость без проверки ссылки вводила бы в заблуждение: хостинг
        // может принять файл быстро и отдать битую ссылку. Тогда тест ставил
        // его первым, а следующий настоящий снимок уходил в никуда.
        if (!(await verify(url, fs.statSync(file).size, file))) {
          throw new Error(t('upload.hostNoLink', { host: host.name }));
        }
        // Удачный замер снимает прежнюю пятиминутную блокировку: иначе
        // хостинг, уже оживший после сбоя, продолжал бы пропускаться.
        hostFailures.delete(host.name);
        results.push({ name: host.name, ms: Date.now() - t0, ok: true });
      } catch (e) {
        // Неудача замера — такой же сигнал, как неудача настоящей загрузки:
        // не гонять этот хостинг первым следующие пять минут.
        hostFailures.set(host.name, Date.now());
        results.push({ name: host.name, ms: Date.now() - t0, ok: false, error: e.message });
      }
    }
    if (own && own.base_url && own.write_key) {
      const t0 = Date.now();
      try {
        await uploadOwn(own, file, () => {});
        results.push({ name: 'own', ms: Date.now() - t0, ok: true });
      } catch (e) {
        results.push({ name: 'own', ms: Date.now() - t0, ok: false, error: e.message });
      }
    }
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* уберёт система */ }
  }
  return results;
}

/**
 * Кладёт файл наружу.
 *
 * @param {string} filePath путь к файлу
 * @param {object} opts
 * @param {string} [opts.host] 'auto' | 'catbox' | 'pomf2' | 'uguu' | 'own'
 * @param {object} [opts.own] { base_url, write_key }
 * @param {(msg:string)=>void} [opts.onStep]
 * @returns {Promise<{url:string, host:string, temp:boolean, size:number}>}
 */
async function publish(filePath, opts = {}) {
  const { host = 'auto', own = null, onStep = () => {}, maxBytes = 0, order = null } = opts;
  // Причина сбоя своего сервера: по ней главный процесс предупреждает, что
  // файл ушёл в публичный интернет.
  let ownFailed = null;
  if (!fs.existsSync(filePath)) throw new Error(t('upload.noFile', { path: filePath }));
  const st = fs.statSync(filePath);
  // Папка проходит existsSync и падала бы сырым EISDIR на каждом хостинге.
  if (!st.isFile()) throw new Error(t('upload.notFile', { path: filePath }));
  const size = st.size;
  if (!size) throw new Error(t('upload.emptyFile', { path: filePath }));
  // Потолок по умолчанию зависит от того, что за файл. Запись встречи весит
  // сотни мегабайт, и потолок публичных хостингов её не пускает: свой сервер
  // примет столько, сколько настроен.
  const limit = maxBytes || limitForFile(filePath);
  // Файл читается в память целиком и склеивается из чанков, то есть
  // занимает примерно удвоенный объём: 400 МБ файла съедали 880 МБ RAM.
  // Проверка ссылки ниже тянет ещё и сам файл. Потолок отсекает видео,
  // которые всё равно никто не отправит.
  if (size > limit) {
    throw new Error(
      t('upload.tooBig', {
        size: sizeText(size),
        max: sizeText(limit),
      })
    );
  }

  if (host === 'own') {
    if (!own || !own.base_url || !own.write_key) {
      throw ownError(t('upload.ownNeedsSetup'));
    }
    const r = await uploadOwn(own, filePath, onStep);
    if (r) return { ...r, size };
    throw ownError(t('upload.ownNoLink'));
  }

  let chain = orderedHosts(order);
  const single = host !== 'auto';
  if (single) {
    chain = HOSTS.filter((h) => h.name === host);
    if (!chain.length) throw new Error(t('upload.unknownHost', { host }));
  } else if (own && own.base_url && own.write_key) {
    // В авторежиме свой box не имеет права обрывать цепочку: любой его сбой —
    // неверный ключ, битый сервер, опечатка в адресе — должен молча уводить
    // на внешний хостинг, а не ронять всю загрузку.
    onStep(t('upload.tryingOwn'));
    try {
      const r = await uploadOwn(own, filePath, onStep);
      if (r) return { ...r, size, ownFailed: null };
    } catch (e) {
      ownFailed = e.message;
      onStep(t('upload.ownFailed', { error: e.message }));
    }
  }

  const reasons = [];
  let tooBigForAll = true;
  for (const h of chain) {
    const failedAt = hostFailures.get(h.name);
    if (!single && failedAt && Date.now() - failedAt < FAILURE_TTL) {
      // Хостинг недавно отказал: пропускаем, чтобы не ждать его снова.
      reasons.push(t('upload.hostRecentlyFailed', { host: h.name }));
      continue;
    }
    if (h.max && size > h.max) {
      // Файл больше потолка этого хостинга: отправлять его вслепую значит
      // получить отказ после долгой загрузки. Пропускаем и говорим почему.
      const why = t('upload.hostTooSmall', {
        host: h.name,
        max: sizeText(h.max),
        size: sizeText(size),
      });
      onStep(why);
      reasons.push(why);
      continue;
    }
    tooBigForAll = false;
    onStep(t('upload.trying', { host: h.name }));
    let url;
    try {
      url = await uploadTo(h, filePath);
    } catch (e) {
      hostFailures.set(h.name, Date.now());
      onStep(`${h.name}: ${e.message}`);
      reasons.push(`${h.name} — ${e.message}`);
      continue;
    }
    onStep(t('upload.checking', { host: h.name }));
    if (!(await verify(url, size, filePath, { own: false }))) {
      hostFailures.set(h.name, Date.now());
      onStep(t('upload.linkNoFile', { host: h.name }));
      reasons.push(t('upload.hostNoLink', { host: h.name }));
      continue;
    }
    hostFailures.delete(h.name);
    return { url, host: h.name, temp: !!h.temp, size, ownFailed, expiresAt: null };
  }

  if (single) {
    if (tooBigForAll && reasons.length) {
      throw ownError(
        t('upload.tooBigForHost', {
          host,
          size: sizeText(size),
          reasons: reasons.join('; '),
        })
      );
    }
    throw ownError(
      t('upload.noWorkingLink', {
        host,
        reasons: reasons.join('; ') || t('upload.reasonUnknown'),
      })
    );
  }
  throw ownError(
    t('upload.noHostWorked', {
      reasons: reasons.join('; ') || t('upload.reasonUnknown'),
    })
  );
}

module.exports = {
  publish, verify, safeName, HOSTS, orderedHosts, speedTest, sizeText, request, requestStream, postFile,
  uploadTo, uploadOwn, validateOwn, isLoopback,
  MAX_UPLOAD, MAX_VIDEO_UPLOAD,
};

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
module.exports.__setRequestStreamForTests = (fn) => {
  const prev = module.exports.__requestStream;
  module.exports.__requestStream = fn;
  return prev;
};
module.exports.__restoreRequestStreamForTests = (prev) => {
  if (prev === undefined) delete module.exports.__requestStream;
  else module.exports.__requestStream = prev;
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

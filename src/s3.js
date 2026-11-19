'use strict';
/**
 * Подпись запросов AWS Signature Version 4 и правила имён объекта S3.
 *
 * Зависимостей нет намеренно: @aws-sdk/client-s3 тянет за собой десятки
 * мегабайт в собранный установщик, а PUT одного файла требует от подписи
 * только crypto.createHmac и аккуратной канонической формы.
 *
 * Модуль ничего не знает ни об Electron, ни о словарях: он чистый, и тест
 * проверяет его на контрольном примере из документации AWS.
 */

const crypto = require('node:crypto');

const sha256hex = (data) => crypto.createHash('sha256').update(data).digest('hex');
const hmacBuf = (key, data) => crypto.createHmac('sha256', key).update(data).digest();

/**
 * Ключ подписи запроса.
 *
 * Цепочка из документации AWS: секрет -> дата -> регион -> сервис ->
 * «aws4_request». Ошибка на любом звене даёт неверную подпись целиком,
 * поэтому цепочка не раскладывается на настройки.
 */
function signingKey(secretKey, dateStamp, region, service) {
  let key = Buffer.from('AWS4' + secretKey, 'utf8');
  key = hmacBuf(key, dateStamp);
  key = hmacBuf(key, region);
  key = hmacBuf(key, service);
  return hmacBuf(key, 'aws4_request');
}

/**
 * Кодирование пути по правилам S3.
 *
 * encodeURIComponent не кодирует !'()* — SigV4 требует кодировать и их.
 * Слэши целы: кодируются сегменты между ними, а не весь путь.
 */
function uriEncode(text, keepSlashes = true) {
  const enc = (s) =>
    encodeURIComponent(s).replace(
      /[!'()*]/g,
      (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase()
    );
  const str = String(text);
  return keepSlashes ? str.split('/').map(enc).join('/') : enc(str);
}

/**
 * Время подписи: 20261119T063000Z. Секунды обязательны, доли запрещены.
 */
function amzDate(date = new Date()) {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

/**
 * Заголовки подписанного запроса SigV4.
 *
 * Возвращает то, что нужно добавить к запросу: x-amz-date,
 * x-amz-content-sha256 (для S3 он обязателен), Host и Authorization.
 * Секрет никуда не пишется: в заголовке только подпись, поэтому ключ
 * не попадает ни в ссылку, ни в лог прокси перед бакетом.
 *
 * payloadHash — либо sha256 тела в hex, либо «UNSIGNED-PAYLOAD» для
 * большого файла, уходящего потоком: хеш тела, которое не читается
 * целиком, посчитать нельзя, и S3 разрешает так подписывать запросы.
 */
function signedHeaders({
  method,
  url,
  region,
  accessKey,
  secretKey,
  service = 's3',
  payloadHash,
  contentType = '',
  extraHeaders = {},
  date = null,
}) {
  const u = new URL(url);
  const now = date ? amzDate(date) : amzDate();
  const dateStamp = now.slice(0, 8);

  // Канонические заголовки: строчные имена, отсортированные, без пробелов
  // вокруг двоеточия. Host берётся из адреса ровно в том виде, в каком его
  // пошлёт http-клиент: порт в нём, если он нестандартный.
  const canon = { host: u.host };
  if (contentType) canon['content-type'] = contentType;
  // S3 требует подписанный заголовок хеша тела; у других сервисов его нет.
  if (service === 's3') canon['x-amz-content-sha256'] = payloadHash;
  canon['x-amz-date'] = now;
  for (const [name, value] of Object.entries(extraHeaders || {})) {
    canon[String(name).toLowerCase()] = String(value);
  }

  const names = Object.keys(canon).sort();
  const canonicalHeaders = names.map((n) => `${n}:${String(canon[n]).trim()}\n`).join('');
  const signedList = names.join(';');

  // Параметры адреса сортируются по имени: подпись не должна зависеть
  // от того, в каком порядке их собрал клиент.
  const params = [];
  for (const [k, v] of u.searchParams.entries()) {
    params.push([uriEncode(k, false), uriEncode(v, false)]);
  }
  params.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const canonicalQuery = params.map(([k, v]) => `${k}=${v}`).join('&');

  const canonicalRequest = [
    method.toUpperCase(),
    uriEncode(u.pathname),
    canonicalQuery,
    canonicalHeaders,
    signedList,
    payloadHash,
  ].join('\n');

  const scope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', now, scope, sha256hex(canonicalRequest)].join('\n');
  const signature = crypto
    .createHmac('sha256', signingKey(secretKey, dateStamp, region, service))
    .update(stringToSign)
    .digest('hex');

  const out = {
    Host: u.host,
    'x-amz-date': now,
    ...(service === 's3' ? { 'x-amz-content-sha256': payloadHash } : {}),
    ...(contentType ? { 'Content-Type': contentType } : {}),
    Authorization:
      `AWS4-HMAC-SHA256 Credential=${accessKey}/${scope}, ` +
      `SignedHeaders=${signedList}, Signature=${signature}`,
  };
  return out;
}

/**
 * Ключ объекта в бакете: дата, случайный хвост и само имя.
 *
 * Датированная папка держит бакет обозримым, случайные 8 знаков не дают
 * двум файлам с одинаковым именем перезаписать друг друга: имя после
 * транслитерации совпадает у двух разных снимков легко.
 */
function objectKey(safeName, { now = new Date(), rand = null } = {}) {
  const iso = now.toISOString().slice(0, 7); // 2026-11
  const tail = rand || crypto.randomBytes(4).toString('hex');
  return `${iso}/${tail}-${safeName}`;
}

/** Публичный адрес файла: база без хвостового слэша плюс ключ. */
function publicUrl(publicBase, key) {
  return `${String(publicBase).replace(/\/+$/, '')}/${key}`;
}

/**
 * Тип содержимого по расширению.
 *
 * Именно он решает, откроется ли ссылка картинкой в браузере: без
 * Content-Type S3 отдаёт application/octet-stream, и браузер качает
 * файл вместо того, чтобы показать его.
 */
function contentTypeFor(file) {
  const ext = String(file).toLowerCase().match(/\.([a-z0-9]+)$/);
  const byExt = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    bmp: 'image/bmp',
    svg: 'image/svg+xml',
    ico: 'image/x-icon',
    webm: 'video/webm',
    mp4: 'video/mp4',
    mkv: 'video/x-matroska',
    mov: 'video/quicktime',
    m4v: 'video/mp4',
    avi: 'video/x-msvideo',
    mp3: 'audio/mpeg',
    ogg: 'audio/ogg',
    wav: 'audio/wav',
    txt: 'text/plain',
    pdf: 'application/pdf',
  };
  return ext && byExt[ext[1]] ? byExt[ext[1]] : 'application/octet-stream';
}

module.exports = { signedHeaders, uriEncode, amzDate, objectKey, publicUrl, contentTypeFor, sha256hex };

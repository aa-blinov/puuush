 'use strict';
/**
 * Локальная раздача свежих файлов.
 *
 * Ссылка на свой сервер уходит в интернет и живёт по расписанию уборщика.
 * Файл, который человек только что снял, нужен ему сейчас, и ждать минуту
 * ради первых байт не хочется.
 *
 * Поэтому рядом с приложением живёт маленький сервер: он отдаёт последние
 * файлы из папки снимков по короткому адресу вида http://127.0.0.1:PORT/f/ID.
 * Адрес живёт, пока открыто приложение, и отдаёт только то, что приложение
 * само положило в папку.
 *
 * Никаких зависимостей: node:http и ничего больше, как и в настоящем сервере.
 */

const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.gif': 'image/gif', '.webm': 'video/webm',
  '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.mkv': 'video/x-matroska',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.pdf': 'application/pdf',
  '.txt': 'text/plain; charset=utf-8', '.json': 'application/json',
};

function mimeFor(name) {
  return MIME[path.extname(name).toLowerCase()] || 'application/octet-stream';
}

/**
 * Раздача файлов из папки.
 *
 * Имена файлов на диске не годятся в URL: кириллица, пробелы и кавычки
 * требуют экранирования, а человек получит ссылку с процентами. Поэтому
 * каждому файлу выдаётся короткий идентификатор, а он живёт в памяти и
 * умирает вместе с приложением.
 */
class LocalServer {
  constructor({ dir, maxFiles = 50 } = {}) {
    this.dir = dir;
    this.port = 0;
    this.server = null;
    // Раздача живёт в памяти, и без потолка она росла бы весь день: каждый
    // снимок добавляет запись. Старые вытесняются: ссылка на них и так
    // живёт только пока открыто приложение.
    this.maxFiles = maxFiles;
    this.files = new Map(); // id -> { path, name, mime, size }
  }

  /** Кладёт файл в раздачу и отдаёт ссылку. */
  add(filePath) {
    let st;
    try {
      st = fs.statSync(filePath);
    } catch (e) {
      return null;
    }
    if (!st.isFile()) return null;
    const id = crypto.randomBytes(8).toString('hex');
    const name = path.basename(filePath);
    this.files.set(id, {
      path: filePath,
      name,
      mime: mimeFor(name),
      size: st.size,
    });
    while (this.files.size > this.maxFiles) {
      const oldest = this.files.keys().next().value;
      this.files.delete(oldest);
    }
    return { id, url: `http://127.0.0.1:${this.port}/f/${id}` };
  }

  /** Убирает файл из раздачи: он удалён с диска или уехал на сервер. */
  remove(id) {
    this.files.delete(id);
  }

  async listen() {
    this.server = http.createServer((req, res) => this.handle(req, res));
    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(0, '127.0.0.1', resolve);
    });
    this.port = this.server.address().port;
    return this.port;
  }

  async close() {
    if (!this.server) return;
    const server = this.server;
    this.server = null;
    try {
      await new Promise((resolve) => server.close(resolve));
    } catch (e) {
      // Сервер мог уже закрыться вместе с приложением.
    }
    this.files.clear();
  }

  async handle(req, res) {
    const url = new URL(req.url, 'http://127.0.0.1');
    const m = /^\/f\/([0-9a-f]{16})$/.exec(url.pathname);
    if (!m) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('not found');
      return;
    }
    const entry = this.files.get(m[1]);
    if (!entry) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('not found');
      return;
    }
    let st;
    try {
      st = await fsp.stat(entry.path);
    } catch (e) {
      this.files.delete(m[1]);
      res.writeHead(410, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('gone');
      return;
    }
    // Range нужен записи встречи: без него браузер не даёт перемотать
    // видео и скачивает гигабайт заново, чтобы открыть середину. Caddy на
    // своём сервере Range умеет, и локальная ссылка не должна быть хуже.
    const range = String(req.headers.range || '');
    let start = 0;
    let end = st.size - 1;
    let partial = false;
    if (range) {
      const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
      if (!m || (!m[1] && !m[2])) {
        res.writeHead(416, {
          'Content-Range': `bytes */${st.size}`,
          'Content-Length': 0,
        });
        res.end();
        return;
      }
      if (m[1]) {
        start = Number(m[1]);
        if (m[2]) end = Number(m[2]);
      } else {
        // bytes=-500: последние 500 байт.
        const tail = Number(m[2]);
        start = Math.max(0, st.size - tail);
      }
      end = Math.min(end, st.size - 1);
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= st.size) {
        res.writeHead(416, {
          'Content-Range': `bytes */${st.size}`,
          'Content-Length': 0,
        });
        res.end();
        return;
      }
      partial = true;
    }

    const headers = {
      'Content-Type': entry.mime,
      'Content-Length': partial ? end - start + 1 : st.size,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Accept-Ranges': 'bytes',
      // Имя в заголовке: без него браузер сохранит файл под безымянным
      // «download», и человек не найдёт его в папке загрузок.
      'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(entry.name)}`,
    };
    if (partial) headers['Content-Range'] = `bytes ${start}-${end}/${st.size}`;
    res.writeHead(partial ? 206 : 200, headers);
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    fs.createReadStream(entry.path, partial ? { start, end } : undefined).pipe(res);
  }
}

module.exports = { LocalServer };

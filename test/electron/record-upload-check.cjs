'use strict';
/**
 * Проверка полного пути записи: запись экрана со звуком -> файл на диске ->
 * загрузка на свой сервер -> рабочая ссылка.
 *
 * Запись и загрузка проверяются вместе, потому что по отдельности они ничего
 * не говорят: файл может записаться и не уйти, а ссылка может появиться и не
 * отдавать файл.
 *
 *     npm run test:electron
 */
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { app, ipcMain } = require('electron');

const SRC = path.join(__dirname, '..', '..', 'src');
app.on('window-all-closed', () => {});
process.on('unhandledRejection', (e) => {
  console.error('  ПРОВАЛ необработанная ошибка: ' + (e && e.stack ? e.stack : e));
  process.exit(1);
});
setTimeout(() => {
  console.error('  ПРОВАЛ: проверка не уложилась в две минуты');
  process.exit(1);
}, 120000).unref?.();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Раздача файлов, как её делает Caddy на настоящей машине. */
function startCaddy(media) {
  const server = http.createServer((req, res) => {
    const m = /^\/f\/([0-9a-f]{24})\/([^/]+)$/.exec(req.url);
    if (!m) { res.writeHead(404); res.end(); return; }
    const p = path.join(media, m[1], decodeURIComponent(m[2]));
    let st;
    try { st = fs.statSync(p); } catch (e) { res.writeHead(404); res.end(); return; }
    const range = req.headers.range;
    if (range) {
      const mm = /bytes=(\d+)-(\d*)/.exec(range);
      const start = Number(mm[1]);
      const end = mm[2] ? Number(mm[2]) : st.size - 1;
      res.writeHead(206, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': end - start + 1,
        'Content-Range': `bytes ${start}-${end}/${st.size}`,
      });
      fs.createReadStream(p, { start, end }).pipe(res);
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': st.size,
      'Accept-Ranges': 'bytes',
    });
    fs.createReadStream(p).pipe(res);
  });
  return server;
}

app.whenReady().then(async () => {
  const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'puuush-rec-e2e-'));
  app.setPath('userData', ud);
  // Снимки и записи проверок не должны попадать в настоящую папку «Изображения».
  app.setPath('pictures', path.join(app.getPath('userData'), 'Pictures'));

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'puuush-srv-'));
  const media = path.join(dir, 'media');
  fs.mkdirSync(media, { recursive: true });
  const caddy = startCaddy(media);
  await new Promise((r) => caddy.listen(0, '127.0.0.1', r));
  const pub = 'http://127.0.0.1:' + caddy.address().port;

  const cfgPath = path.join(dir, 'config.json');
  fs.writeFileSync(cfgPath, JSON.stringify({
    host: '127.0.0.1', port: 0, dir: media,
    write_key: 'k'.repeat(32), public_base: pub,
    max_bytes: 64 * 1024 * 1024, max_video_bytes: 1024 * 1024 * 1024,
    max_total_bytes: 500 * 1024 * 1024, max_files: 100, keep_days: 30,
  }));
  process.env.PUUUSH_CONFIG = cfgPath;
  const mod = require(path.join(__dirname, '..', '..', 'server', 'index.js'));
  const server = mod.createServer(mod.loadConfig());
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const api = 'http://127.0.0.1:' + server.address().port;

  const store = require(path.join(SRC, 'store.js'));
  const upload = require(path.join(SRC, 'upload.js'));
  const { setLang, t } = require(path.join(SRC, 'i18n.js'));
  const { Recorder, registerRecorderIpc, canCaptureSystemAudio } = require(path.join(SRC, 'recorder.js'));
  setLang('ru');

  let rec = null;
  registerRecorderIpc(() => rec, { t, ipcMain });
  rec = new Recorder({ dir: store.shotsDir(), onStep: () => {} });

  await rec.start({ microphone: true, systemAudio: canCaptureSystemAudio() });
  const done = rec.whenDone();
  await sleep(6000);
  const stopped = await rec.stop();
  const result = await Promise.race([done, sleep(20000).then(() => null)]);

  const ok = stopped && stopped.size > 0 && fs.existsSync(stopped.path);
  console.log(`  ${ok ? 'ОК  ' : 'ПРОВАЛ'} запись экрана: ${ok ? stopped.size + ' байт' : 'файла нет'}`);

  let webm = false;
  if (ok) webm = fs.readFileSync(stopped.path).slice(0, 4).toString('hex') === '1a45dfa3';
  console.log(`  ${webm ? 'ОК  ' : 'ПРОВАЛ'} запись в формате WebM`);

  let sound = false;
  if (ok) sound = fs.readFileSync(stopped.path).includes(Buffer.from('Opus'));
  console.log(`  ${sound ? 'ОК  ' : 'ПРОВАЛ'} в записи есть звуковая дорожка`);

  let uploaded = false;
  let linked = false;
  if (ok) {
    const t0 = Date.now();
    const r = await upload.publish(stopped.path, {
      host: 'own',
      own: { base_url: api, write_key: 'k'.repeat(32) },
    });
    uploaded = !!r.url;
    console.log(`  ${uploaded ? 'ОК  ' : 'ПРОВАЛ'} запись ушла на сервер за ${Date.now() - t0} мс`);
    if (uploaded) {
      const got = await fetch(r.url);
      const buf = Buffer.from(await got.arrayBuffer());
      linked = got.status === 200 && buf.length === stopped.size;
      console.log(`  ${linked ? 'ОК  ' : 'ПРОВАЛ'} ссылка отдаёт запись целиком: ${buf.length} байт`);
    }
  }

  server.close();
  caddy.close();
  app.exit(ok && webm && uploaded && linked ? 0 : 1);
});

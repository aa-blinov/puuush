'use strict';
/**
 * Запись от нажатия до ссылки, через настоящий главный процесс.
 *
 * Проверяет то, чего не видно в проверках самого Recorder: окно настроек
 * начинает запись и сразу получает управление обратно, остановка работает, а
 * файл уходит на свой сервер и попадает в историю.
 *
 *     npm run test:electron
 */
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');

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
  return http.createServer((req, res) => {
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
        'Content-Range': 'bytes ' + start + '-' + end + '/' + st.size,
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
}

app.whenReady().then(async () => {
  const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'puuush-app-rec-'));
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
    max_bytes: 64 * 1024 * 1024, max_video_bytes: 4 * 1024 * 1024 * 1024,
    max_total_bytes: 20 * 1024 * 1024 * 1024, max_files: 100, keep_days: 30,
  }));
  process.env.PUUUSH_CONFIG = cfgPath;
  const mod = require(path.join(__dirname, '..', '..', 'server', 'index.js'));
  const server = mod.createServer(mod.loadConfig());
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const api = 'http://127.0.0.1:' + server.address().port;

  // Настоящий главный процесс: он ставит IPC, трей и хоткеи.
  const main = require(path.join(SRC, 'main.js'));
  await sleep(1200);

  const store = require(path.join(SRC, 'store.js'));
  store.setSettings({
    host: 'own',
    own: { base_url: api, write_key: 'k'.repeat(32) },
    keepLocalCopy: true,
    lang: 'ru',
  });

  const win = main.openSettings();
  await new Promise((r) => win.webContents.once('did-finish-load', r));
  await sleep(500);
  const settingsTitleOk = win.getTitle() === 'puuush — настройки';
  console.log('  ' + (settingsTitleOk ? 'ОК  ' : 'ПРОВАЛ') + ' системный заголовок настроек: ' + win.getTitle());
  const call = (code) => win.webContents.executeJavaScript(code, true);
  const nativeChromeOk = win.getBounds().height > win.getContentBounds().height && !win.isKiosk();
  const nameOk = app.getName() === 'puuush';
  const windowChromeOk = win.isResizable() && !win.isMenuBarVisible() &&
    win.isMinimizable() && win.isMaximizable() && nativeChromeOk && nameOk;
  console.log('  ' + (win.isResizable() ? 'ОК  ' : 'ПРОВАЛ') + ' окно настроек меняет размер');
  console.log('  ' + (!win.isMenuBarVisible() ? 'ОК  ' : 'ПРОВАЛ') + ' нативное меню не выглядывает');
  console.log('  ' + (win.isMinimizable() && win.isMaximizable() ? 'ОК  ' : 'ПРОВАЛ') + ' кнопки окна доступны');
  console.log('  ' + (nativeChromeOk ? 'ОК  ' : 'ПРОВАЛ') + ' нативная рамка Electron с рамкой и кнопками Windows: ' + JSON.stringify({ bounds: win.getBounds(), content: win.getContentBounds() }));
  console.log('  ' + (nameOk ? 'ОК  ' : 'ПРОВАЛ') + ' приложение называется puuush: ' + app.getName());

  const t0 = Date.now();
  await call('window.puuush.startRecording()');
  const readyMs = Date.now() - t0;
  console.log('  ' + (readyMs < 8000 ? 'ОК  ' : 'ПРОВАЛ') + ' начало записи вернулось за ' + readyMs + ' мс');

  // Пока запись идёт: иконка трея мигает, рамка и панель открыты.
  const live = main.runtimeState();
  console.log('  ' + (live.trayBlinking ? 'ОК  ' : 'ПРОВАЛ') + ' иконка трея мигает во время записи');
  console.log('  ' + (live.chromeWindows === 2 ? 'ОК  ' : 'ПРОВАЛ') + ' рамка и панель открыты: ' + live.chromeWindows + ' окна');

  await sleep(5000);
  const t1 = Date.now();
  await call('window.puuush.stopRecording()');
  const stopMs = Date.now() - t1;
  console.log('  ' + (stopMs < 30000 ? 'ОК  ' : 'ПРОВАЛ') + ' остановка вернулась за ' + stopMs + ' мс');

  let entry = null;
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    entry = store.getHistory().find((h) =>
      /\.webm/.test(String(h.file || '')) || /\.webm/.test(String(h.url || '')));
    if (entry) break;
    await sleep(500);
  }
  console.log('  ' + (entry ? 'ОК  ' : 'ПРОВАЛ') + ' запись попала в историю' + (entry ? ': ' + entry.url : ''));

  let fetched = false;
  if (entry) {
    const res = await fetch(entry.url);
    const size = (await res.arrayBuffer()).byteLength;
    const onDisk = entry.file && fs.existsSync(entry.file) ? fs.statSync(entry.file).size : -1;
    fetched = res.status === 200 && size > 0 && size === onDisk;
    console.log('  ' + (fetched ? 'ОК  ' : 'ПРОВАЛ') + ' ссылка отдаёт запись целиком: ' + res.status + ', ' + size + ' байт');
  }


  // Куда девать запись: только на диск, без ссылки и без загрузки.
  store.setSettings({ videoMode: 'disk' });
  const filesBefore = new Set(fs.readdirSync(store.shotsDir()).filter((f) => f.endsWith('.webm')));
  await call('window.puuush.startRecording()');
  await sleep(2500);
  await call('window.puuush.stopRecording()');
  const deadlineDisk = Date.now() + 20000;
  let saved = null;
  while (Date.now() < deadlineDisk) {
    const fresh = fs.readdirSync(store.shotsDir())
      .filter((f) => f.endsWith('.webm') && !filesBefore.has(f));
    saved = fresh.length ? fresh[0] : null;
    if (saved) break;
    await sleep(400);
  }
  const savedSize = saved ? fs.statSync(path.join(store.shotsDir(), saved)).size : 0;
  const diskState = main.runtimeState();
  const historyDeadline = Date.now() + 10000;
  let historyAfterDisk = store.getHistory();
  let diskEntry = null;
  while (saved && Date.now() < historyDeadline) {
    diskEntry = historyAfterDisk.find((item) => path.basename(item.file || '') === saved);
    if (diskEntry) break;
    await sleep(200);
    historyAfterDisk = store.getHistory();
  }
  console.log('  ' + (saved && savedSize > 0 ? 'ОК  ' : 'ПРОВАЛ') + ' запись только на диск: файл на месте' + (saved ? ': ' + saved + ', ' + savedSize + ' байт' : ''));
  console.log('  ' + (diskEntry && !diskEntry.url ? 'ОК  ' : 'ПРОВАЛ') + ' локальная запись появилась в истории без ссылки' + (!diskEntry ? ': ' + JSON.stringify(historyAfterDisk[0]) : ''));
  console.log('  ' + (!diskState.recording && !diskState.trayBlinking && diskState.chromeWindows === 0 ? 'ОК  ' : 'ПРОВАЛ') + ' после остановки трей и рамка вернулись в покой');

  await call('window.puuush.openGallery()');
  const galleryDeadline = Date.now() + 10000;
  let gallery = null;
  while (Date.now() < galleryDeadline) {
    gallery = BrowserWindow.getAllWindows().find((candidate) => candidate !== win);
    if (gallery) break;
    await sleep(100);
  }
  let galleryVideo = null;
  if (gallery) {
    if (gallery.webContents.isLoading()) await new Promise((r) => gallery.webContents.once('did-finish-load', r));
    const videoDeadline = Date.now() + 8000;
    while (Date.now() < videoDeadline) {
      galleryVideo = await gallery.webContents.executeJavaScript(`(function () {
        var cards = Array.from(document.querySelectorAll('article'));
        var card = cards.find(function (item) { return (item.textContent || '').includes(${JSON.stringify(saved || '')}); });
        var video = card && card.querySelector('video');
        var header = document.querySelector('header');
        var actions = header && header.querySelector(':scope > div:last-child');
        var headerRect = header && header.getBoundingClientRect();
        var actionsRect = actions && actions.getBoundingClientRect();
        return {
          found: !!card,
          video: !!video,
          controls: !!(video && video.controls),
          src: video ? video.currentSrc : '',
          actionsRight: !!(headerRect && actionsRect && actionsRect.right >= headerRect.right - 1),
          dots: document.body.innerText.includes('·') || document.querySelectorAll('.rounded-full').length > 0
        };
      })()`);
      if (galleryVideo && galleryVideo.video && galleryVideo.src) break;
      await sleep(200);
    }
  }
  const galleryNativeFrame = !!(gallery &&
    gallery.getBounds().height > gallery.getContentBounds().height &&
    !gallery.isMenuBarVisible() && gallery.getTitle().startsWith('puuush'));
  const galleryTitleOk = !!(gallery && gallery.getTitle() === 'puuush — Gallery');
  console.log('  ' + (galleryNativeFrame ? 'ОК  ' : 'ПРОВАЛ') + ' галерея использует системную рамку и заголовок: ' +
    JSON.stringify(gallery && { title: gallery.getTitle(), bounds: gallery.getBounds(), content: gallery.getContentBounds() }));
  console.log('  ' + (galleryTitleOk ? 'ОК  ' : 'ПРОВАЛ') + ' системный заголовок галереи локализован: ' + (gallery && gallery.getTitle()));
  console.log('  ' + (galleryVideo && galleryVideo.actionsRight ? 'ОК  ' : 'ПРОВАЛ') + ' кнопка галереи стоит справа');
  const galleryPlayback = !!(galleryVideo && galleryVideo.found && galleryVideo.video &&
    galleryVideo.controls && /^http:\/\/127\.0\.0\.1:\d+\/f\//.test(galleryVideo.src));
  console.log('  ' + (galleryPlayback ? 'ОК  ' : 'ПРОВАЛ') + ' локальная запись сразу появилась в галерее с видеоплеером: ' + JSON.stringify(galleryVideo));
  console.log('  ' + (galleryVideo && galleryVideo.dots === false ? 'ОК  ' : 'ПРОВАЛ') + ' в галерее нет декоративных точек');

  await new Promise((r) => server.close(r));
  await new Promise((r) => caddy.close(r));
  app.exit(windowChromeOk && readyMs < 8000 && stopMs < 30000 && entry && fetched && galleryPlayback ? 0 : 1);
});

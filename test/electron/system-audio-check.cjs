'use strict';
/**
 * Проверка системного звука отдельно от микрофона.
 *
 * Обычная проверка записи берёт микрофон, поэтому дорожка Opus в файле ещё
 * ничего не говорит о loopback. Здесь микрофон выключен: если Opus всё равно
 * есть, значит Chromium действительно отдал звук вывода системы.
 *
 * На системах без loopback (не Windows) проверка честно пропускается:
 * приложение там обещает только микрофон.
 *
 *     npm run test:electron
 */
const fs = require('node:fs');
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

app.whenReady().then(async () => {
  const { canCaptureSystemAudio, Recorder, registerRecorderIpc } = require(path.join(SRC, 'recorder.js'));
  if (!canCaptureSystemAudio()) {
    console.log('  ПРОПУСК системный звук доступен только на Windows');
    app.exit(0);
    return;
  }

  const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'puuush-sysaudio-'));
  app.setPath('userData', ud);
  // Снимки и записи проверок не должны попадать в настоящую папку «Изображения».
  app.setPath('pictures', path.join(app.getPath('userData'), 'Pictures'));
  const store = require(path.join(SRC, 'store.js'));
  const { setLang, t } = require(path.join(SRC, 'i18n.js'));
  setLang('ru');

  let rec = null;
  registerRecorderIpc(() => rec, { t, ipcMain });
  rec = new Recorder({ dir: store.shotsDir(), onStep: () => {} });

  await rec.start({ microphone: false, systemAudio: true });
  const info = rec.audioInfo || {};
  const mixed = info.audioTracks === 1 && info.mixed === true && info.audioSources === 1 &&
    info.microphone === false && info.systemAudio === true;
  console.log(`  ${mixed ? 'ОК  ' : 'ПРОВАЛ'} loopback сведён в одну дорожку`);
  const done = rec.whenDone();
  await sleep(3000);
  const stopped = await rec.stop();
  const result = await Promise.race([done, sleep(15000).then(() => null)]);

  const ok = !!(stopped && stopped.size > 0 && fs.existsSync(stopped.path));
  console.log(`  ${ok ? 'ОК  ' : 'ПРОВАЛ'} запись без микрофона: ${ok ? stopped.size + ' байт' : 'файла нет'}`);

  let audio = false;
  if (ok) {
    const all = fs.readFileSync(stopped.path);
    audio = all.includes(Buffer.from('Opus'));
  }
  console.log(`  ${audio ? 'ОК  ' : 'ПРОВАЛ'} системный звук попал в запись`);

  if (ok) {
    try { fs.rmSync(path.dirname(stopped.path), { recursive: true, force: true }); } catch (e) {}
  }
  app.exit(ok && audio && mixed ? 0 : 1);
});

 'use strict';
/**
 * Проверка записи экрана: настоящий MediaRecorder, настоящий поток экрана,
 * настоящий файл на диске.
 *
 * Запись проверяется по трём признакам: файл создан, он непустой и это
 * настоящий WebM (сигнатура EBML 1a45dfa3). Раньше запись проверять было
 * нечем: кода записи не было.
 *
 *     npm run test:electron
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, ipcMain, screen } = require('electron');

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
  const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'puuush-rec-'));
  app.setPath('userData', ud);
  // Снимки и записи проверок не должны попадать в настоящую папку «Изображения».
  app.setPath('pictures', path.join(app.getPath('userData'), 'Pictures'));
  const store = require(path.join(SRC, 'store.js'));
  const { setLang, t } = require(path.join(SRC, 'i18n.js'));
  const { Recorder, registerRecorderIpc, canCaptureSystemAudio } = require(path.join(SRC, 'recorder.js'));
  setLang('ru');

  let rec = null;
  registerRecorderIpc(() => rec, { t, ipcMain });
  rec = new Recorder({ dir: store.shotsDir(), onStep: () => {} });

  const started = Date.now();
  // Начало записи возвращается сразу: ждать её конца вызов не должен,
  // иначе кнопка в настройках висела бы весь час.
  const displays = screen.getAllDisplays();
  const chosen = displays[displays.length - 1];
  const systemAudio = canCaptureSystemAudio();
  await rec.start({ microphone: true, systemAudio, displayId: chosen.id });
  const readyMs = Date.now() - started;
  console.log(`  ${readyMs < 8000 ? 'ОК  ' : 'ПРОВАЛ'} запись началась за ${readyMs} мс`);
  const layout = rec.describe().layout;
  console.log(`  ${layout.displays.length === 1 && String(layout.displays[0].id) === String(chosen.id) ? 'ОК  ' : 'ПРОВАЛ'} выбранный экран попал в запись`);

  const info = rec.audioInfo || {};
  const sourcesWanted = systemAudio ? 2 : 1;
  const audioOk = info.audioTracks === 1 && info.mixed === true &&
    info.audioSources === sourcesWanted && info.microphone === true &&
    (systemAudio ? info.systemAudio === true : info.systemAudio === false);
  console.log(`  ${audioOk ? 'ОК  ' : 'ПРОВАЛ'} звук сведён в одну дорожку: ${info.audioSources || 0} источника, mixed=${info.mixed}`);

  const done = rec.whenDone();
  await sleep(6000);
  const stopped = await rec.stop();
  const result = await Promise.race([
    done,
    sleep(15000).then(() => null),
  ]);

  const ok = stopped && stopped.size > 0 && fs.existsSync(stopped.path);
  console.log(`  ${ok ? 'ОК  ' : 'ПРОВАЛ'} запись экрана: ${ok ? stopped.size + ' байт' : 'файла нет'}`);

  // Настоящий WebM начинается с EBML-сигнатуры.
  let webm = false;
  if (ok) {
    const head = fs.readFileSync(stopped.path).slice(0, 4).toString('hex');
    webm = head === '1a45dfa3';
  }
  console.log(`  ${webm ? 'ОК  ' : 'ПРОВАЛ'} файл записи в формате WebM`);

  // Дорожка звука: запись встречи без звука не годится.
  let audio = false;
  if (ok) {
    const all = fs.readFileSync(stopped.path);
    audio = all.includes(Buffer.from('Opus'));
  }
  console.log(`  ${audio ? 'ОК  ' : 'ПРОВАЛ'} в записи есть звуковая дорожка`);

  console.log(`  запись заняла ${Math.round((Date.now() - started) / 1000)} с`);
  app.exit(ok && webm && audioOk && readyMs < 8000 ? 0 : 1);
});

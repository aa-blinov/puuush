'use strict';
/**
 * Рамка и панель записи: то, чего раньше не было вовсе.
 *
 * Проверяет, что рамка появляется на записываемом экране, панель показывает
 * время и меняет кнопку на паузе, что рамка не попадает в запись и что
 * панель не забирает фокус. Пауза проверяется на настоящем MediaRecorder:
 * время не растёт, пока запись стоит.
 *
 *     npm run test:electron
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, desktopCapturer, screen, BrowserWindow } = require('electron');

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
let failed = 0;
const say = (ok, text) => {
  if (!ok) failed += 1;
  console.log('  ' + (ok ? 'ОК  ' : 'ПРОВАЛ') + ' ' + text);
};

/** Сколько процентов пикселей отличаются между двумя кадрами. */
function diffRatio(a, b) {
  if (a.length !== b.length) return 1;
  let changed = 0;
  for (let i = 0; i < a.length; i += 4) {
    const d = Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
    if (d > 36) changed += 1;
  }
  return changed / (a.length / 4);
}

/**
 * Красные точки у самого края кадра.
 *
 * Если рамка попала в захват, по периметру идёт непрерывная красная линия.
 * Считаем только левую, правую и нижнюю полосы: сверху по центру висит
 * плашка, и её точка не должна считаться промахом.
 */
function countRedBand(bitmap, width, height) {
  let hits = 0;
  const isRed = (i) => {
    const r = bitmap[i];
    const g = bitmap[i + 1];
    const b = bitmap[i + 2];
    return r > 150 && g < 110 && b < 110 && r - g > 60;
  };
  const band = 3;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const nearSide = x < band || x >= width - band || y >= height - band;
      if (!nearSide) continue;
      if (isRed((y * width + x) * 4)) hits += 1;
    }
  }
  return hits;
}

/** Кадр экрана в сырых пикселях через настоящий захват. */
async function grab() {
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: 480, height: 270 },
    fetchWindowIcons: false,
  });
  const img = sources[0].thumbnail;
  return img.toBitmap();
}

app.whenReady().then(async () => {
  const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'puuush-chrome-'));
  app.setPath('userData', ud);
  // Снимки и записи проверок не должны попадать в настоящую папку «Изображения».
  app.setPath('pictures', path.join(app.getPath('userData'), 'Pictures'));
  const store = require(path.join(SRC, 'store.js'));
  const { setLang, t } = require(path.join(SRC, 'i18n.js'));
  const { Recorder, registerRecorderIpc } = require(path.join(SRC, 'recorder.js'));
  const { Recorder: _R } = require(path.join(SRC, 'recorder.js'));
  const { RecordingChrome } = require(path.join(SRC, 'recording-chrome.js'));
  const { ipcMain } = require('electron');
  setLang('ru');

  let rec = null;
  registerRecorderIpc(() => rec, { t, ipcMain });
  rec = new Recorder({ dir: store.shotsDir(), onStep: () => {} });

  // Рамка: появляется на записываемом экране, панель — на нём же.
  const actions = [];
  const chrome = new RecordingChrome({ lang: 'ru', onAction: (name) => actions.push(name) });
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  chrome.show([display]);
  await sleep(900);

  say(chrome.frames.length === 1, 'рамка открылась на записываемом экране');
  say(!!chrome.panel && !chrome.panel.isDestroyed(), 'панель записи открылась');

  const frame = chrome.frames[0];
  const bounds = frame.getBounds();
  console.log('    экран: ' + JSON.stringify(display.bounds) + ', окно: ' + JSON.stringify(bounds));
  say(
    bounds.x === display.bounds.x && bounds.y === display.bounds.y &&
      bounds.width === display.bounds.width && bounds.height === display.bounds.height,
    'рамка стоит ровно по краю выбранного экрана'
  );
  say(frame.isAlwaysOnTop(), 'рамка поверх остальных окон');
  say(
    typeof frame.isContentProtected === 'function' ? frame.isContentProtected() : true,
    'рамка исключена из захвата экрана'
  );

  // Панель показывает время и переключает иконку на паузе.
  chrome.update('paused', 75_000);
  await sleep(400);
  const panel = chrome.panel.webContents;
  const text = await panel.executeJavaScript('document.getElementById("time").textContent', true);
  const pausedClass = await panel.executeJavaScript('document.body.classList.contains("paused")', true);
  say(text === '01:15', 'панель показывает время записи: ' + text);
  say(pausedClass === true, 'панель показывает паузу');

  const frameLabel = await frame.webContents.executeJavaScript(
    'document.getElementById("label").textContent', true
  );
  say(/пауза/i.test(frameLabel), 'на рамке написано «пауза»: ' + frameLabel);

  chrome.update('recording', 0);
  await sleep(300);
  const frameLabel2 = await frame.webContents.executeJavaScript(
    'document.getElementById("label").textContent', true
  );
  say(/запись/i.test(frameLabel2), 'на рамке снова «запись»: ' + frameLabel2);

  // Кнопка паузы на панели шлёт команду в главный процесс.
  await panel.executeJavaScript('document.getElementById("toggle").click()', true);
  await panel.executeJavaScript('document.getElementById("stop").click()', true);
  await sleep(200);
  say(actions.join(',') === 'pause,stop', 'кнопки панели шлют пауза и стоп: ' + actions.join(','));

  // Рамка не должна попадать в запись: у самого края захвата нет красной
  // линии. Сравнение двух кадров подряд шумит, потому что рабочий стол
  // меняется, поэтому смотрим прямо на полосу по краям.
  chrome.update('recording', 0);
  await sleep(400);
  const frameShot = await grab();
  const redBand = countRedBand(frameShot, 480, 270);
  say(redBand < 30, 'рамка не попадает в захват экрана: красных точек у края ' + redBand);
  chrome.hide();
  await sleep(200);
  // Пауза настоящей записи: время стоит, куски не идут.
  const rec2 = new Recorder({ dir: store.shotsDir(), onStep: () => {} });
  rec = rec2;
  await rec2.start({ microphone: false, systemAudio: false, displayId: display.id });
  await sleep(1500);
  const before = rec2.elapsedMs();
  rec2.pause();
  await sleep(1500);
  const during = rec2.elapsedMs();
  rec2.resume();
  await sleep(1200);
  const after = rec2.elapsedMs();
  say(during - before < 250, 'на паузе время записи не растёт: ' + (during - before) + ' мс за 1.5 с');
  say(after > during, 'после продолжения время снова идёт: +' + (after - during) + ' мс');
  const file = await rec2.stop();
  say(!!file && fs.existsSync(file.path) && file.size > 0, 'запись с паузой сохранилась файлом');

  say(BrowserWindow.getAllWindows().length === 0, 'после остановки окон записи не осталось');

  app.exit(failed ? 1 : 0);
});

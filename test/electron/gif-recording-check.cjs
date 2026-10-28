'use strict';
/**
 * GIF и запись области: два режима, которых раньше не было.
 *
 * GIF проверяется разбором файла: заголовок, число кадров, концевой байт.
 * Разбор идёт по структуре блоков, а не поиском байта 0x2c: этот байт
 * встречается и внутри сжатых данных, и подсчёт по нему врёт.
 *
 *     npm run test:electron
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, screen } = require('electron');

const SRC = path.join(__dirname, '..', '..', 'src');
app.on('window-all-closed', () => {});
process.on('unhandledRejection', (e) => {
  console.error('  ПРОВАЛ необработанная ошибка: ' + (e && e.stack ? e.stack : e));
  process.exit(1);
});
setTimeout(() => {
  console.error('  ПРОВАЛ: проверка не уложилась в три минуты');
  process.exit(1);
}, 180000).unref?.();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const say = (ok, text) => {
  if (!ok) failed += 1;
  console.log('  ' + (ok ? 'ОК  ' : 'ПРОВАЛ') + ' ' + text);
};

/** Сколько кадров в GIF и чем файл заканчивается. */
function readGif(buf) {
  const head = buf.subarray(0, 6).toString('ascii');
  let p = 6;
  const width = buf.readUInt16LE(p);
  const height = buf.readUInt16LE(p + 2);
  const packed = buf[p + 4];
  p += 7;
  if (packed & 0x80) p += 3 * (1 << ((packed & 7) + 1));
  let frames = 0;
  let trailing = 0;
  const delays = [];
  while (p < buf.length) {
    const b = buf[p];
    if (b === 0x3b) { trailing = buf.length - p; break; }
    if (b === 0x21) {
      // Графическое управление хранит задержку кадра в сотых секунды.
      // Она нужна, чтобы проверить не только факт записи, но и частоту.
      if (buf[p + 1] === 0xf9 && buf[p + 2] === 4) delays.push(buf.readUInt16LE(p + 4));
      // Расширение: метка, затем подблоки.
      p += 2;
      while (p < buf.length && buf[p] !== 0) p += buf[p] + 1;
      p += 1;
      continue;
    }
    if (b === 0x2c) {
      frames += 1;
      const local = buf[p + 9];
      p += 10;
      if (local & 0x80) p += 3 * (1 << ((local & 7) + 1));
      p += 1; // минимальный размер кода
      while (p < buf.length && buf[p] !== 0) p += buf[p] + 1;
      p += 1;
      continue;
    }
    throw new Error('неизвестный блок GIF: ' + b + ' на смещении ' + p);
  }
  return { head, width, height, frames, trailing, delays };
}

app.whenReady().then(async () => {
  const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'puuush-gif-'));
  app.setPath('userData', ud);
  app.setPath('pictures', path.join(ud, 'Pictures'));
  const store = require(path.join(SRC, 'store.js'));
  const { setLang, t } = require(path.join(SRC, 'i18n.js'));
  const { Recorder, registerRecorderIpc } = require(path.join(SRC, 'recorder.js'));
  const { ipcMain } = require('electron');
  setLang('ru');

  let rec = null;
  registerRecorderIpc(() => rec, { t, ipcMain });
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());

  // 1. Область: кадр должен быть ровно её размера.
  rec = new Recorder({ dir: store.shotsDir(), onStep: () => {} });
  const region = { x: 80, y: 60, width: 640, height: 360 };
  await rec.start({ microphone: false, systemAudio: false, displayId: display.id, region });
  const layout = rec.describe().layout;
  say(layout.canvas.width === 640 && layout.canvas.height === 360,
    'кадр записи равен выбранной области: ' + layout.canvas.width + 'x' + layout.canvas.height);
  const bounds = rec.frameBounds()[0];
  say(bounds.x === display.bounds.x + 80 && bounds.y === display.bounds.y + 60 &&
    bounds.width === 640 && bounds.height === 360,
    'рамка встала по краю области: ' + JSON.stringify(bounds));
  await sleep(1200);
  const areaFile = await rec.stop();
  say(!!areaFile && areaFile.size > 0, 'запись области сохранилась: ' + (areaFile ? areaFile.size + ' байт' : 'нет'));

  // 2. GIF: настоящий файл, настоящие кадры.
  rec = new Recorder({ dir: store.shotsDir(), onStep: (m) => console.log('    шаг: ' + m) });
  const started = Date.now();
  await rec.start({ microphone: true, systemAudio: false, displayId: display.id, format: 'gif' });
  rec.win.webContents.on('console-message', (e) => {
    const line = e && e.message ? e.message : '';
    if (line) console.log('    страница: ' + line);
  });
  await sleep(4000);
  const gifFile = await rec.stop();
  const took = Date.now() - started;
  say(!!gifFile && /\.gif$/.test(gifFile.path), 'GIF записан в файл .gif');
  if (gifFile) {
    const buf = fs.readFileSync(gifFile.path);
    const info = readGif(buf);
    say(info.head === 'GIF89a', 'файл начинается с GIF89a');
    say(info.frames >= 4, 'в GIF ' + info.frames + ' кадров за ' + Math.round(took / 1000) + ' с');
    say(info.trailing === 1, 'файл закрыт концевым байтом');
    say(info.width > 0 && info.height > 0, 'размер кадра в файле: ' + info.width + 'x' + info.height);
    say(info.width <= 1600, 'ширина не больше предела кодировщика: ' + info.width);
    // Файл не должен быть пустым набором кадров: один кадр на четыре секунды
    // означал бы, что кодировщик не успевает вовсе.
    say(buf.length / Math.max(1, info.frames) > 200, 'кадры не пустые: ' + Math.round(buf.length / Math.max(1, info.frames)) + ' байт на кадр');
  }

  // 3. Частота 60: второй размер кадра и чередование задержек 1/2 сотой.
  // GIF хранит время в сотых, поэтому ровные 60 кадров требуют именно
  // такого чередования: два кадра по 2 и один по 1 в среднем дают 1,67.
  rec = new Recorder({ dir: store.shotsDir(), onStep: () => {} });
  await rec.start({ microphone: false, systemAudio: false, displayId: display.id, format: 'gif', fps: 60 });
  await sleep(2500);
  const fastFile = await rec.stop();
  say(!!fastFile && /\.gif$/.test(fastFile.path), 'GIF на 60 кадрах записан');
  if (fastFile) {
    const fast = readGif(fs.readFileSync(fastFile.path));
    say(fast.width <= 960, 'на 60 кадрах ширина ограничена 960: ' + fast.width);
    say(fast.delays.some((d) => d <= 2), 'задержка кадров соответствует высокой частоте: ' + fast.delays.slice(0, 6).join(', '));
    say(fast.frames >= 20, 'кадры на 60-й частоте идут: ' + fast.frames + ' за 2,5 с');
  }

  app.exit(failed ? 1 : 0);
});

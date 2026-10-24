/**
 * Рамка тянется настоящей мышью, а не синтетическими событиями страницы.
 *
 * Прежние проверки слали MouseEvent прямо в страницу и обходили нативное
 * перетаскивание: на Windows протяжка по картинке-подложке превращалась в
 * drag картинки, mousemove и mouseup пропадали, и выбор области мышью не
 * работал вовсе, только пробел. sendInputEvent идёт через тот же путь, что и
 * настоящий ввод.
 *
 * Запуск: npm run test:electron
 */
const path = require('path');
const { app, BrowserWindow, ipcMain, nativeImage } = require('electron');
const SRC = path.join(__dirname, '..', '..', 'src');
app.on('window-all-closed', () => {});
process.on('unhandledRejection', (e) => {
  console.error('  ПРОВАЛ необработанная ошибка: ' + (e && e.message ? e.message : e));
  process.exit(1);
});
setTimeout(() => {
  console.error('  ПРОВАЛ: проверка не уложилась в две минуты');
  process.exit(1);
}, 120000).unref?.();

const W = 1000, H = 700;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  const frame = nativeImage.createFromDataURL('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==').resize({ width: W, height: H });
  const w = new BrowserWindow({
    width: W, height: H, show: false, frame: false, transparent: true,
    webPreferences: { preload: path.join(SRC, 'preload-overlay.js'), contextIsolation: true },
  });
  w.loadFile(path.join(SRC, 'renderer', 'overlay.html'));
  await new Promise((r) => w.once('ready-to-show', r));
  w.show();
  w.webContents.send('puuush:frame', { dataUrl: frame.toDataURL(), width: W, height: H });
  await sleep(800);

  const wc = w.webContents;
  const mouse = (type, x, y) => wc.sendInputEvent({ type, x, y, button: 'left', clickCount: 1 });
  mouse('mouseDown', 100, 100);
  // Ход мыши шагами: нативный drag стартует после нескольких пикселей смещения.
  for (let i = 1; i <= 20; i++) { mouse('mouseMove', 100 + i * 15, 100 + i * 10); await sleep(20); }
  mouse('mouseUp', 400, 300);
  await sleep(300);

  const got = new Promise((r) => ipcMain.once('puuush:region', (_e, v) => r(v)));
  wc.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' });
  const rect = await Promise.race([got, sleep(3000).then(() => 'нет ответа')]);

  const ok = rect && rect.width === 300 && rect.height === 200;
  console.log('  ' + (ok ? 'ОК   ' : 'ПРОВАЛ') + ' протяжка настоящей мышью: ' + JSON.stringify(rect));
  app.exit(ok ? 0 : 1);
});

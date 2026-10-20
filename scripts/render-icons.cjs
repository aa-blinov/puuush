/**
 * Растеризует иконки из assets/*.svg в PNG, ICO и ICNS.
 *
 * Источник правды — SVG. PNG рисуются через canvas в скрытом окне Electron:
 * прозрачность сохраняется, а результат не зависит от композитора системы.
 * ICO и ICNS собираются здесь же, из тех же PNG.
 *
 *     npm run icons
 */
const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');

const ASSETS = path.join(__dirname, '..', 'assets');

// Какие размеры нужны каждому выходу. Порядок совпадает с прежним генератором.
const APP_SIZES = [1024, 512, 256, 128, 64, 48, 32];
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];
const ICNS_MAP = [
  ['icp4', 16], ['icp5', 32], ['icp6', 64], ['ic07', 128], ['ic08', 256],
  ['ic09', 512], ['ic10', 1024], ['ic11', 32], ['ic12', 64], ['ic13', 256], ['ic14', 512],
];

function ico(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let offset = 6 + 16 * images.length;
  const entries = [];
  const blobs = [];
  for (const { size, png } of images) {
    const e = Buffer.alloc(16);
    e[0] = size >= 256 ? 0 : size;
    e[1] = size >= 256 ? 0 : size;
    e.writeUInt16LE(1, 4);
    e.writeUInt16LE(32, 6);
    e.writeUInt32LE(png.length, 8);
    e.writeUInt32LE(offset, 12);
    entries.push(e);
    blobs.push(png);
    offset += png.length;
  }
  return Buffer.concat([header, ...entries, ...blobs]);
}

function icns(images) {
  const parts = images.map(({ type, png }) => {
    const h = Buffer.alloc(8);
    h.write(type, 0, 4, 'ascii');
    h.writeUInt32BE(png.length + 8, 4);
    return Buffer.concat([h, png]);
  });
  const body = Buffer.concat(parts);
  const head = Buffer.alloc(8);
  head.write('icns', 0, 4, 'ascii');
  head.writeUInt32BE(body.length + 8, 4);
  return Buffer.concat([head, body]);
}

/** Возвращает { size: Buffer(PNG) } для каждого размера из svg-файла. */
async function rasterize(win, svgFile, sizes) {
  const svg64 = fs.readFileSync(svgFile).toString('base64');
  const html = `<body style="margin:0;background:transparent">
    <img id="i" src="data:image/svg+xml;base64,${svg64}"></body>`;
  await win.loadURL('data:text/html;base64,' + Buffer.from(html).toString('base64'));
  const urls = await win.webContents.executeJavaScript(`(async () => {
    const img = document.getElementById('i');
    await img.decode();
    const out = {};
    for (const s of ${JSON.stringify(sizes)}) {
      const c = document.createElement('canvas');
      c.width = s;
      c.height = s;
      const ctx = c.getContext('2d');
      ctx.clearRect(0, 0, s, s);
      ctx.drawImage(img, 0, 0, s, s);
      out[s] = c.toDataURL('image/png');
    }
    return out;
  })()`, true);
  const result = {};
  for (const [size, url] of Object.entries(urls)) {
    result[size] = Buffer.from(url.split(',')[1], 'base64');
  }
  return result;
}

function write(name, data) {
  const file = path.join(ASSETS, name);
  fs.writeFileSync(file, data);
  console.log(`${String(data.length).padStart(8)}  assets/${name}`);
}

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1024,
    height: 1024,
    show: false,
    frame: false,
    transparent: true,
    webPreferences: { sandbox: true, contextIsolation: true },
  });
  try {
    const all = new Set([...APP_SIZES, ...ICO_SIZES, ...ICNS_MAP.map(([, s]) => s)]);
    const big = await rasterize(win, path.join(ASSETS, 'icon.svg'), [...all]);

    for (const size of APP_SIZES) {
      const name = size === 1024 ? 'icon.png' : `icon-${size}.png`;
      write(name, big[size]);
    }
    write('icon.ico', ico(ICO_SIZES.map((size) => ({ size, png: big[size] }))));
    write('icon.icns', icns(ICNS_MAP.map(([type, size]) => ({ type, png: big[size] }))));

    // Трей: цветной знак на 32 px и шаблонный чёрный на 44 px для macOS.
    const tray = await rasterize(win, path.join(ASSETS, 'icon.svg'), [32]);
    write('tray.png', tray[32]);
    const template = await rasterize(win, path.join(ASSETS, 'trayTemplate.svg'), [44]);
    write('trayTemplate.png', template[44]);
  } catch (e) {
    console.error('иконки не собрались:', e.message);
    app.exit(1);
    return;
  } finally {
    win.destroy();
  }
  app.exit(0);
});

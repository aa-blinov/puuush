'use strict';
/**
 * Скриншоты интерфейса для README.
 *
 * Окна настоящие: собранный интерфейс из src/renderer, настоящий Chromium,
 * настоящая тема кита. Данные подставляет заглушка моста (scripts/shots-
 * preload.cjs), чтобы снимок не зависел от того, что лежит в каталоге
 * пользователя.
 *
 *     npm run shots
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow, ipcMain, nativeTheme, screen } = require('electron');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'docs');
const RENDERER = path.join(ROOT, 'src', 'renderer');
const PRELOAD = path.join(__dirname, 'shots-preload.cjs');
const OVERLAY_PRELOAD = path.join(__dirname, 'shots-overlay-preload.cjs');

const HOSTS = [
  { name: 'catbox', label: 'catbox — постоянно', temp: false },
  { name: 'pomf2', label: 'pomf2.lain.la — постоянно', temp: false },
  { name: 'uguu', label: 'uguu.se — на несколько часов', temp: true },
];

/** Состояние, из которого снимают окно настроек. */
const SETTINGS = {
  hotkey: 'CommandOrControl+Shift+S',
  host: 'own',
  own: { base_url: 'https://media.example.com', write_key: 'секретный-ключ' },
  openAfterUpload: false,
  keepLocalCopy: true,
  saveDir: '',
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'puuush-shots-'));

/**
 * Ход работы пишется в файл: stdout у Electron при запуске из консоли
 * буферизуется, и при аварии сообщение теряется вместе с процессом.
 */
const LOG = path.join(tmp, 'shots.log');
fs.writeFileSync(LOG, '');
const step = (message) => {
  fs.appendFileSync(LOG, message + '\n');
  console.log(message);
};

/** Состояние, которое отдаёт окну заглушка моста. */
let state = { settings: {}, hosts: [], history: [] };
/** Снимок экрана для окна выбора области. */
let frame = { dataUrl: '', width: 0, height: 0 };

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Окно настроек целиком: сначала открываем его узким, потом расширяем по
 * содержимому, чтобы в кадр попал весь список, а не только верхний край.
 */
async function shotSettings(name, next) {
  state = next;

  const win = new BrowserWindow({
    width: 720,
    height: 700,
    show: true,
    backgroundColor: '#282828',
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  const errors = [];
  win.webContents.on('console-message', (...args) => {
    const ev = args[0];
    const modern = args.length === 1 && ev && typeof ev === 'object' && 'message' in ev;
    const message = modern ? ev.message : args[2];
    const level = modern ? ev.level : args[1];
    if (level >= 2) errors.push(String(message));
  });

  step(`  ${name}: грузим окно`);
  await win.loadFile(path.join(RENDERER, 'settings.html'));
  await wait(700);

  const height = await win.webContents.executeJavaScript(
    'Math.ceil(document.documentElement.scrollHeight)'
  );
  win.setBounds({ width: 720, height: Math.min(height, 4000) });
  await wait(400);
  // Полоса прокрутки в кадре — мусор: на снимке нужен весь список, а окно
  // в приложении всё равно прокручивается.
  await win.webContents.executeJavaScript(
    "document.documentElement.style.overflow = 'hidden'; document.body.style.overflow = 'hidden';"
  );
  await wait(150);

  const image = await win.webContents.capturePage();
  fs.writeFileSync(path.join(OUT, name), image.toPNG());
  win.destroy();
  if (errors.length) step(`  ОШИБКИ КОНСОЛИ (${name}): ${errors.join(' | ')}`);
  else step(`  ${name}: готово`);
}

/**
 * Окно выбора области.
 *
 * Подложкой служит снимок настоящего окна с кодом: так видно, что рамка
 * выделяет область на чужом экране, а не на пустом листе.
 */
async function shotOverlay() {
  const { width: SCREEN_W, height: SCREEN_H } = screen.getPrimaryDisplay().size;

  const desktop = new BrowserWindow({
    width: SCREEN_W,
    height: SCREEN_H,
    show: true,
    backgroundColor: '#1e1e1e',
  });
  await desktop.loadFile(path.join(tmp, 'desktop.html'));
  await wait(500);
  const shot = await desktop.webContents.capturePage();
  const dataUrl = 'data:image/png;base64,' + shot.toPNG().toString('base64');
  desktop.destroy();

  frame = { dataUrl, width: SCREEN_W, height: SCREEN_H };

  const win = new BrowserWindow({
    width: SCREEN_W,
    height: SCREEN_H,
    show: true,
    frame: false,
    transparent: true,
    hasShadow: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: OVERLAY_PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  const errors = [];
  win.webContents.on('console-message', (...args) => {
    const ev = args[0];
    const modern = args.length === 1 && ev && typeof ev === 'object' && 'message' in ev;
    const message = modern ? ev.message : args[2];
    const level = modern ? ev.level : args[1];
    if (level >= 2) errors.push(String(message));
  });

  await win.loadFile(path.join(RENDERER, 'overlay.html'));
  await wait(600);

  // Протяжка рамки: те же координаты, что и в прежнем снимке, чтобы кадр
  // остался узнаваемым.
  await win.webContents.executeJavaScript(`
    (function () {
      var img = document.querySelector('img.shot');
      img.dispatchEvent(new MouseEvent('mousedown', { clientX: 430, clientY: 250, button: 0, bubbles: true }));
      window.dispatchEvent(new MouseEvent('mousemove', { clientX: 1010, clientY: 640, bubbles: true }));
      window.dispatchEvent(new MouseEvent('mouseup', { clientX: 1010, clientY: 640, bubbles: true }));
    })()
  `);
  await wait(400);

  const image = await win.webContents.capturePage();
  fs.writeFileSync(path.join(OUT, 'ui-overlay.png'), image.toPNG());
  win.destroy();
  if (errors.length) step(`  ОШИБКИ КОНСОЛИ (ui-overlay.png): ${errors.join(' | ')}`);
  else step('  ui-overlay.png: готово');
}

/** Рабочий стол подложки: страница с кодом, как её видит человек. */
function writeDesktop() {
  const lines = [
    ['const host = cfg.host || \'auto\';', 'keyword'],
    ['const chain = HOSTS.filter(h => h.name === host);', 'plain'],
    ['for (const h of chain) {', 'keyword'],
    ['  const url = await uploadTo(h, filePath);', 'plain'],
    ['  if (await verify(url, size, filePath)) return { url, host: h.name };', 'plain'],
    ['}', 'keyword'],
    ["throw new Error('ни один хостинг не отдал ссылку');", 'error'],
  ];
  const body = lines
    .map(
      ([text, kind], index) =>
        `<div class="l ${kind}"><span class="n">${index + 10}</span>${text
          .replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c])
          .replace(/'([^']*)'/g, "<span class='s'>'$1'</span>")
          .replace(/\b(const|for|return|throw|await|new)\b/g, "<span class='k'>$1</span>")}</div>`
    )
    .join('\n');

  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    * { box-sizing: border-box; }
    body { margin: 0; background: #1e1e1e; color: #d4d4d4; font: 15px/1.6 "DejaVu Sans Mono", monospace; }
    .side { position: absolute; left: 0; top: 0; bottom: 0; width: 248px; background: #252526; border-right: 1px solid #333; padding: 14px 0; }
    .side b { display: block; font-size: 12px; letter-spacing: .1em; text-transform: uppercase; color: #8a8a8a; padding: 8px 20px; }
    .side span { display: block; padding: 4px 20px; color: #c8c8c8; font-size: 14px; }
    .code { position: absolute; left: 248px; top: 0; right: 0; padding: 16px 20px; }
    .file { color: #6a9955; margin-bottom: 12px; }
    .l { white-space: pre; }
    .n { display: inline-block; width: 40px; color: #6a9955; }
    .k { color: #569cd6; } .s { color: #ce9178; } .error { color: #f44747; }
  </style></head><body>
    <div class="side">
      <b>Чаты</b>
      <span>Команда · релизы</span>
      <span>Дизайн-ревью</span>
      <span>Backend · деплой</span>
      <span>Ошибки прод</span>
    </div>
    <div class="code">
      <div class="file">src/upload.js</div>
      ${body}
      <div class="file" style="margin-top:18px">server/index.js</div>
      <div class="l"><span class="n">30</span>const meta = <span class="k">await</span> writeUpload(cfg, filename, data);</div>
      <div class="l"><span class="n">31</span><span class="k">return</span> json(res, <span class="s">201</span>, meta);</div>
    </div>
  </body></html>`;

  fs.writeFileSync(path.join(tmp, 'desktop.html'), html);
}

app.on('window-all-closed', () => {});

ipcMain.handle('shot:state', () => state);
ipcMain.handle('shot:frame', () => frame);

app.whenReady().then(async () => {
  // Скриншоты снимаются в тёмной теме: она основная в приложении.
  nativeTheme.themeSource = 'dark';
  fs.mkdirSync(OUT, { recursive: true });
  writeDesktop();

  await shotSettings('ui-settings.png', {
    settings: SETTINGS,
    hosts: HOSTS,
    history: [],
  });

  await shotSettings('ui-settings-broken.png', {
    settings: { ...SETTINGS, own: { base_url: '', write_key: '' }, host: 'auto' },
    hosts: HOSTS,
    history: [],
    broken: 'settings.json повреждён: JSON не читается',
  });

  await shotOverlay();

  step('  всё снято');
  fs.copyFileSync(LOG, path.join(OUT, '.shots.log'));
  fs.rmSync(tmp, { recursive: true, force: true });
  app.exit(0);
});

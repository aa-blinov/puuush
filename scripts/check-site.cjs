'use strict';
/**
 * Проверка страницы сайта: открывает site/index.html и снимает её целиком.
 *
 * Страница проверяется настоящим Chromium, а не чтением HTML: так видно
 * и переносы, и то, что картинки на месте.
 */
const path = require('node:path');
const fs = require('node:fs');
const { app, BrowserWindow, nativeTheme } = require('electron');

const SITE = path.join(__dirname, '..', 'site');
const OUT = process.argv.includes('--dark') ? '/tmp/site-shot-dark.png' : '/tmp/site-shot.png';

app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
  // Тема сайта следует за системой, поэтому страница проверяется в обоих
  // режимах: тёмный у приложения основной.
  nativeTheme.themeSource = process.argv.includes('--dark') ? 'dark' : 'light';
  const win = new BrowserWindow({
    width: 1280,
    height: 900,
    show: true,
    backgroundColor: '#282828',
  });
  const errors = [];
  win.webContents.on('console-message', (...a) => {
    const ev = a[0];
    const modern = a.length === 1 && ev && typeof ev === 'object' && 'message' in ev;
    const level = modern ? ev.level : a[1];
    const message = String(modern ? ev.message : a[2]);
    // Две вещи относятся к локальной проверке, а не к сайту: предупреждение
    // Electron о Content Security Policy есть только у неупакованного окна, и
    // несовпадение режима загрузки шрифта бывает только на file://.
    if (/Electron Security Warning|credentials mode does not match/.test(message)) return;
    if (level >= 2) errors.push(message);
  });
  win.webContents.on('did-fail-load', (_e, c, d) => errors.push('FAIL ' + c + ' ' + d));

  // Ссылки и картинки проверяются до открытия страницы: относительный путь,
  // которого нет, в опубликованном сайте становится битой картинкой.
  const html = fs.readFileSync(path.join(SITE, 'index.html'), 'utf8');
  const refs = [...html.matchAll(/(?:src|href)="([^"#:]+)"/g)].map((m) => m[1]);
  const missing = refs.filter((ref) => !fs.existsSync(path.join(SITE, ref)));
  if (missing.length) errors.push('нет таких файлов: ' + missing.join(', '));

  await win.loadFile(path.join(SITE, 'index.html'));
  await new Promise((r) => setTimeout(r, 900));

  const height = await win.webContents.executeJavaScript(
    'Math.ceil(document.documentElement.scrollHeight)'
  );
  win.setBounds({ width: 1280, height: Math.min(height, 12000) });
  await new Promise((r) => setTimeout(r, 700));

  const image = await win.webContents.capturePage();
  fs.writeFileSync(OUT, image.toPNG());
  fs.writeFileSync(
    process.argv.includes('--dark') ? '/tmp/site-check-dark.json' : '/tmp/site-check.json',
    JSON.stringify({ errors, height, width: image.getSize().width, heightPx: image.getSize().height }, null, 2)
  );
  app.exit(0);
});

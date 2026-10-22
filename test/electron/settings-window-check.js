'use strict';
/**
 * Проверка живого окна настроек.
 *
 * Окно открывается настоящее, с настоящим preload и настоящим store: файл
 * настроек пишется в временный каталог, и проверка смотрит, что после
 * действия человека в файле лежит именно то, что он выбрал.
 *
 * Раньше логика окна жила в settings.js и проверялась только чтением кода.
 * После переезда интерфейса на Svelte поведение стало состоянием компонента,
 * и его нужно проверять по-настоящему: значение в поле, значение на диске и
 * надпись на экране — три разные вещи, и они обязаны совпадать.
 *
 *     npm run test:electron
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow, ipcMain } = require('electron');

const SRC = path.join(__dirname, '..', '..', 'src');

const results = [];
const step = (ok, name, note) => {
  results.push({ ok, name, note: note || '' });
  console.log(`  ${ok ? 'ОК  ' : 'ПРОВАЛ'} ${name}${note ? ': ' + note : ''}`);
};

app.on('window-all-closed', () => {});
/**
 * Проверка, которая висит, хуже проверки, которая падает: падение видно
 * сразу, а ожидание не видно никогда. Поэтому необработанная ошибка и
 * истечение времени ведут к ненулевому коду выхода.
 */
process.on('unhandledRejection', (e) => {
  console.error('  ПРОВАЛ необработанная ошибка: ' + (e && e.message ? e.message : e));
  process.exit(1);
});
setTimeout(() => {
  console.error('  ПРОВАЛ: проверка не уложилась в две минуты');
  process.exit(1);
}, 120000).unref?.();


app.whenReady().then(async () => {
  // Свой каталог данных: проверка не должна трогать настройки человека.
  const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'puuush-settings-'));
  app.setPath('userData', ud);

  const store = require(path.join(SRC, 'store.js'));
  const { HOSTS } = require(path.join(SRC, 'upload.js'));

  // Те же каналы, что и в главном процессе: тест проверяет окно, а не IPC.
  ipcMain.handle('puuush:get-settings', () => store.getSettings());
  ipcMain.handle('puuush:broken-settings', () => store.brokenReason());
  ipcMain.handle('puuush:save-settings', (_e, patch) => store.setSettings(patch || {}));
  ipcMain.handle('puuush:get-history', () => store.getHistory());
  ipcMain.handle('puuush:clear-history', () => store.clearHistory());
  ipcMain.handle('puuush:hosts', () => HOSTS.map((h) => ({ name: h.name, temp: h.temp })));
  // Синхронный ответ на язык: окно спрашивает его до первой отрисовки.
  ipcMain.on('puuush:lang', (e) => { e.returnValue = store.getSettings().lang; });

  const win = new BrowserWindow({
    width: 720,
    height: 700,
    show: false,
    webPreferences: {
      preload: path.join(SRC, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  const errors = [];
  win.webContents.on('console-message', (...args) => {
    const ev = args[0];
    const modern = args.length === 1 && ev && typeof ev === 'object' && 'message' in ev;
    if ((modern ? ev.level : args[1]) >= 2) errors.push(String(modern ? ev.message : args[2]));
  });
  win.webContents.on('preload-error', (_e, p, e) => errors.push('preload ' + e.message));

  await win.loadFile(path.join(SRC, 'renderer', 'settings.html'));
  await new Promise((r) => setTimeout(r, 1200));

  /** Выполняет код в окне и возвращает результат. */
  const run = (code) => win.webContents.executeJavaScript(code, true);

  // --- поле хоткея и список хостингов -------------------------------
  const start = await run(`(function () {
    var hotkey = document.getElementById('hotkey');
    var host = document.getElementById('host');
    return {
      hotkey: hotkey ? hotkey.value : null,
      hosts: host ? host.options.length : 0,
      ownVisible: document.getElementById('ownBox') ? document.getElementById('ownBox').style.display : null,
    };
  })()`);

  step(start.hotkey === 'Ctrl+Shift+S', 'хоткей подставился', start.hotkey);
  step(start.hosts >= 4, 'вариантов хостинга', String(start.hosts));
  step(start.ownVisible === 'block', 'блок своего сервера виден в режиме авто', start.ownVisible);

  // --- смена хостинга -----------------------------------------------
  await run(`(function () {
    var host = document.getElementById('host');
    host.value = 'catbox';
    host.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await new Promise((r) => setTimeout(r, 600));

  const afterHost = await run(`(function () {
    return {
      value: document.getElementById('host').value,
      ownVisible: document.getElementById('ownBox').style.display,
      text: document.body.innerText,
    };
  })()`);

  step(afterHost.value === 'catbox', 'хостинг переключился', afterHost.value);
  step(afterHost.ownVisible === 'none', 'свой сервер спрятан в публичном режиме', afterHost.ownVisible);
  step(
    afterHost.text.includes('public host'),
    'предупреждение о публичном хостинге',
    ''
  );
  step(store.getSettings().host === 'catbox', 'хостинг записан на диск', store.getSettings().host);

  // --- адрес и ключ своего сервера -----------------------------------
  await run(`(function () {
    var url = document.getElementById('ownUrl');
    url.value = 'https://media.example.com';
    url.dispatchEvent(new Event('input', { bubbles: true }));
    url.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await new Promise((r) => setTimeout(r, 600));

  const saved = store.getSettings();
  step(
    saved.own.base_url === 'https://media.example.com',
    'адрес своего сервера записан',
    saved.own.base_url
  );

  // В режиме «авто» с адресом, но без ключа, приложение обязано сказать,
  // что снимок уйдёт наружу. Это ровно то место, где продукт обещает
  // человеку приватность.
  const warn = await run(`(function () {
    var host = document.getElementById('host');
    host.value = 'auto';
    host.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  await new Promise((r) => setTimeout(r, 600));

  const afterAuto = await run(`document.body.innerText`);
  step(
    afterAuto.includes('public host'),
    'без ключа приложение предупреждает про внешний хостинг',
    ''
  );

  // --- язык -----------------------------------------------------------
  // По умолчанию английский: окно открывается на нём, даже если в системе
  // русская локаль. Русский включается человеком.
  // textContent, а не innerText: innerText отдаёт текст так, как он нарисован,
  // то есть с капителью, а заголовки разделов набраны капсом.
  const defaultLang = await run(`document.body.textContent`);
  step(
    defaultLang.includes('Settings.') && !defaultLang.includes('Настройки.'),
    'по умолчанию английский',
    ''
  );

  const buttons = await run(
    `Array.from(document.querySelectorAll('[role="group"] button')).map((b) => b.textContent.trim())`
  );
  step(buttons.length === 2, 'переключатель языка на месте', JSON.stringify(buttons));

  await run(`(function () {
    var b = Array.from(document.querySelectorAll('[role="group"] button'))
      .find((x) => x.textContent.trim() === 'Русский');
    if (b) b.click();
  })()`);
  await new Promise((r) => setTimeout(r, 700));

  const afterLang = await run(`document.body.textContent`);
  step(
    afterLang.includes('Настройки.') && afterLang.includes('Горячая клавиша'),
    'русский включается на лету',
    ''
  );
  step(store.getSettings().lang === 'ru', 'язык записан на диск', store.getSettings().lang);

  // Обратно на английский: окно не должно остаться в прошлом языке.
  await run(`(function () {
    var b = Array.from(document.querySelectorAll('[role="group"] button'))
      .find((x) => x.textContent.trim() === 'English');
    if (b) b.click();
  })()`);
  await new Promise((r) => setTimeout(r, 700));
  const back = await run(`document.body.textContent`);
  step(back.includes('Settings.') && store.getSettings().lang === 'en',
    'обратно на английский', store.getSettings().lang);

  // --- галочки -------------------------------------------------------
  await run(`(function () {
    var box = document.getElementById('keepLocalCopy');
    box.checked = false;
    box.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await new Promise((r) => setTimeout(r, 600));

  const afterBox = store.getSettings();
  step(afterBox.keepLocalCopy === false, 'галочка «хранить снимки» записана', String(afterBox.keepLocalCopy));

  // --- поле папки ----------------------------------------------------
  await run(`(function () {
    var dir = document.getElementById('saveDir');
    dir.value = '/tmp/puuush-shots';
    dir.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await new Promise((r) => setTimeout(r, 600));

  step(store.getSettings().saveDir === '/tmp/puuush-shots', 'папка для скринов записана', store.getSettings().saveDir);

  // --- ошибки в консоли ----------------------------------------------
  step(errors.length === 0, 'в консоли нет ошибок', errors.join(' | '));

  win.destroy();
  fs.rmSync(ud, { recursive: true, force: true });

  const failed = results.filter((r) => !r.ok).length;
  console.log(failed ? `  провалено: ${failed}` : '  все проверки пройдены');
  app.exit(failed ? 1 : 0);
});

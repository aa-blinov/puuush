'use strict';
/**
 * puuush — скриншот области, загрузка, ссылка в буфере.
 *
 * Приложение живёт в трее и не показывает главного окна: всё делается хоткеем
 * и меню. Окно настроек открывается отдельно и по умолчанию закрывается в трей.
 */

const path = require('node:path');
const fs = require('node:fs');
const {
  app,
  Tray,
  Menu,
  globalShortcut,
  Notification,
  clipboard,
  shell,
  dialog,
  BrowserWindow,
  nativeImage,
  ipcMain,
} = require('electron');

const store = require('./store');
const { publish, HOSTS } = require('./upload');
const { captureTo } = require('./capture');

const ASSETS = path.join(__dirname, '..', 'assets');

let tray = null;
let settingsWin = null;
let busy = false;

// ---------------------------------------------------------------------------
// Режим командной строки: puuush --cli файл.png
// Печатает ссылку и выходит. Удобно из скриптов и для удалённых машин.
// ---------------------------------------------------------------------------
function runCli(argv) {
  const files = argv.filter((a) => !a.startsWith('--'));
  if (!files.length) {
    process.stderr.write('puuush: укажи файл\nпример: puuush --cli ~/Desktop/screen.png\n');
    process.exit(2);
  }
  const s = store.getSettings();
  (async () => {
    let code = 0;
    for (const f of files) {
      try {
        const r = await publish(path.resolve(f), {
          host: s.host,
          own: s.own,
          onStep: (m) => process.stderr.write(`  ${m}\n`),
        });
        process.stdout.write(r.url + '\n');
      } catch (e) {
        process.stderr.write(`puuush: ${e.message}\n`);
        code = 1;
      }
    }
    process.exit(code);
  })();
  return true;
}

// ---------------------------------------------------------------------------
// Загрузка
// ---------------------------------------------------------------------------

/** Уведомление, молча пропускаемое там, где его показывать нечем. */
function notify(title, body) {
  if (!Notification.isSupported()) return;
  new Notification({ title, body, silent: true }).show();
}

async function uploadAndDeliver(filePath, { source = 'скриншот' } = {}) {
  const s = store.getSettings();
  try {
    notify('puuush', 'загружаю…');
    const r = await publish(filePath, {
      host: s.host,
      own: s.own,
      onStep: (m) => broadcast('puuush:progress', { state: 'step', message: m }),
    });
    clipboard.writeText(r.url);
    store.addHistory({ url: r.url, host: r.host, temp: r.temp, file: filePath, source });
    buildTrayMenu();
    notify('puuush', `${source}: ссылка в буфере\n${r.url}`);
    broadcast('puuush:progress', {
      state: 'done',
      url: r.url,
      host: r.host,
      temp: r.temp,
    });
    if (s.openAfterUpload) shell.openExternal(r.url);
    return r;
  } catch (e) {
    notify('puuush', 'не получилось: ' + e.message);
    broadcast('puuush:progress', { state: 'error', message: e.message });
    throw e;
  }
}

function broadcast(channel, payload) {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send(channel, payload);
  }
}

/** Снимок экрана -> область -> загрузка -> буфер. */
async function shoot() {
  if (busy) return;
  busy = true;
  broadcast('puuush:progress', { state: 'capturing' });
  try {
    const dir = store.shotsDir();
    const shot = await captureTo(dir);
    if (!shot) return; // Esc
    broadcast('puuush:progress', {
      state: 'captured',
      width: shot.width,
      height: shot.height,
    });
    await uploadAndDeliver(shot.path, { source: 'скриншот' });
    if (!store.getSettings().keepLocalCopy) {
      try {
        fs.unlinkSync(shot.path);
      } catch (e) {
        /* файл уже могли унести, не страшно */
      }
    }
  } catch (e) {
    const msg = String(e && e.message ? e.message : e);
    notify('puuush', 'снимок не удался: ' + msg);
    broadcast('puuush:progress', { state: 'error', message: msg });
  } finally {
    busy = false;
  }
}

// ---------------------------------------------------------------------------
// Трей
// ---------------------------------------------------------------------------

function trayImage() {
  const file = process.platform === 'darwin' ? 'trayTemplate.png' : 'tray.png';
  const p = path.join(ASSETS, file);
  if (fs.existsSync(p)) {
    const img = nativeImage.createFromPath(p);
    if (process.platform === 'darwin') img.setTemplateImage(true);
    return img;
  }
  return nativeImage.createFromPath(path.join(ASSETS, 'icon.png'));
}

function historyMenu() {
  const items = store.getHistory().slice(0, 10);
  if (!items.length) return [{ label: 'пусто', enabled: false }];
  const menu = items.map((h) => ({
    label: `${h.url.length > 58 ? h.url.slice(0, 58) + '…' : h.url}  (${h.host})`,
    toolTip: h.url,
    click: () => {
      clipboard.writeText(h.url);
      notify('puuush', 'ссылка скопирована');
    },
  }));
  menu.push({ type: 'separator' });
  menu.push({ label: 'очистить историю', click: () => { store.clearHistory(); buildTrayMenu(); } });
  return menu;
}

function buildTrayMenu() {
  if (!tray) return;
  const s = store.getSettings();
  tray.setToolTip('puuush — снимок по ' + s.hotkey);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Снять область экрана', accelerator: s.hotkey, click: shoot },
      { type: 'separator' },
      {
        label: 'Загрузить файл…',
        click: async () => {
          const r = await dialog.showOpenDialog({
            properties: ['openFile', 'multiSelections'],
            title: 'Что загрузить',
          });
          if (r.canceled) return;
          for (const f of r.filePaths) {
            await uploadAndDeliver(f, { source: path.basename(f) }).catch(() => {});
          }
        },
      },
      {
        label: 'Скопировать файл из буфера',
        click: async () => {
          const img = nativeImage.readClipboardImage();
          if (img.isEmpty()) return notify('puuush', 'в буфере нет картинки');
          const f = path.join(store.shotsDir(), `clip-${Date.now()}.png`);
          fs.writeFileSync(f, img.toPNG());
          await uploadAndDeliver(f, { source: 'из буфера' }).catch(() => {});
        },
      },
      { type: 'separator' },
      { label: 'История', submenu: historyMenu() },
      { label: 'Настройки…', click: openSettings },
      { type: 'separator' },
      { label: 'Выход', click: () => app.quit() },
    ])
  );
}

function openSettings() {
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.show();
    settingsWin.focus();
    return settingsWin;
  }
  settingsWin = new BrowserWindow({
    width: 720,
    height: 700,
    title: 'puuush — настройки',
    icon: path.join(ASSETS, 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  settingsWin.loadFile(path.join(__dirname, 'settings.html'));
  settingsWin.on('closed', () => { settingsWin = null; });
  return settingsWin;
}

// ---------------------------------------------------------------------------
// Хоткей
// ---------------------------------------------------------------------------

function applyHotkey() {
  const { hotkey } = store.getSettings();
  globalShortcut.unregisterAll();
  let ok = false;
  try {
    ok = globalShortcut.register(hotkey, shoot);
  } catch (e) {
    ok = false;
  }
  if (!ok) {
    // Не молчим: неработающий хоткей — это ровно то, из-за чего приходят потом.
    const win = openSettings();
    setTimeout(() => {
      win.webContents.send('puuush:progress', {
        state: 'error',
        message: `не смог занять ${hotkey} — возможно, он уже занят другим приложением`,
      });
    }, 800);
    notify('puuush', `хоткей ${hotkey} занят другим приложением`);
  }
  buildTrayMenu();
  return ok;
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------

function registerIpc() {
  const handle = (channel, fn) =>
    ipcMain.handle(channel, async (_e, arg) => {
      try {
        return await fn(_e, arg);
      } catch (err) {
        notify('puuush', String(err && err.message ? err.message : err));
        return null;
      }
    });
  handle('puuush:get-settings', () => store.getSettings());
  handle('puuush:save-settings', (_e, patch) => {
    const next = store.setSettings(patch || {});
    applyHotkey();
    buildTrayMenu();
    return next;
  });
  handle('puuush:get-history', () => store.getHistory());
  handle('puuush:clear-history', () => {
    store.clearHistory();
    buildTrayMenu();
    return true;
  });
  handle('puuush:hosts', () => HOSTS.map((h) => ({ name: h.name, label: h.label, temp: h.temp })));
  handle('puuush:reapply-hotkey', () => applyHotkey());
  handle('puuush:choose-file', async () => {
    const r = await dialog.showOpenDialog({ properties: ['openFile'] });
    return r.canceled ? null : r.filePaths[0];
  });
  handle('puuush:choose-dir', async () => {
    const r = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] });
    return r.canceled ? null : r.filePaths[0];
  });
  handle('puuush:upload-file', async (_e, p) => {
    if (!p) return null;
    return uploadAndDeliver(p, { source: path.basename(p) });
  });
  handle('puuush:upload-dropped', async (_e, p) => {
    if (!p) return null;
    return uploadAndDeliver(p, { source: path.basename(p) });
  });
  handle('puuush:close-self', () => {
    if (settingsWin && !settingsWin.isDestroyed()) settingsWin.close();
    return true;
  });
  handle('puuush:open-external', (_e, url) => {
    if (/^https?:\/\//.test(String(url))) shell.openExternal(url);
    return true;
  });
}

function ipcRegisterRemoved() {}

/**
 * Открывает окно скрытно и собирает ошибки renderer'а.
 * Ошибки в preload/разметке иначе видны только пользователю — в виде молча
 * неработающей кнопки, и диагностировать их приходится вслепую.
 */
function checkRenderer(file, checkExpr) {
  return new Promise((resolve) => {
    const win = new BrowserWindow({
      show: false,
      width: 800,
      height: 600,
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    const errors = [];
    let done = false;

    const finish = (extra) => {
      if (done) return;
      done = true;
      if (!win.isDestroyed()) win.destroy();
      resolve(extra ? errors.concat([extra]) : errors);
    };

    // Electron <35 передаёт позиционные аргументы, >=35 — объект события.
    win.webContents.on('console-message', (...args) => {
      const ev = args[0];
      const modern = args.length === 1 && ev && typeof ev === 'object' && 'message' in ev;
      const level = modern ? ev.level : args[1];
      const msg = modern ? ev.message : args[2];
      const line = modern ? ev.lineNumber : args[3];
      const src = modern ? ev.sourceId : args[4];
      if (level >= 2) errors.push(`${msg} (${path.basename(src || '')}:${line})`);
    });
    win.webContents.on('preload-error', (_e, p, err) =>
      errors.push(`preload ${path.basename(p)}: ${err}`)
    );
    win.webContents.once('did-finish-load', () => {
      // Даём renderer'у отработать инициализацию, затем спрашиваем результат.
      // Промис прямо в executeJavaScript не проходит: ожидание уходит в
      // renderer и main-процесс теряет управление до его разрешения.
      setTimeout(async () => {
        let problem = '';
        try {
          problem = await win.webContents.executeJavaScript(checkExpr, true);
        } catch (e) {
          problem = 'проверка не выполнилась: ' + e.message;
        }
        finish(typeof problem === 'string' ? problem : '');
      }, 1500);
    });

    win.loadFile(path.join(__dirname, file)).catch((e) =>
      finish('файл не загрузился: ' + e.message)
    );
    setTimeout(() => finish('окно не загрузилось за 10 секунд'), 10000);
  });
}

// ---------------------------------------------------------------------------
// Диагностика: puuush --selftest
//
// Прогоняет на себе всё, что нельзя проверить чтением кода: берёт экран,
// режет область, создаёт трей, занимает хоткей и заливает файл. Нужен на
// сервере без монитора и после обновления Electron.
// ---------------------------------------------------------------------------
async function runSelfTest() {
  const rows = [];
  const step = (ok, name, note) => rows.push({ ok, name, note });
  const s = store.getSettings();
  registerIpc(); // окно настроек ходит в IPC, без них оно не инициализируется

  try {
    const { grabDisplay, displayUnderCursor } = require('./capture');
    const display = displayUnderCursor();
    const { image, scale } = await grabDisplay(display);
    const size = image.getSize();
    step(true, 'захват экрана', `${size.width}x${size.height} px, scale ${scale}`);

    const cut = image.crop({
      x: Math.round(size.width * 0.1),
      y: Math.round(size.height * 0.1),
      width: Math.max(1, Math.round(size.width * 0.25)),
      height: Math.max(1, Math.round(size.height * 0.25)),
    });
    const file = path.join(store.shotsDir(), 'selftest.png');
    fs.writeFileSync(file, cut.toPNG());
    step(fs.statSync(file).size > 0, 'нарезка и запись',
      `${cut.getSize().width}x${cut.getSize().height} -> ${file}`);

    tray = new Tray(trayImage());
    buildTrayMenu();
    step(true, 'трей', `иконка ${trayImage().isEmpty() ? 'НЕ' : ''}загружена`);

    const okHot = applyHotkey();
    step(okHot, 'хоткей', okHot ? `${s.hotkey} занят` : `${s.hotkey} занять не удалось`);

    const r = await publish(file, { host: s.host, own: s.own, onStep: () => {} });
    step(true, 'загрузка', `${r.url} (${r.host})`);

    const setErr = await checkRenderer('settings.html', `
      (function () {
        var h = document.getElementById('hotkey');
        var sel = document.getElementById('host');
        if (!h || !sel) return 'в разметке нет hotkey или host';
        if (!h.value) return 'хоткей не подставился';
        if (sel.options.length < 4) return 'вариантов хостинга: ' + sel.options.length;
        if (document.getElementById('ownBox').style.display === 'none')
          return 'блок своего box скрыт при режиме ' + sel.value;
        return '';
      })()
    `);
    step(setErr.length === 0, 'окно настроек',
      setErr.length ? setErr.join(' | ') : 'грузится без ошибок');

    const ovErr = await checkRenderer('overlay.html',
      `typeof window.puuush.submitRegion === 'function' ? '' : 'нет моста в preload'`);
    step(ovErr.length === 0, 'окно выбора области',
      ovErr.length ? ovErr.join(' | ') : 'грузится без ошибок');
  } catch (e) {
    step(false, 'сбой', e.message);
  }

  const w = Math.max(...rows.map((r) => r.name.length));
  for (const r of rows) {
    process.stdout.write(
      `${r.ok ? '  ОК  ' : ' ОШИБКА'}  ${r.name.padEnd(w)}  ${r.note || ''}\n`
    );
  }
  const failed = rows.filter((r) => !r.ok).length;
  process.exit(failed ? 1 : 0);
}

// ---------------------------------------------------------------------------
// Запуск
// ---------------------------------------------------------------------------

const cliIdx = process.argv.indexOf('--cli');
const testIdx = process.argv.indexOf('--selftest');

// Приложение живёт в трее, поэтому закрытие последнего окна (настроек, выбора
// области, проверочного) не должно его убивать. Без этого обработчика Electron
// выходит сам, и вспомогательное окно не успевает отработать.
app.on('window-all-closed', () => {});
app.on('will-quit', () => globalShortcut.unregisterAll());

if (cliIdx !== -1 || testIdx !== -1) {
  // Служебные режимы не берут single-instance lock: иначе запуск из скрипта,
  // когда трей уже висит, молча вышел бы.
  app.whenReady().then(() => {
    if (cliIdx !== -1) return runCli(process.argv.slice(cliIdx + 1));
    return runSelfTest();
  });
} else {
  const gotLock = app.requestSingleInstanceLock();
  if (!gotLock) {
    app.quit();
  } else {
    app.on('second-instance', () => {
      if (tray) tray.popUpContextMenu();
    });

    app.whenReady().then(() => {
      if (app.dock) app.dock.hide(); // приложение живёт в трее

      tray = new Tray(trayImage());
      buildTrayMenu();
      registerIpc();
      applyHotkey();

      app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) buildTrayMenu();
      });
    });
  }
}
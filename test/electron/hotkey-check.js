'use strict';
/**
 * Проверка настоящего главного процесса: занятая комбинация и запрет
 * навигации окна.
 *
 * Грузится настоящий src/main.js со своим store и своим IPC. «Занято другим
 * приложением» изображается подменой globalShortcut.register: чужого
 * держателя клавиши на тестовом дисплее нет.
 *
 *     npm run test:electron
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow, globalShortcut } = require('electron');

const SRC = path.join(__dirname, '..', '..', 'src');
const results = [];
const step = (ok, name, note) => {
  results.push(ok);
  console.log(`  ${ok ? 'ОК  ' : 'ПРОВАЛ'} ${name}${note ? ': ' + note : ''}`);
};
process.on('unhandledRejection', (e) => {
  console.error('  ПРОВАЛ необработанная ошибка: ' + (e && e.message ? e.message : e));
  process.exit(1);
});
setTimeout(() => {
  console.error('  ПРОВАЛ: проверка не уложилась в две минуты');
  process.exit(1);
}, 120000).unref?.();

const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'puuush-hotkey-'));
app.setPath('userData', ud);
// Настоящий main.js: он сам ставит IPC, трей и хоткеи после готовности.
require(path.join(SRC, 'main.js'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  await sleep(1500);
  const taken = new Set(['Control+Alt+Q']);
  const realRegister = globalShortcut.register.bind(globalShortcut);
  globalShortcut.register = (acc, fn) => (taken.has(acc) ? false : realRegister(acc, fn));

  const win = new BrowserWindow({
    show: false,
    webPreferences: { preload: path.join(SRC, 'preload.js'), contextIsolation: true },
  });
  await win.loadFile(path.join(SRC, 'renderer', 'settings.html'));
  const call = (code) => win.webContents.executeJavaScript(code, true);

  const before = await call(`window.puuush.getSettings()`);
  step(globalShortcut.isRegistered(before.hotkey), 'исходный хоткей занят', before.hotkey);

  const r = await call(`window.puuush.saveSettings({ hotkey: 'Control+Alt+Q' })`);
  step(r.hotkeyApplied === false, 'ответ: hotkeyApplied false', String(r.hotkeyApplied));
  step(r.hotkey === before.hotkey, 'ответ несёт откатанное значение', r.hotkey);
  const disk = JSON.parse(fs.readFileSync(path.join(ud, 'settings.json'), 'utf8'));
  step(disk.hotkey === before.hotkey, 'на диске прежняя комбинация', disk.hotkey);
  step(globalShortcut.isRegistered(before.hotkey), 'прежняя комбинация снова занята', '');
  step(globalShortcut.isRegistered(before.imageHotkey), 'вторая комбинация не потеряна', '');
  step(!globalShortcut.isRegistered('Control+Alt+Q'), 'занятая не числится зарегистрированной', '');

  // Свободная комбинация сохраняется как раньше.
  const ok = await call(`window.puuush.saveSettings({ hotkey: 'Control+Alt+W' })`);
  step(ok.hotkeyApplied === true && ok.hotkey === 'Control+Alt+W' && globalShortcut.isRegistered('Control+Alt+W'),
    'свободная комбинация применяется', '');

  // Окно настроек не уходит на брошенный в него файл.
  const wins = BrowserWindow.getAllWindows().filter((w) => w !== win && !w.isDestroyed());
  if (wins.length) {
    const w = wins[0];
    const href = w.webContents.getURL();
    await w.webContents.executeJavaScript(`location.href = 'file://${os.tmpdir()}/'`).catch(() => {});
    await sleep(800);
    step(w.webContents.getURL() === href, 'навигация окна настроек запрещена', w.webContents.getURL());
  } else {
    step(false, 'окно настроек для проверки навигации не найдено', '');
  }

  win.destroy();
  try { fs.rmSync(ud, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }); } catch (e) { /* уберёт система */ }
  const failed = results.filter((x) => !x).length;
  console.log(failed ? `  провалено: ${failed}` : '  все проверки пройдены');
  app.exit(failed ? 1 : 0);
});

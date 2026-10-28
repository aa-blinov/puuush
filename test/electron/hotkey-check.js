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
const main = require(path.join(SRC, 'main.js'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  await sleep(1500);
  // Занятая комбинация: приложение отказывается её занимать.
  // Занятая комбинация. Раньше здесь стояло 'Control+Alt+Q', и на части
  // машин она оказывалась свободной: подмена register тогда не срабатывала,
  // и проверка «занятая не занята» падала по чужой причине.
  const BUSY = 'Control+Alt+Q';
  const taken = new Set([BUSY]);
  const realRegister = globalShortcut.register.bind(globalShortcut);
  globalShortcut.register = (acc, fn) => (taken.has(acc) ? false : realRegister(acc, fn));


  const win = new BrowserWindow({
    show: false,
    webPreferences: { preload: path.join(SRC, 'preload.js'), contextIsolation: true },
  });
  await win.loadFile(path.join(SRC, 'renderer', 'settings.html'));
  const call = (code) => win.webContents.executeJavaScript(code, true);

  // Комбинации для проверки берутся те, что свободны на этой машине.
  //
  // Раньше проверка требовала, чтобы сочетания по умолчанию были заняты
  // приложением, а на машине, где их держит другая программа, проверка
  // падала: «исходный хоткей занят» оказывалось правдой, но по чужой
  // причине, и дальше всё рассыпалось. Теперь сочетания назначаются
  // настройками, и проверка не зависит от того, что запущено на столе.
  const free = (acc) => {
    const ok = globalShortcut.register(acc, () => {});
    if (ok) globalShortcut.unregister(acc);
    return ok;
  };
  const pickFree = (base) => {
    for (const suffix of ['', 'F13', 'F14', 'F15', 'F16']) {
      const acc = base + suffix;
      if (free(acc)) return acc;
    }
    return null;
  };
  const first = pickFree('Control+Alt+1');
  const second = pickFree('Control+Alt+2');
  const third = pickFree('Control+Alt+3');
  if (!first || !second || !third) {
    console.log('  ПРОВАЛ: на этой машине не нашлось трёх свободных сочетаний');
    app.exit(1);
    return;
  }
  await win.webContents.executeJavaScript(
    `window.puuush.saveSettings({ hotkey: ${JSON.stringify(first)}, imageHotkey: ${JSON.stringify(second)}, recordHotkey: ${JSON.stringify(third)} })`,
    true
  );
  await sleep(600);

  const before = await call(`window.puuush.getSettings()`);
  step(globalShortcut.isRegistered(before.hotkey), 'исходный хоткей занят', before.hotkey);
  step(globalShortcut.isRegistered(before.imageHotkey), 'вторая комбинация занята', before.imageHotkey);
  step(globalShortcut.isRegistered(before.recordHotkey), 'третья комбинация занята', before.recordHotkey);

  const r = await call(`window.puuush.saveSettings({ hotkey: ${JSON.stringify(BUSY)} })`);
  step(r.hotkeyApplied === false, 'ответ: hotkeyApplied false', String(r.hotkeyApplied));
  step(globalShortcut.isRegistered(before.hotkey), 'прежняя комбинация на месте после отказа', '');
  step(r.hotkey === before.hotkey, 'ответ несёт откатанное значение', r.hotkey);
  const disk = JSON.parse(fs.readFileSync(path.join(ud, 'settings.json'), 'utf8'));
  step(disk.hotkey === before.hotkey, 'на диске прежняя комбинация', disk.hotkey);
  step(globalShortcut.isRegistered(before.hotkey), 'прежняя комбинация снова занята', '');
  step(globalShortcut.isRegistered(before.imageHotkey), 'вторая комбинация не потеряна', '');
  step(!globalShortcut.isRegistered(BUSY), 'занятая не числится зарегистрированной', '');

  // Свободная комбинация сохраняется как раньше.
  const ok = await call(`window.puuush.saveSettings({ hotkey: 'Control+Alt+W' })`);
  step(ok.hotkeyApplied === true && ok.hotkey === 'Control+Alt+W' && globalShortcut.isRegistered('Control+Alt+W'),
    'свободная комбинация применяется', '');

  // Окно настроек не уходит на брошенный в него файл.
  // Окно открывается по требованию человека, и в тесте его надо открыть
  // самому: раньше проверка искала его среди чужих окон и не находила,
  // потому что трей-приложение его само не открывает.
  // Окно настроек открывает сам главный процесс: только у него стоит
  // защита от навигации, и проверять надо именно её.
  const settings = main.openSettings();
  await sleep(600);
  const w = settings;
  {
    const href = w.webContents.getURL();
    await w.webContents.executeJavaScript(`location.href = 'file://${os.tmpdir()}/'`).catch(() => {});
    await sleep(800);
    step(w.webContents.getURL() === href, 'навигация окна настроек запрещена', w.webContents.getURL());
  }

  win.destroy();
  try { fs.rmSync(ud, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }); } catch (e) { /* уберёт система */ }
  const failed = results.filter((x) => !x).length;
  console.log(failed ? `  провалено: ${failed}` : '  все проверки пройдены');
  app.exit(failed ? 1 : 0);
});

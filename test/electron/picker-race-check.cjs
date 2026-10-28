 'use strict';
/**
 * Ответ окна выбора, пришедший после его закрытия, не роняет приложение.
 *
 * На экране живут несколько окон выбора. Когда на одном из них область
 * выбрана, остальные закрываются. Ответ от них может прийти уже после
 * закрытия, и раньше это давало «Object has been destroyed» в обработчике
 * IPC: Electron показывал модальное окно ошибки поверх всего, и приложение
 * выглядело упавшим.
 *
 *     npm run test:electron
 */
const path = require('node:path');
const { app, BrowserWindow, ipcMain, nativeImage, screen } = require('electron');

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

app.whenReady().then(async () => {
  const { pickRegion } = require(path.join(SRC, 'capture.js'));
  const displays = screen.getAllDisplays().slice(0, 2);
  const image = nativeImage.createFromDataURL(
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
  );
  const frames = displays.map((display) => ({
    display,
    image,
    ratio: { x: 1, y: 1 },
  }));
  if (!frames.length) {
    console.log('  ПРОВАЛ: нет экранов');
    app.exit(1);
    return;
  }

  // id окон запоминаются до выбора: после закрытия к webContents уже не
  // обратиться, и именно это раньше роняло обработчик.
  let picked = false;
  const senderIds = [];
  const p = pickRegion(frames).then((v) => {
    picked = true;
    return v;
  });

  await sleep(1500);
  const wins = BrowserWindow.getAllWindows().filter((w) => w.webContents.getURL().includes('overlay.html'));
  for (const w of wins) senderIds.push(w.webContents.id);
  console.log(`  ${wins.length > 0 ? 'ОК  ' : 'ПРОВАЛ'} окна выбора открылись: ${wins.length}`);

  // Выбираем на последнем окне.
  const last = wins[wins.length - 1];
  await last.webContents.executeJavaScript(
    "window.puuush.submitRegion({ x: 10, y: 10, width: 50, height: 40 })",
    true
  );
  const result = await Promise.race([p, sleep(8000).then(() => null)]);
  console.log(`  ${result ? 'ОК  ' : 'ПРОВАЛ'} выбор вернул область`);

  const left = BrowserWindow.getAllWindows().filter((w) => w.webContents.getURL().includes('overlay.html')).length;
  console.log(`  ${left === 0 ? 'ОК  ' : 'ПРОВАЛ'} остальные окна закрыты: осталось ${left}`);

  // Тот самый ответ «из закрытого окна»: шлём событие с id отправителя,
  // которого уже нет. Прежний код обращался здесь к уничтоженному окну и
  // бросал исключение.
  let threw = null;
  try {
    for (const id of senderIds) {
      ipcMain.emit('puuush:region', { sender: { id } }, { x: 0, y: 0, width: 10, height: 10 });
    }
  } catch (e) {
    threw = e;
  }
  console.log(`  ${threw ? 'ПРОВАЛ' : 'ОК  '} ответ из закрытого окна не роняет процесс${threw ? ': ' + threw.message : ''}`);

  // Ответ, пришедший из чужого окна, не должен завершать выбор: у каждого
  // окна своя подписка, и сравнение по числовому id сохраняет это правило.
  let foreignThrew = null;
  try {
    ipcMain.emit('puuush:region', { sender: { id: 999999 } }, { x: 0, y: 0, width: 11, height: 11 });
  } catch (e) {
    foreignThrew = e;
  }
  console.log(`  ${foreignThrew ? 'ПРОВАЛ' : 'ОК  '} ответ из чужого окна игнорируется${foreignThrew ? ': ' + foreignThrew.message : ''}`);

  // Ждём немного: ошибка из обработчика пришла бы асинхронно.
  await sleep(300);
  app.exit(picked && left === 0 && !threw && !foreignThrew ? 0 : 1);
});

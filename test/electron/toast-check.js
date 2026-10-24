/**
 * Всплывашка «лежит в буфере»: появляется, не берёт фокус, заменяет прежнюю
 * и исчезает сама. Текст из чужого ответа (ссылка с сервера) в разметку
 * попадает экранированным.
 *
 * Запуск: npm run test:electron
 */
const path = require('path');
const { app, BrowserWindow } = require('electron');
const { showToast } = require(path.join(__dirname, '..', '..', 'src', 'toast.js'));
app.on('window-all-closed', () => {});
process.on('unhandledRejection', (e) => {
  console.error('  ПРОВАЛ необработанная ошибка: ' + (e && e.message ? e.message : e));
  process.exit(1);
});
setTimeout(() => { console.error('  ПРОВАЛ: не уложилась в минуту'); process.exit(1); }, 60000).unref?.();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let bad = 0;
const check = (ok, name, note = '') => { if (!ok) bad++; console.log(`  ${ok ? 'ОК   ' : 'ПРОВАЛ'} ${name} ${note}`); };

app.whenReady().then(async () => {
  const first = showToast('Link copied', 'https://x.example/a.png', 900);
  await sleep(700);
  check(first.isVisible(), 'плашка видна');
  check(!first.isFocused(), 'плашка не берёт фокус');

  if (process.env.TOAST_SHOT) {
    const img = await first.webContents.capturePage();
    require('fs').writeFileSync(process.env.TOAST_SHOT, img.toPNG());
  }

  const second = showToast('<img src=x onerror=document.title=1>', '"><b>', 900);
  await sleep(200);
  check(first.isDestroyed(), 'новая плашка заменяет прежнюю');
  await sleep(600);
  const html = await second.webContents.executeJavaScript('document.body.innerHTML');
  check(!/<img|<b>/.test(html), 'текст экранирован', '');
  await sleep(800);
  check(second.isDestroyed(), 'плашка исчезла сама');
  check(BrowserWindow.getAllWindows().length === 0, 'окон не осталось');
  app.exit(bad ? 1 : 0);
});

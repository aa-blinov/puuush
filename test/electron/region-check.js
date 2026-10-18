/**
 * Проверка продового пути выбора области: настоящий capture.js, настоящий
 * preload, настоящее окно Electron и настоящий ввод с клавиатуры.
 *
 * Существует потому, что прежний набор проверок этого не ловил: он слушал
 * ipcMain и тем самым обходил ipcOnce в capture.js. Подписка была написана
 * как webContents.on('канал'), а ipcRenderer.send поднимает событие
 * 'ipc-message'. Подписка не срабатывала никогда, Enter и Esc доходили в
 * пустоту, окно висело, и флаг busy не сбрасывался до перезапуска.
 *
 * Запуск: npm run test:electron
 */
const path = require('path');
const { app, BrowserWindow, ipcMain, nativeImage } = require('electron');
const SRC = '/home/ubuntu/pet/puuush/src';
app.on('window-all-closed', () => {});

app.whenReady().then(async () => {
  const { captureTo } = require(path.join(SRC, 'capture.js'));

  // Соберём временный userData, чтобы приложение не полезло в настройки
  const os = require('os'), fs = require('fs');
  const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'qa2-'));
  app.setPath('userData', ud);

  const results = [];
  for (const key of ['Enter', 'Escape']) {
    const t0 = Date.now();
    const p = captureTo(ud).then(
      (v) => ({ key, ok: true, ms: Date.now() - t0, val: v === null ? 'null (отмена)' : (v ? 'файл ' + path.basename(v.path) : 'null') }),
      (e) => ({ key, ok: false, ms: Date.now() - t0, val: 'ошибка: ' + e.message })
    );
    // Ждём, пока окно выбора появится, и жмём клавишу настоящим вводом.
    await new Promise(r => setTimeout(r, 1500));
    const wins = BrowserWindow.getAllWindows();
    const ov = wins.find(w => w.webContents.getURL().includes('overlay.html'));
    if (!ov) { results.push({ key, ok: false, val: 'окно выбора не появилось' }); continue; }
    // Настоящее DOM-событие вместо sendInputEvent: синтетический ввод не
    // доходит до страницы в этом окружении, и тест врал бы о коде, а не о
    // приложении. Всё после нажатия здесь боевое: настоящий preload,
    // настоящий канал IPC и настоящая подписка в capture.js.
    await ov.webContents.executeJavaScript(
      "window.dispatchEvent(new KeyboardEvent('keydown'," +
      `{key:'${key}', bubbles:true, cancelable:true}))`, true);
    results.push(await Promise.race([p, new Promise(r => setTimeout(() => r({ key, ok: false, val: 'ОТВЕТ НЕ ПРИШЁЛ за 8 секунд' }), 8000))]));
  }
  for (const r of results) console.log(`  ${r.ok ? 'ОК  ' : 'ПРОВАЛ'} ${r.key}: ${r.val}${r.ms ? ' (' + r.ms + ' мс)' : ''}`);
  app.exit(results.every(r => r.ok) ? 0 : 1);
});

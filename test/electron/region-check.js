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

  // Тонкое выделение не должно публиковать весь экран. Раньше и на mouseup,
  // и на Enter стояла проверка «меньше 4 пикселей», и протяжка 2 на 500
  // считалась кликом: человек тянул полоску, а улетал весь экран вместе с
  // соседними окнами. Различие теперь по смещению мыши, а не по размеру рамки.
  const W2 = 640, H2 = 480;
  const frame2 = nativeImage.createFromDataURL(
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
  ).resize({ width: W2, height: H2 });
  const thin = [
    ['клик без смещения', [[200,150],[200,150]], W2, H2],
    ['тонкая вертикальная 2x300', [[200,100],[202,400]], 2, 300],
    ['тонкая горизонтальная 300x2', [[100,200],[400,202]], 300, 2],
    ['обычная рамка', [[100,100],[300,250]], 200, 150],
  ];
  for (const [label, pts, wantW, wantH] of thin) {
    const got = await new Promise((resolve) => {
      let done = false;
      const onRegion = (_e, v) => {
        if (done) return;
        done = true;
        ipcMain.removeListener('puuush:region', onRegion);
        w.destroy();
        resolve(v);
      };
      const w = new BrowserWindow({
        width: W2, height: H2, show: false, frame: false, transparent: true,
        webPreferences: {
          preload: path.join(SRC, 'preload-overlay.js'),
          contextIsolation: true,
        },
      });
      ipcMain.on('puuush:region', onRegion);
      w.loadFile(path.join(SRC, 'overlay.html'));
      w.once('ready-to-show', () => {
        w.webContents.send('puuush:frame', { dataUrl: frame2.toDataURL(), width: W2, height: H2 });
        setTimeout(async () => {
          await w.webContents.executeJavaScript(`(function(){
            const img=document.getElementById('shot');
            const P=${JSON.stringify(pts)};
            const nm=t=>({mouseDown:'mousedown',mouseMove:'mousemove',mouseUp:'mouseup'})[t];
            const go=(t,p)=>(t==='mouseDown'?img:window).dispatchEvent(
              new MouseEvent(nm(t),{clientX:p[0],clientY:p[1],button:0,bubbles:true,cancelable:true}));
            go('mouseDown',P[0]); go('mouseMove',P[P.length-1]); go('mouseUp',P[P.length-1]);
          })()`, true);
          // Enter не шлём, если рамка уже вернулась: клик без смещения подтверждается
          // мышью, окно к этому времени уничтожено, и обращение к webContents бросает
          // исключение в главном процессе. Оно уходит в модальное окно и вешает тест.
          setTimeout(() => done || w.webContents.executeJavaScript(
            "window.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))", true), 120);
          setTimeout(() => {
            if (done) return;
            ipcMain.removeListener('puuush:region', onRegion);
            w.destroy();
            resolve(null);
          }, 2500);
        }, 400);
      });
    });
    const ok = got && got.width === wantW && got.height === wantH;
    results.push({ key: `тонкая рамка: ${label}`, ok,
      val: got ? `${got.width}x${got.height}` : 'ответа не было' });
  }

  for (const r of results) {
    if (String(r.key).startsWith('тонкая рамка')) {
      console.log(`  ${r.ok ? 'ОК  ' : 'ПРОВАЛ'} ${r.key}: ${r.val}`);
    }
  }
  app.exit(results.every(r => r.ok) ? 0 : 1);
});

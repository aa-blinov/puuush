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
// Путь к приложению считается от файла теста, а не пишется руками: с
// зашитым путём тест молча падал на чужой машине, и проверка в CI висела
// до конца запуска, потому что исключение было необработанным.
const SRC = path.join(__dirname, '..', '..', 'src');
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
  const { captureTo } = require(path.join(SRC, 'capture.js'));

  // Соберём временный userData, чтобы приложение не полезло в настройки
  const os = require('os'), fs = require('fs');
  const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'qa2-'));
  app.setPath('userData', ud);

  const results = [];
  // Сколько окон выбора открылось на экраны.
  let pickerCount = 0;
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
    // Дальше ждём не время, а снимок экрана в окне. На медленной машине окно
    // грузится дольше полутора секунд, и Enter уходил в пустоту: размер
    // экрана ещё был неизвестен, а вслепую отправлять нечего.
    const deadline = Date.now() + 20000;
    let gotFrame = false;
    while (Date.now() < deadline) {
      gotFrame = await ov.webContents
        .executeJavaScript("!!document.querySelector('img.shot')", true)
        .catch(() => false);
      if (gotFrame) break;
      await new Promise(r => setTimeout(r, 200));
    }
    if (!gotFrame) { results.push({ key, ok: false, val: 'снимок экрана не пришёл' }); continue; }
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
      w.loadFile(path.join(SRC, 'renderer', 'overlay.html'));
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

  // Снимок делается сразу по отпусканию мыши: Enter нажимать не надо.
  // Число окон выбора считается здесь, пока они живы.
  // Прежде окно ждало Enter, и это читалось как «выделение не сработало».
  const shotOnRelease = await new Promise((resolve) => {
    const ud2 = fs.mkdtempSync(path.join(os.tmpdir(), 'qa3-'));
    let done = false;
    const p2 = captureTo(ud2).then(
      (v) => { if (!done) { done = true; resolve(v); } },
      () => { if (!done) { done = true; resolve(null); } }
    );
    setTimeout(async () => {
      const ov = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('overlay.html'));
      if (!ov) return;
      // Сколько окон выбора открылось: по одному на экран.
      pickerCount = BrowserWindow.getAllWindows().filter((w) => w.webContents.getURL().includes('overlay.html')).length;
      const dl = Date.now() + 20000;
      while (Date.now() < dl) {
        const ok = await ov.webContents.executeJavaScript("!!document.querySelector('img.shot')", true).catch(() => false);
        if (ok) break;
        await new Promise((r) => setTimeout(r, 200));
      }
      const wc = ov.webContents;
      const mouse = (type, x, y) => wc.sendInputEvent({ type, x, y, button: 'left', clickCount: 1 });
      mouse('mouseDown', 120, 90);
      for (let i = 1; i <= 8; i++) {
        mouse('mouseMove', 120 + i * 30, 90 + i * 20);
        await new Promise((r) => setTimeout(r, 20));
      }
      mouse('mouseUp', 360, 250);
      // Enter не нажимаем: снимок должен прийти сам.
      const res = await Promise.race([p2, new Promise((r) => setTimeout(() => r('нет ответа'), 8000))]);
      if (!done) { done = true; resolve(res === 'нет ответа' ? null : res); }
    }, 2500);
  });
  results.push({
    key: 'снимок сразу по отпусканию мыши',
    ok: !!(shotOnRelease && shotOnRelease !== 'нет ответа'),
    val: shotOnRelease && shotOnRelease !== 'нет ответа'
      ? path.basename(shotOnRelease.path)
      : 'ответа не было',
  });

  // Окно выбора открывается на каждом экране сразу: на двух мониторах
  // выбрать было нечего, потому что окно открывалось только на том, где стоял
  // курсор.
  // Окна выбора живут только во время выбора: к этому моменту выбор уже
  // закончен и они закрыты. Поэтому число окон считается во время выбора.
  const screens = require('electron').screen.getAllDisplays().length;
  const pickers = pickerCount;
  results.push({
    key: 'окно выбора на каждом экране',
    ok: pickers === screens && screens > 0,
    val: `${pickers} окон на ${screens} экранах`,
  });

  for (const r of results) {
    if (String(r.key).startsWith('тонкая рамка') || String(r.key).startsWith('снимок сразу') || String(r.key).startsWith('окно выбора')) {
      console.log(`  ${r.ok ? 'ОК  ' : 'ПРОВАЛ'} ${r.key}: ${r.val}`);
    }
  }
  app.exit(results.every(r => r.ok) ? 0 : 1);
});

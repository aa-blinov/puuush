'use strict';
/**
 * Диагностика: puuush --selftest
 *
 * Прогоняет на себе всё, что нельзя проверить чтением кода: берёт экран,
 * режет область, создаёт трей, занимает хоткей и заливает файл. Нужна на
 * сервере без монитора и после обновления Electron.
 *
 * Состояние приложения (трей, хоткеи, IPC) принадлежит main.js и приходит
 * сюда готовыми функциями: так этот файл не знает, как они устроены.
 */

const path = require('node:path');
const fs = require('node:fs');
const { BrowserWindow } = require('electron');
const store = require('./store');
const { t, setLang } = require('./i18n');
const { publish } = require('./upload');

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
          problem = t('selftest.checkFailed', { error: e.message });
        }
        finish(typeof problem === 'string' ? problem : '');
      }, 1500);
    });

    win.loadFile(path.join(__dirname, file)).catch((e) =>
      finish(t('selftest.fileNotLoaded', { error: e.message }))
    );
    setTimeout(() => finish(t('selftest.windowTimeout')), 10000);
  });
}

/** Крошечный настоящий PNG 1x1: проверяем загрузку без настоящего снимка экрана. */
function png1px() {
  return Buffer.from(
    '89504e470d0a1a0a0000000d4948445200000001000000010806000000' +
    '1f15c4890000000a49444154789c6360000002000100ffff03000006000557bfabd4' +
    '0000000049454e44ae426082',
    'hex'
  );
}

async function runSelfTest({ registerIpc, startTray, trayImage, applyHotkeys, hostLabel }) {
  const rows = [];
  const step = (ok, name, note) => rows.push({ ok, name, note });
  const s = store.getSettings();
  setLang(s.lang);
  registerIpc(); // окно настроек ходит в IPC, без них оно не инициализируется

  try {
    const { grabAllDisplays, displayUnderCursor } = require('./capture');
    const display = displayUnderCursor();
    const frames = await grabAllDisplays();
    const frame = frames.find((f) => f.display.id === display.id) || frames[0];
    const { image, ratio } = frame;
    const size = image.getSize();
    // Пишем и запрошенный масштаб, и фактическое отношение: расхождение между
    // ними — признак дробного масштабирования на Linux, и его полезно видеть.
    const wanted = (display.scaleFactor || 1);
    step(true, t('selftest.capture'),
      `${frames.length} ${t('selftest.screens')}, ${size.width}x${size.height} px, ` +
      t('selftest.frameNote', { ratio: ratio.x.toFixed(2) }) +
      (Math.abs(ratio.x - wanted) > 0.01
        ? t('selftest.scaleNote', { scale: wanted })
        : ''));

    const cut = image.crop({
      x: Math.round(size.width * 0.1),
      y: Math.round(size.height * 0.1),
      width: Math.max(1, Math.round(size.width * 0.25)),
      height: Math.max(1, Math.round(size.height * 0.25)),
    });
    // Режем кусок экрана, чтобы проверить сам механизм нарезки, но наружу
    // его не отправляем: selftest обычно запускают в cron, и настоящий снимок
    // экрана, улетающий на публичный хостинг по расписанию, это утечка, о
    // которой README не говорит ни слова.
    const file = path.join(store.shotsDir(), 'selftest.png');
    fs.writeFileSync(file, cut.toPNG());
    step(fs.statSync(file).size > 0, t('selftest.crop'),
      `${cut.getSize().width}x${cut.getSize().height} -> ${file}`);

    // Трея в системе может не быть вовсе. Падение трея считается ошибкой
    // намеренно: без трея приложением нечем управлять, и cron-проверка
    // должна показать это красным, а не тихо пройти.
    try {
      startTray();
      step(true, t('selftest.tray'),
        t('selftest.trayIcon', { state: trayImage().isEmpty() ? t('selftest.not') : '' }));
    } catch (e) {
      step(false, t('selftest.tray'), t('selftest.noTray', { error: e.message }));
    }

    const hot = applyHotkeys();
    step(hot.hotkey, t('selftest.hotkey'),
      hot.hotkey
        ? t('selftest.hotkeyOk', { hotkey: s.hotkey })
        : t('selftest.hotkeyFail', { hotkey: s.hotkey }));
    step(hot.imageHotkey, t('selftest.hotkey'),
      hot.imageHotkey
        ? t('selftest.hotkeyOk', { hotkey: s.imageHotkey })
        : t('selftest.hotkeyFail', { hotkey: s.imageHotkey }));
    step(hot.recordHotkey, t('selftest.recordHotkey'),
      hot.recordHotkey
        ? t('selftest.hotkeyOk', { hotkey: s.recordHotkey })
        : t('selftest.hotkeyFail', { hotkey: s.recordHotkey }));

    // Наружу уходит сгенерированная картинка 1x1, а не кусок экрана. Свой
    // сервер настроен не всегда, а откат на catbox с настоящим снимком экрана
    // внутри противоречит тому, ради чего приложение писалось.
    const probeFile = path.join(store.shotsDir(), 'selftest-upload.png');
    fs.writeFileSync(probeFile, png1px());
    try {
      const r = await publish(probeFile, { host: s.host, own: s.own, onStep: () => {} });
      step(true, t('selftest.upload'), `${r.url} (${hostLabel(r.host)})`);
    } finally {
      try { fs.unlinkSync(probeFile); } catch (e) { /* не мешает */ }
      try { fs.unlinkSync(file); } catch (e) { /* не мешает */ }
    }

    const setErr = await checkRenderer('renderer/settings.html', `
      (function () {
        var h = document.getElementById('hotkey');
        var sel = document.getElementById('host');
        if (!h || !sel) return ${JSON.stringify(t('selftest.noHotkeyOrHost'))};
        if (!h.value) return ${JSON.stringify(t('selftest.noHotkeyValue'))};
        if (sel.options.length < 4) return ${JSON.stringify(t('selftest.hostOptions', { count: '' }))} + sel.options.length;
        if (document.getElementById('ownBox').style.display === 'none')
          return ${JSON.stringify(t('selftest.ownBoxHidden', { mode: '' }))} + sel.value;
        return '';
      })()
    `);
    step(setErr.length === 0, t('selftest.settingsWindow'),
      setErr.length ? setErr.join(' | ') : t('selftest.loadsOk'));

    const ovErr = await checkRenderer('renderer/overlay.html',
      `typeof window.puuush.submitRegion === 'function' ? '' : ${JSON.stringify(t('selftest.noBridge'))}`);
    step(ovErr.length === 0, t('selftest.overlayWindow'),
      ovErr.length ? ovErr.join(' | ') : t('selftest.loadsOk'));
  } catch (e) {
    step(false, t('selftest.failure'), e.message);
  }

  const w = Math.max(...rows.map((r) => r.name.length));
  for (const r of rows) {
    process.stdout.write(
      `${r.ok ? '  OK  ' : ' FAIL '}  ${r.name.padEnd(w)}  ${r.note || ''}\n`
    );
  }
  const failed = rows.filter((r) => !r.ok).length;
  process.exit(failed ? 1 : 0);
}

module.exports = { runSelfTest };

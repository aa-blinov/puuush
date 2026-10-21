'use strict';
/**
 * Захват области экрана.
 *
 * Скриншот берётся ДО появления окна выбора — иначе окно попадёт в кадр и мы
 * будем выбирать область на картинке, внутри которой это же окно. Дальше
 * показываем прозрачное полноэкранное окно с этим снимком, пользователь тянет
 * рамку, а мы режем исходный nativeImage, а не картинку из renderer.
 *
 * Нативных модулей нет намеренно: иначе три отдельные сборки вместо одной.
 */

const path = require('node:path');
const fs = require('node:fs');
const { desktopCapturer, screen, BrowserWindow, nativeImage } = require('electron');

/** Экран, на котором сейчас курсор. */
function displayUnderCursor() {
  return screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
}

/** Снимок экрана в физических пикселях (с учётом масштаба Retina). */
async function grabDisplay(display) {
  const scale = display.scaleFactor || 1;
  const size = {
    width: Math.round(display.size.width * scale),
    height: Math.round(display.size.height * scale),
  };
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: size,
    fetchWindowIcons: false,
  });
  if (!sources.length) throw new Error('не удалось получить список экранов');

  // Ищем именно тот экран, где стоит курсор. Раньше при несовпадении
  // брался sources[0], то есть первый попавшийся: на двух мониторах окно
  // выбора открывалось на одном экране, а резался снимок другого. Молча.
  const src = sources.find((s) => String(s.display_id) === String(display.id));
  if (!src) {
    const seen = sources.map((s) => s.display_id || '(пусто)').join(', ');
    throw new Error(
      `не нашёл экран ${display.id} среди источников (есть: ${seen}). ` +
      'На двух мониторах это иногда значит, что снимок взялся бы не с того ' +
      'экрана, где выбираешь область'
    );
  }

  const image = src.thumbnail;
  if (!image || image.isEmpty()) throw new Error('экран вернул пустой снимок');

  // Масштаб берём не из display.scaleFactor, а из фактического размера кадра.
  // Запрашиваемый размер и пришедший совпадают не всегда: на Linux с
  // дробным масштабированием, на мониторе без честного HiDPI или когда
  // композитор ужимает кадр, Electron отдаёт другое число. Если считать по
  // запрошенному, рамка вырежет не то место, и это не видно нигде.
  const got = image.getSize();
  const ratio = {
    x: got.width / (display.bounds.width || 1),
    y: got.height / (display.bounds.height || 1),
  };
  return { image, ratio, size: got };
}

/**
 * Показывает окно выбора области и ждёт результат.
 * Возвращает прямоугольник в физических пикселях снимка или null при отмене.
 */
function pickRegion(image, display, ratio) {
  return new Promise((resolve) => {
    const win = new BrowserWindow({
      x: display.bounds.x,
      y: display.bounds.y,
      width: display.bounds.width,
      height: display.bounds.height,
      frame: false,
      transparent: true,
      hasShadow: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      show: false,
      backgroundColor: '#00000000',
      enableLargerThanScreen: true,
      webPreferences: {
        // Не preload.js: окно выбора не должно видеть ключ и загрузку файлов.
        preload: path.join(__dirname, 'preload-overlay.js'),
        contextIsolation: true,
        nodeIntegration: false,
      },
    });

    let settled = false;
    let offRegion = null;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      if (offRegion) offRegion();
      if (!win.isDestroyed()) win.destroy();
      resolve(value);
    };

    win.on('closed', () => finish(null));
    win.webContents.on('render-process-gone', () => finish(null));

    // Выше всего, включая поверх полноэкранных приложений.
    win.setAlwaysOnTop(true, 'screen-saver');
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

    offRegion = ipcOnce(win, 'puuush:region', (_e, rect) => {
      if (!rect) return finish(null);
      finish({
        x: Math.max(0, Math.round(rect.x * ratio.x)),
        y: Math.max(0, Math.round(rect.y * ratio.y)),
        width: Math.max(1, Math.round(rect.width * ratio.x)),
        height: Math.max(1, Math.round(rect.height * ratio.y)),
      });
    });

    // Любой исход, кроме ответа из окна выбора, обязан вызывать finish.
    // Если loadFile упадёт или окно почему-то не покажется, промис иначе
    // повиснет навсегда, флаг busy в main не сбросится, и хоткей перестанет
    // работать до перезапуска — молча, без единого сообщения.
    win.loadFile(path.join(__dirname, 'renderer', 'overlay.html')).catch((e) => {
      console.error('окно выбора не загрузилось:', e.message);
      finish(null);
    });

    // Страховка от окна, которое загрузилось, но не нарисовалось. Её нужно
    // снимать, как только окно показалось: иначе выделение, которое тянут
    // дольше минуты, исчезает, и Enter после этого не делает ничего.
    let guard = setTimeout(() => {
      guard = null;
      console.error('окно выбора не показалось за минуту, отменяю');
      finish(null);
    }, 60_000);
    if (guard.unref) guard.unref();

    win.once('ready-to-show', () => {
      if (guard) { clearTimeout(guard); guard = null; }
      win.show();
      win.focus();
      win.webContents.send('puuush:frame', {
        dataUrl: image.toDataURL(),
        width: display.bounds.width,
        height: display.bounds.height,
      });
    });
  });
}

/**
 * Одноразовая подписка на ответ из окна выбора.
 *
 * Подписаться на webContents по имени канала нельзя: ipcRenderer.send()
 * поднимает у webContents событие 'ipc-message', а не событие с именем канала.
 * Проверено замером на установленном Electron: из трёх способов
 * webContents.on('канал'), webContents.ipc.on('канал') и ipcMain.on('канал')
 * срабатывают только два последних. Прежний вариант тихо не срабатывал никогда:
 * Enter и Esc доходили, а finish() их не получал, окно висело, и флаг busy
 * оставался навсегда.
 */
function ipcOnce(win, channel, handler) {
  const ipc = win.webContents.ipc;
  const off = typeof ipc && typeof ipc.on === 'function'
    ? () => ipc.removeListener(channel, wrapped)
    : () => win.webContents.removeListener('ipc-message', wrapped);
  function wrapped(...args) {
    off();
    handler(...args);
  }
  if (typeof ipc === 'object' && typeof ipc.on === 'function') {
    ipc.on(channel, wrapped);
  } else {
    // Запасной путь для версий без webContents.ipc: тот же контракт, но канал
    // приходит вторым аргументом.
    win.webContents.on('ipc-message', (_e, ch, ...rest) => {
      if (ch !== channel) return;
      wrapped(_e, ...rest);
    });
  }
  return off;
}

/**
 * Полный захват: снимок -> выбор области -> резанный PNG на диске.
 * @returns {Promise<{path:string, width:number, height:number, scale:number}|null>}
 *   scale в ответе — отношение физических пикселей кадра к логическим, см. grabDisplay.
 */
async function captureTo(dir) {
  const display = displayUnderCursor();
  const { image, ratio } = await grabDisplay(display);
  const rect = await pickRegion(image, display, ratio);
  if (!rect) return null;

  const cut = image.crop(rect);
  if (cut.isEmpty()) throw new Error('выбранная область пустая');

  const name = `shot-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.png`;
  const file = path.join(dir, name);
  fs.writeFileSync(file, cut.toPNG());
  return { path: file, width: cut.getSize().width, height: cut.getSize().height, scale: ratio.x };
}

module.exports = { captureTo, grabDisplay, displayUnderCursor };

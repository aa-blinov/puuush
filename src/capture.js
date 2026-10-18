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
  const src =
    sources.find((s) => String(s.display_id) === String(display.id)) || sources[0];
  const image = src.thumbnail;
  if (!image || image.isEmpty()) throw new Error('экран вернул пустой снимок');
  return { image, scale, size };
}

/**
 * Показывает окно выбора области и ждёт результат.
 * Возвращает прямоугольник в физических пикселях снимка или null при отмене.
 */
function pickRegion(image, display, scale) {
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
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
      },
    });

    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      if (!win.isDestroyed()) win.destroy();
      resolve(value);
    };

    win.on('closed', () => finish(null));
    win.webContents.on('render-process-gone', () => finish(null));

    // Выше всего, включая поверх полноэкранных приложений.
    win.setAlwaysOnTop(true, 'screen-saver');
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

    ipcOnce(win.webContents, 'puuush:region', (_e, rect) => {
      if (!rect) return finish(null);
      finish({
        x: Math.max(0, Math.round(rect.x * scale)),
        y: Math.max(0, Math.round(rect.y * scale)),
        width: Math.max(1, Math.round(rect.width * scale)),
        height: Math.max(1, Math.round(rect.height * scale)),
      });
    });

    // Любой исход, кроме ответа из окна выбора, обязан вызывать finish.
    // Если loadFile упадёт или окно почему-то не покажется, промис иначе
    // повиснет навсегда, флаг busy в main не сбросится, и хоткей перестанет
    // работать до перезапуска — молча, без единого сообщения.
    win.loadFile(path.join(__dirname, 'overlay.html')).catch((e) => {
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

/** Одноразовая подписка на канал: renderer сам снимает слушателя после ответа. */
function ipcOnce(webContents, channel, handler) {
  const wrapped = (_e, payload) => {
    webContents.removeListener(channel, wrapped);
    handler(_e, payload);
  };
  webContents.on(channel, wrapped);
}

/**
 * Полный захват: снимок -> выбор области -> резанный PNG на диске.
 * @returns {Promise<{path:string, width:number, height:number, scale:number}|null>}
 */
async function captureTo(dir) {
  const display = displayUnderCursor();
  const { image, scale } = await grabDisplay(display);
  const rect = await pickRegion(image, display, scale);
  if (!rect) return null;

  const cut = image.crop(rect);
  if (cut.isEmpty()) throw new Error('выбранная область пустая');

  const name = `shot-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.png`;
  const file = path.join(dir, name);
  fs.writeFileSync(file, cut.toPNG());
  return { path: file, width: cut.getSize().width, height: cut.getSize().height, scale };
}

module.exports = { captureTo, grabDisplay, displayUnderCursor };
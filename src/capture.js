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
 *
 * Резка идёт в пикселях кадра, а не указателя. display.scaleFactor на части
 * систем врёт, поэтому масштаб берётся из фактического размера кадра (см.
 * grabDisplay): иначе снимок на Retina выходит вдвое меньше и не из того места.
 */

const path = require('node:path');
const fs = require('node:fs');
const { desktopCapturer, screen, BrowserWindow, nativeImage, ipcMain } = require('electron');
const { t, getLang } = require('./i18n');

/** Экран, на котором сейчас курсор. */
function displayUnderCursor() {
  return screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
}

/**
 * Желаемый размер снимка экрана в физических пикселях.
 *
 * С учётом масштаба Retina: на Retina кадр вдвое больше логического, и
 * нарезка из него даёт настоящее разрешение экрана.
 */
function frameSize(display) {
  const scale = display.scaleFactor || 1;
  return {
    width: Math.round(display.size.width * scale),
    height: Math.round(display.size.height * scale),
  };
}

/**
 * Снимок экрана в физических пикселях (с учётом масштаба Retina).
 *
 * `sources` передаются снаружи, чтобы набор экранов брался одним вызовом
 * desktopCapturer: каждый вызов стоит сотни миллисекунд, а экранов может
 * быть три.
 */
async function grabDisplay(display, sources, used = new Set()) {
  if (!sources.length) throw new Error(t('capture.noDisplays'));

  // Ищем именно тот экран, которому принадлежит источник. Раньше при
  // несовпадении брался sources[0], то есть первый попавшийся: на двух
  // мониторах окно выбора открывалось на одном экране, а резался снимок
  // другого. Молча.
  const src = matchSource(sources, display, used);
  if (!src) {
    const seen = sources.map((s) => s.display_id || t('capture.empty')).join(', ');
    throw new Error(t('capture.screenNotFound', { id: display.id, seen }));
  }
  used.add(src);

  const image = src.thumbnail;
  if (!image || image.isEmpty()) throw new Error(t('capture.emptyShot'));

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
 * Какой источник принадлежит экрану.
 *
 * display_id — самый надёжный признак, но на части систем он не совпадает с
 * тем, что отдаёт desktopCapturer: там в источнике лежит идентификатор окна,
 * а не экрана. Прежний код в таком случае просто падал, и на втором мониторе
 * снимок не работал вовсе.
 *
 * Поэтому признаков несколько, и проверяются они по убыванию надёжности:
 * идентификатор, имя экрана, пропорции сторон, и только потом — любой
 * свободный источник. Пропорции спасают случай, когда у двух экранов
 * одинаковое имя, а имя — случай, когда у экрана нет display_id вовсе.
 *
 * `used` не даёт отдать один источник двум экранам: иначе снимок второго
 * монитора оказался бы копией первого.
 */
function matchSource(sources, display, used) {
  const free = sources.filter((s) => !used.has(s));
  const byId = free.find((s) => String(s.display_id) === String(display.id));
  if (byId) return byId;

  const byName = free.find((s) => s.name && display.name && s.name === display.name);
  if (byName) return byName;

  const want = (display.bounds.width || 1) / (display.bounds.height || 1);
  const byRatio = free.find((s) => {
    const g = s.thumbnail && s.thumbnail.getSize();
    if (!g || !g.height) return false;
    return Math.abs(g.width / g.height - want) < 0.02;
  });
  if (byRatio) return byRatio;

  return free[0] || null;
}

/**
 * Снимки всех экранов.
 *
 * Все источники берутся одним вызовом desktopCapturer, если экраны
 * одинаковые: вызов стоит сотни миллисекунд, и на трёх мониторах три вызова
 * превращали нажатие в ожидание. Экраны разного размера делятся на группы по
 * размеру кадра, и на каждую группу приходится свой вызов: thumbnailSize у
 * источников общий, и при разных размерах кадр пришлось бы ужимать.
 */
async function grabAllDisplays() {
  const displays = screen.getAllDisplays();
  const groups = new Map();
  for (const display of displays) {
    const size = frameSize(display);
    const key = `${size.width}x${size.height}`;
    if (!groups.has(key)) groups.set(key, { size, displays: [] });
    groups.get(key).displays.push(display);
  }

  const used = new Set();
  const out = [];
  for (const { size, displays: group } of groups.values()) {
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: size,
      fetchWindowIcons: false,
    });
    for (const display of group) {
      const { image, ratio } = await grabDisplay(display, sources, used);
      out.push({ display, image, ratio });
    }
  }
  // Порядок экранов важен для окна выбора: он такой же, как у операционной
  // системы, и человек узнаёт свои мониторы.
  const order = new Map(displays.map((d, i) => [d.id, i]));
  out.sort((a, b) => (order.get(a.display.id) ?? 0) - (order.get(b.display.id) ?? 0));
  return out;
}

/**
 * Окно выбора области на одном экране.
 *
 * Окно не отдаёт результат сразу: оно сообщает координаты в своих
 * логических пикселях, а масштаб и рамку считает тот, кто открыл окно.
 * Так одно и то же окно годится и для обычного экрана, и для Retina.
 */
function openPicker(image, display) {
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
    // На macOS клик по неактивному окну только активирует его и до страницы
    // не доходит. Без этого первая протяжка рамки молча не начинается. Опция
    // описана только для macOS, поэтому в других системах её не передаём.
    ...(process.platform === 'darwin' ? { acceptFirstMouse: true } : {}),
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

  // Окно без рамки и без изменения размера Windows подрезает по рабочей
  // области: снизу не хватало высоты панели задач, и последние 48 точек
  // экрана нельзя было выделить, а подложка не доходила до края. Размер
  // ставим явно, признак «не изменяется» возвращаем сразу после этого.
  try {
    win.setResizable(true);
    win.setBounds(display.bounds);
    win.setResizable(false);
  } catch (e) {
    /* система не дала выставить точные границы, окно останется как есть */
  }

  let offRegion = null;
  let guard = null;
  const offFrame = [];

  // Файл, брошенный в окно, иначе превращает его в просмотр этого файла.
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  // Закрытие окна любым путём снимает подписку: иначе слушатель остаётся
  // висеть на канал и держит ссылку на мёртвое окно.
  win.once('closed', () => {
    if (offRegion) { offRegion(); offRegion = null; }
  });

  // Выше всего, включая поверх полноэкранных приложений.
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  // Ответ из окна выбора.
  //
  // Подписка делается на ipcMain, а не на webContents.ipc: главный процесс
  // слушает канал у себя, а окно шлёт ответ через ipcRenderer.send. Прежний
  // вариант слушал только webContents.ipc, а это другой канал, и ответ из
  // окна не доходил никогда: окно висело до минуты, а потом закрывалось.
  offRegion = ipcMainOnce('puuush:region', (_e, rect) => {
    if (offRegion) offRegion();
    offRegion = null;
    // Ответ пришёл из этого окна: снимаем выбор. Окно к этому моменту
    // может быть уже уничтожено: другой экран успел выбрать область, и все
    // окна закрываются одним махом.
    if (win.isDestroyed()) return;
    win.emit('puuush:picked', rect || null);
  }, win.webContents.id);

  // Любой исход, кроме ответа из окна выбора, обязан вызвать finish.
  // Если loadFile упадёт или окно почему-то не покажется, промис иначе
  // повиснет навсегда, флаг busy в main не сбросится, и хоткей перестанет
  // работать до перезапуска — молча, без единого сообщения.
  win.loadFile(path.join(__dirname, 'renderer', 'overlay.html')).catch((e) => {
    console.error(t('capture.windowNotLoaded'), e.message);
    win.emit('puuush:picked', null);
  });

  // Страховка от окна, которое загрузилось, но не нарисовалось. Её нужно
  // снимать, как только окно показалось: иначе выделение, которое тянут
  // дольше минуты, исчезает, и Enter после этого не делает ничего.
  guard = setTimeout(() => {
    console.error(t('capture.windowTimeout'));
    win.emit('puuush:picked', null);
  }, 60_000);
  if (guard.unref) guard.unref();

  win.once('ready-to-show', () => {
    if (guard) { clearTimeout(guard); guard = null; }
    win.show();
    // Фокус забирает только то окно, где стоит курсор: иначе на втором
    // мониторе фокус уезжает, и первая протяжка начинается не там.
    if (display.id === screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).id) {
      win.focus();
    }
    win.webContents.send('puuush:frame', {
      // Подложка только показывается, режется оригинал. JPEG кодируется в
      // разы быстрее PNG и весит в разы меньше: на 4K экране PNG в IPC давал
      // секунду ожидания до появления окна.
      dataUrl: 'data:image/jpeg;base64,' + image.toJPEG(85).toString('base64'),
      width: display.bounds.width,
      height: display.bounds.height,
      // Верх рабочей области: под строкой меню на macOS и под верхней панелью
      // на других системах. Подсказку и подпись размера ставим ниже него.
      workTop: display.workArea.y - display.bounds.y,
      // Язык окна едет вместе со снимком: окно открывается на секунды, и
      // отдельный запрос за языком успел бы прийти позже, чем первый кадр.
      lang: getLang(),
    });
  });

  return {
    win,
    /** Закрыть окно и снять все подписки. */
    close() {
      if (guard) { clearTimeout(guard); guard = null; }
      if (offRegion) { offRegion(); offRegion = null; }
      for (const off of offFrame) off();
      if (win.isDestroyed()) return;
      try {
        win.destroy();
      } catch (e) {
        // Окно могло закрыться между проверкой и вызовом: это не ошибка.
      }
    },
  };
}

/**
 * Выбор области сразу на всех экранах.
 *
 * Раньше окно открывалось только на том экране, где стоял курсор, и на втором
 * мониторе выбрать было нечего: человек тянул рамку там, где смотрит, а
 * приложение ждало её на другом экране.
 *
 * Теперь окно открывается на каждом экране, и выбор на любом из них
 * завершает выбор: остальные окна закрываются. Отмена (Esc) на любом экране
 * отменяет всё.
 *
 * @param {Array<{display:object, image:object, ratio:object}>} frames
 * @returns {Promise<{frame:object, rect:object}|null>}
 */
function pickRegion(frames) {
  return new Promise((resolve) => {
    const openers = [];
    let settled = false;

    const finish = (value) => {
      if (settled) return;
      settled = true;
      for (const o of openers) o.close();
      resolve(value);
    };

    for (const frame of frames) {
      const opener = openPicker(frame.image, frame.display);
      openers.push(opener);
      opener.win.on('puuush:picked', (rect) => {
        if (settled) return;
        if (!rect) return finish(null);
        // Прямоугольник приходит в логических пикселях экрана, а резать надо
        // в физических: на Retina это вдвое больше, и рамка вырезала бы
        // половину.
        const r = frame.ratio;
        finish({
          frame,
          rect: {
            x: Math.max(0, Math.round(rect.x * r.x)),
            y: Math.max(0, Math.round(rect.y * r.y)),
            width: Math.max(1, Math.round(rect.width * r.x)),
            height: Math.max(1, Math.round(rect.height * r.y)),
          },
        });
      });
      opener.win.on('closed', () => {
        // Окно закрыли извне: это отмена, как и Esc.
        if (!settled) finish(null);
      });
    }

    // Если экранов не оказалось совсем, ждать нечего.
    if (!openers.length) finish(null);
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
function ipcMainOnce(channel, handler, senderId) {
  const wrapped = (event, payload) => {
    // Ответ приходит от конкретного окна: чужое окно выбора не должно
    // закрывать наш выбор. Сравнивается числовой id, а не объект окна.
    //
    // Раньше здесь стояло `event.sender !== win.webContents`, и когда окно
    // успевало закрыться, обращение к webContents бросало «Object has been
    // destroyed» прямо в обработчике IPC. Electron показывал из-за этого
    // модальное окно ошибки поверх всего, и приложение выглядело упавшим.
    // id отправителя не зависит от того, живо ли окно.
    if (senderId !== undefined && event.sender.id !== senderId) return;
    try {
      handler(event, payload);
    } catch (e) {
      // Ответ уже некому отдать: окно закрылось. Это не повод ронять
      // главный процесс модальным окном.
      console.error(t('capture.pickHandlerFailed'), e && e.message ? e.message : e);
    }
  };
  ipcMain.on(channel, wrapped);
  return () => ipcMain.removeListener(channel, wrapped);
}

/**
 * Только выбор области, без снимка и файла.
 *
 * Нужен записи: рамка задаёт, что попадёт в видео, и сохранять ради этого
 * PNG никто не просил. Возвращаются экран и прямоугольник в логических
 * пикселях экрана: по ним кадр обрезается, а рамка записи встаёт ровно по
 * краю выбранной области.
 */
async function pickArea() {
  const frames = await grabAllDisplays();
  const picked = await pickRegion(frames);
  if (!picked) return null;
  const { frame, rect } = picked;
  const r = frame.ratio;
  return {
    displayId: frame.display.id,
    rect: {
      x: rect.x / r.x,
      y: rect.y / r.y,
      width: rect.width / r.x,
      height: rect.height / r.y,
    },
  };
}

/**
 * Полный захват: снимок -> выбор области -> резанный PNG на диске.
 * @returns {Promise<{path:string, width:number, height:number, scale:number}|null>}
 *   scale в ответе — отношение физических пикселей кадра к логическим, см. grabDisplay.
 */
async function captureTo(dir) {
  const frames = await grabAllDisplays();
  const picked = await pickRegion(frames);
  if (!picked) return null;

  const { frame, rect } = picked;
  const cut = frame.image.crop(rect);
  if (cut.isEmpty()) throw new Error(t('capture.emptyRegion'));

  // С миллисекундами: имя с точностью до секунды перезаписывало предыдущий
  // снимок, если второй успел сняться в ту же секунду.
  const name = `shot-${new Date().toISOString().replace(/[:.]/g, '-')}.png`;
  const file = path.join(dir, name);
  fs.writeFileSync(file, cut.toPNG());
  return {
    path: file,
    width: cut.getSize().width,
    height: cut.getSize().height,
    scale: frame.ratio.x,
  };
}

module.exports = { captureTo, grabDisplay, grabAllDisplays, displayUnderCursor, pickRegion, pickArea };

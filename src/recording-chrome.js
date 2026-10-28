'use strict';
/**
 * Рамка и панель управления записью.
 *
 * Раньше запись была невидимой: человек нажимал хоткей и не знал ни того,
 * что она пошла, ни того, какой экран пишется, ни как её остановить без
 * хоткея. Здесь два окна, которые это исправляют.
 *
 * Рамка — тонкая красная рамка по краю записываемого экрана. Она не берёт
 * мышь (клик уходит в приложение под ней) и не попадает в саму запись:
 * setContentProtection прячет окно от захвата экрана, но оставляет его
 * видимым на мониторе.
 *
 * Панель — маленькая плашка с таймером, паузой и остановкой. Её видно поверх
 * окон, она не воровает фокус при появлении и тоже не попадает в запись.
 */

const path = require('node:path');
const { BrowserWindow, screen, ipcMain } = require('electron');

const FRAME_FILE = path.join(__dirname, 'renderer', 'rec-frame.html');
const PANEL_FILE = path.join(__dirname, 'renderer', 'rec-panel.html');

/** Размер панели: под две кнопки и таймер. */
const PANEL_WIDTH = 212;
const PANEL_HEIGHT = 52;

class RecordingChrome {
  constructor({ onAction = () => {}, lang = 'en' } = {}) {
    this.onAction = onAction;
    // Язык приходит из главного процесса и уезжает в оба окна вместе с
    // состоянием: читать его через sendSync здесь нельзя, у этих окон нет
    // обработчика канала, и ответ приходил бы пустым.
    this.lang = lang;
    this.listener = null;
    this.frames = [];
    this.panel = null;
    this.state = 'recording';
    this.elapsed = 0;
  }

  /**
   * Показать рамку на каждом записываемом экране и панель на первом из них.
   *
   * Экраны приходят в тех же координатах, что и у системы: рамка должна
   * стоять ровно по краю монитора.
   */
  show(rects) {
    this.hide();
    // Кнопки панели приходят сюда же: модуль сам держит канал, пока
    // запись идёт, и снимает его вместе с окнами.
    this.listener = (_e, name) => this.action(name);
    ipcMain.on('puuush:chrome-action', this.listener);
    // Раньше сюда приходили экраны, теперь — прямоугольники: при записи
    // области рамка стоит вокруг области, а не вокруг всего монитора.
    const boxes = rects.map((r) => (r && r.bounds ? r.bounds : r));
    for (const box of boxes) {
      const win = this.createFrame(box);
      if (win) this.frames.push(win);
    }
    this.panel = this.createPanel(boxes[0] || screen.getPrimaryDisplay().bounds);
  }

  createFrame(box) {
    const win = new BrowserWindow({
      x: box.x,
      y: box.y,
      width: box.width,
      height: box.height,
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
      // Окно не должно забирать фокус у того, что человек делает.
      focusable: false,
      show: false,
      backgroundColor: '#00000000',
      enableLargerThanScreen: true,
      webPreferences: {
        preload: path.join(__dirname, 'preload-chrome.js'),
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    win.webContents.on('will-navigate', (e) => e.preventDefault());
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    // Окно без рамки и без изменения размера Windows подрезает по рабочей
    // области: снизу не хватало высоты панели задач, и нижняя граница рамки
    // оказывалась выше края экрана. Размер ставим явно, а признак
    // «не изменяется» возвращаем сразу после этого.
    try {
      win.setResizable(true);
      win.setBounds(box);
      win.setResizable(false);
    } catch (e) {
      /* система не дала выставить точные границы, рамка останется как есть */
    }
    win.setAlwaysOnTop(true, 'screen-saver');
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    // Клик по рамке уходит в приложение под ней: рамка показывает, а не мешает.
    win.setIgnoreMouseEvents(true);
    // Рамка не должна попасть в собственную запись.
    this.protect(win);
    win.loadFile(FRAME_FILE).catch(() => {});
    win.once('ready-to-show', () => {
      if (win.isDestroyed()) return;
      win.showInactive();
      this.sendTo(win, { state: this.state, lang: this.lang });
    });
    return win;
  }

  createPanel(box) {
    const width = PANEL_WIDTH;
    const height = PANEL_HEIGHT;
    const x = Math.round(box.x + (box.width - width) / 2);
    // Панель висит внутри области: у записи региона низ кадра и есть низ
    // области, и уезжать за её край панель не должна.
    const y = Math.round(box.y + box.height - height - 12);
    const win = new BrowserWindow({
      x,
      y,
      width,
      height,
      frame: false,
      transparent: true,
      hasShadow: true,
      resizable: false,
      movable: true,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      show: false,
      backgroundColor: '#00000000',
      webPreferences: {
        preload: path.join(__dirname, 'preload-chrome.js'),
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    win.webContents.on('will-navigate', (e) => e.preventDefault());
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.setAlwaysOnTop(true, 'screen-saver');
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    this.protect(win);
    win.loadFile(PANEL_FILE).catch(() => {});
    win.once('ready-to-show', () => {
      if (win.isDestroyed()) return;
      // showInactive: панель не отбирает фокус у окна, в котором идёт встреча.
      win.showInactive();
      this.sendTo(win, { state: this.state, elapsed: this.elapsed, lang: this.lang });
    });
    return win;
  }

  /**
   * Исключить окно из захвата экрана.
   *
   * На Windows это WDA_EXCLUDEFROMCAPTURE: окно видно на мониторе, но его
   * нет ни на снимке экрана, ни в записи. На macOS окно исключается из
   * общего захвата тем же вызовом. Если система вызов не приняла, запись
   * всё равно идёт: рамка в кадре — косметика, потеря записи — нет.
   */
  protect(win) {
    try {
      win.setContentProtection(true);
    } catch (e) {
      /* старая система или неподдерживаемый вызов */
    }
  }

  sendTo(win, payload) {
    try {
      if (!win.isDestroyed() && win.webContents && !win.webContents.isDestroyed()) {
        win.webContents.send('puuush:chrome-state', payload);
      }
    } catch (e) {
      /* окно уже закрылось */
    }
  }

  /** Состояние и время для обоих окон. */
  update(state, elapsed = 0) {
    this.state = state;
    this.elapsed = elapsed;
    for (const win of this.frames) this.sendTo(win, { state, lang: this.lang });
    if (this.panel) this.sendTo(this.panel, { state, elapsed, lang: this.lang });
  }

  /** Панель нажала кнопку. */
  action(name) {
    try {
      this.onAction(String(name));
    } catch (e) {
      /* обработчик упал, панель закрывать не за что */
    }
  }

  hide() {
    if (this.listener) {
      ipcMain.removeListener('puuush:chrome-action', this.listener);
      this.listener = null;
    }
    for (const win of this.frames) {
      if (win && !win.isDestroyed()) {
        try { win.destroy(); } catch (e) { /* уже закрыто */ }
      }
    }
    this.frames = [];
    if (this.panel && !this.panel.isDestroyed()) {
      try { this.panel.destroy(); } catch (e) { /* уже закрыто */ }
    }
    this.panel = null;
  }
}

module.exports = { RecordingChrome, PANEL_WIDTH, PANEL_HEIGHT };

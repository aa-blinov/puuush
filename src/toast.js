'use strict';
/**
 * Всплывашка «лежит в буфере» в углу экрана.
 *
 * Системное уведомление для этого не годится: на Windows его глушит режим
 * «не беспокоить», на голом Linux его нет вовсе, а человеку нужно знать сразу,
 * что можно вставлять. Окно не берёт фокус и пропускает мышь: оно появляется
 * поверх чужой работы и не должно ей мешать. Это не главное окно приложения:
 * живёт пару секунд и исчезает само.
 */

const { BrowserWindow, screen } = require('electron');

const WIDTH = 340;
const HEIGHT = 76;
const MARGIN = 20;
const SHOWN_MS = 2600;

let current = null;

const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** Страница целиком в data: URL: сборка окон ради одной плашки не нужна. */
function page(title, detail) {
  return `<!doctype html><meta charset="utf-8"><style>
html,body{margin:0;background:transparent;overflow:hidden;font:13px/1.4 ui-monospace,Consolas,Menlo,monospace}
.t{box-sizing:border-box;width:${WIDTH}px;height:${HEIGHT}px;padding:14px 16px;border:1px solid #4a4540;border-radius:6px;
background:#262626;color:#f0e2bd;display:flex;gap:12px;align-items:center;animation:in .16s ease-out}
.ok{flex:none;width:26px;height:26px;border-radius:50%;background:#f0e2bd;color:#262626;display:grid;place-items:center;font-weight:700}
.x{min-width:0}.h{font-weight:600}.d{margin-top:2px;color:#b5a98a;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
@keyframes in{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
</style><div class="t"><div class="ok">✓</div><div class="x"><div class="h">${esc(title)}</div>${
  detail ? `<div class="d">${esc(detail)}</div>` : ''}</div></div>`;
}

/**
 * Показывает плашку и убирает её через пару секунд. Новая заменяет старую:
 * три снимка подряд не должны громоздить три окна.
 */
function showToast(title, detail = '', ms = SHOWN_MS) {
  if (current && !current.isDestroyed()) current.destroy();
  const { workArea } = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const win = new BrowserWindow({
    x: workArea.x + workArea.width - WIDTH - MARGIN,
    y: workArea.y + workArea.height - HEIGHT - MARGIN,
    width: WIDTH,
    height: HEIGHT,
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: false,
    focusable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    show: false,
    backgroundColor: '#00000000',
  });
  current = win;
  win.setIgnoreMouseEvents(true);
  win.setAlwaysOnTop(true, 'screen-saver');
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.once('ready-to-show', () => { if (!win.isDestroyed()) win.showInactive(); });
  win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(page(title, detail)))
    .catch(() => { if (!win.isDestroyed()) win.destroy(); });
  const timer = setTimeout(() => { if (!win.isDestroyed()) win.destroy(); }, ms);
  timer.unref?.();
  win.on('closed', () => { clearTimeout(timer); if (current === win) current = null; });
  return win;
}

module.exports = { showToast };

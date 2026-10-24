'use strict';
/**
 * Разбор строки горячей клавиши в синтаксисе Electron. Чистые функции без
 * Electron: проверяются обычным тестом.
 */

// Модификаторы в синтаксисе Electron. Проверка идёт по разбору строки, а не
// регуляркой по началу: иначе «CommandOrControl+Shift+S» отсекается как
// беспризнаковый, хотя модификатор там есть.
const HOTKEY_MODIFIERS = new Set([
  'command', 'cmd', 'control', 'ctrl', 'commandorcontrol', 'cmdorctrl',
  'alt', 'option', 'altgr', 'shift', 'super', 'meta',
]);

function hasModifier(combo) {
  const parts = String(combo || '').split('+').map((p) => p.trim().toLowerCase());
  if (parts.length < 2) return false;
  // Всё, кроме последнего элемента, обязано быть модификатором.
  const last = parts[parts.length - 1];
  if (!last) return false;
  const mods = parts.slice(0, -1);
  // Shift один не годится: Shift+A перехватил бы набор заглавной A во всех
  // приложениях сразу.
  return mods.every((p) => HOTKEY_MODIFIERS.has(p)) && mods.some((p) => p !== 'shift');
}

module.exports = { hasModifier };

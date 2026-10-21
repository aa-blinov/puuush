/**
 * Запись горячей клавиши.
 *
 * Нажатые клавиши приходят событием, а хранятся строкой вида
 * "CommandOrControl+Shift+K". Здесь обе половины этого дела живут: разбор
 * события в строку и показ строки так, как её записывают в этой системе.
 *
 * Вынесено отдельно от окна, потому что это чистые функции: их можно
 * проверить без Electron.
 */

export const MAC_SYMBOL = {
  Command: '⌘', Cmd: '⌘', CommandOrControl: '⌘', CmdOrCtrl: '⌘',
  Control: '⌃', Ctrl: '⌃', Alt: '⌥', Option: '⌥', AltGr: '⌥', Shift: '⇧',
  Space: 'Space', Backspace: '⌫',
};

/**
 * На Windows и Linux человек символы ⌘ ⌥ ⇧ не узнает, поэтому там остаются
 * слова: Ctrl+Alt+K. Человек не должен гадать, во что превратится
 * CommandOrControl.
 */
export const WORD_NAME = {
  CommandOrControl: 'Ctrl', CmdOrCtrl: 'Ctrl', Control: 'Ctrl', Ctrl: 'Ctrl',
  Command: 'Meta', Cmd: 'Meta', Alt: 'Alt', Option: 'Alt', AltGr: 'AltGr',
  Shift: 'Shift', Space: 'Space', Backspace: 'Backspace',
};

/**
 * Событие нажатия в строку комбинации.
 *
 * Возвращает null, если нажат сам модификатор: нажатие Shift не должно
 * считаться комбинацией.
 */
export function keyFromEvent(event) {
  const parts = [];
  if (event.ctrlKey) parts.push('Control');
  if (event.altKey) parts.push('Alt');
  if (event.shiftKey) parts.push('Shift');
  if (event.metaKey) parts.push('Command');

  let key = event.key;
  if (['Control', 'Alt', 'Shift', 'Meta'].includes(key)) return null;
  if (key === ' ') key = 'Space';
  if (key.length === 1) key = key.toUpperCase();
  parts.push(key);
  return parts.join('+');
}

/** Комбинация так, как её записывают в этой системе. */
export function prettyCombo(combo, isMac) {
  return String(combo || '')
    .split('+')
    .map((key) => {
      if (isMac) return MAC_SYMBOL[key] || (key.length === 1 ? key.toUpperCase() : key);
      return WORD_NAME[key] || (key.length === 1 ? key.toUpperCase() : key);
    })
    .join(isMac ? '' : '+');
}

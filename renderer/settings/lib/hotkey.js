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

// Имена клавиш Electron по event.code. Фиксированные имена, а не event.key:
// на русской раскладке key даёт «Ы» вместо S, с Shift — «!» вместо 1, на macOS
// с Option — «ß», и Electron такой акселератор не принимает.
const CODE_NAME = {
  ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
  Space: 'Space', Enter: 'Return', Escape: 'Escape', Tab: 'Tab',
  Backspace: 'Backspace', Delete: 'Delete', Insert: 'Insert', Home: 'Home',
  End: 'End', PageUp: 'PageUp', PageDown: 'PageDown',
  Minus: '-', Equal: '=', Backquote: '`', BracketLeft: '[', BracketRight: ']',
  Backslash: '\\', Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/',
  // «+» в акселераторе только с цифровой клавиатуры, иначе он делит части.
  NumpadAdd: 'numadd', NumpadSubtract: 'numsub', NumpadMultiply: 'nummult',
  NumpadDivide: 'numdiv', NumpadDecimal: 'numdec',
};

function nameFromCode(code) {
  let m;
  if ((m = /^Key([A-Z])$/.exec(code))) return m[1];
  if ((m = /^Digit(\d)$/.exec(code))) return m[1];
  if ((m = /^Numpad(\d)$/.exec(code))) return 'num' + m[1];
  if (/^F([1-9]|1\d|2[0-4])$/.test(code)) return code;
  return CODE_NAME[code] || null;
}

/**
 * Событие нажатия в строку комбинации.
 *
 * Возвращает null, если нажат сам модификатор или клавиша, которой нет в
 * акселераторах Electron: такое нажатие игнорируется.
 */
export function keyFromEvent(event) {
  const key = nameFromCode(event.code);
  if (!key) return null;
  const parts = [];
  if (event.ctrlKey) parts.push('Control');
  if (event.altKey) parts.push('Alt');
  if (event.shiftKey) parts.push('Shift');
  if (event.metaKey) parts.push('Command');
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

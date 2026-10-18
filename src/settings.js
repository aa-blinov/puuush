'use strict';
/**
 * Логика окна настроек.
 *
 * Три правила, которые этот файл обязан соблюдать:
 * 1. Окно не имеет права сказать «готово», когда операция не удалась.
 * 2. Любой отказ IPC обязан вернуть интерфейс в исходное состояние, а не
 *    оставить его в вечном ожидании.
 * 3. Всё, что можно сделать мышью, должно делаться с клавиатуры.
 */

const $ = (id) => document.getElementById(id);

let settings = {};
let listening = false;

// ---------------------------------------------------------------------------
// Статус
// ---------------------------------------------------------------------------

/** Статус одной строкой: подпись меняет вид в зависимости от исхода. */
function setStatus(text, kind = '') {
  const el = $('status');
  const tag = $('stateTag');
  el.textContent = text || '';
  el.className = text ? 'show ' + kind : '';
  if (text) {
    tag.textContent = kind === 'bad' ? 'ошибка' : (kind === 'ok' ? 'готово' : 'работаю');
    tag.className = 'tag ' + (kind === 'bad' ? 'bad' : (kind === 'ok' ? 'ok' : 'busy'));
  } else {
    tag.textContent = 'готов';
    tag.className = 'tag';
  }
}

function clearStatus() {
  setStatus('');
}

function fail(message) {
  setStatus(message, 'bad');
}

/** Показывает баннер поломки файла настроек. */
function showBroken(reason) {
  $('brokenWhy').textContent = reason || '';
  $('broken').classList.add('show');
}

// ---------------------------------------------------------------------------
// Сохранение
// ---------------------------------------------------------------------------

/** Раскладывает настройки по полям. */
function renderSettings() {
  $('hotkey').value = prettyCombo(settings.hotkey);
  if ($('host').options.length) $('host').value = settings.host;
  $('ownUrl').value = (settings.own && settings.own.base_url) || '';
  $('ownKey').value = (settings.own && settings.own.write_key) || '';
  $('openAfterUpload').checked = !!settings.openAfterUpload;
  $('keepLocalCopy').checked = settings.keepLocalCopy !== false;
  $('saveDir').value = settings.saveDir || '';
  syncOwnVisibility();
  showNextTarget();
}

async function save(patch) {
  try {
    settings = await window.puuush.saveSettings(patch);
    return true;
  } catch (e) {
    // Настройки не сохранились. Показывать новое значение нельзя: после
    // перезапуска всё откатится, а режим приватности вернётся в «авто».
    fail(e && e.message ? e.message : 'настройки не сохранились');
    try {
      settings = await window.puuush.getSettings();
      renderSettings();
    } catch (ignored) {
      /* файл настроек недоступен целиком, баннер об этом уже показан */
    }
    return false;
  }
}

// ---------------------------------------------------------------------------
// Хоткей
// ---------------------------------------------------------------------------

function keyFromEvent(e) {
  const parts = [];
  if (e.ctrlKey) parts.push('Control');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  if (e.metaKey) parts.push('Command');
  let key = e.key;
  if (['Control', 'Alt', 'Shift', 'Meta'].includes(key)) return null;
  if (key === ' ') key = 'Space';
  if (key.length === 1) key = key.toUpperCase();
  parts.push(key);
  return parts.join('+');
}

const SYMBOL = {
  Command: '\u2318', Cmd: '\u2318', CommandOrControl: '\u2318', CmdOrCtrl: '\u2318',
  Control: '^', Ctrl: '^', Alt: '\u2325', Option: '\u2325', AltGr: '\u2325', Shift: '\u2191',
  Space: 'Space', Backspace: '\u232b',
};

/**
 * Показывает хоткей так, как его записывают в этой системе.
 *
 * Символы ⌘ ⌥ ⇧ — это запись macOS. На Windows и Linux человек их не узнает,
 * поэтому там остаются слова: Ctrl+Alt+K. Человек не должен гадать, во что
 * превратится CommandOrControl.
 */
const MAC_SYMBOL = {
  Command: '\u2318', Cmd: '\u2318', CommandOrControl: '\u2318', CmdOrCtrl: '\u2318',
  Control: '\u2303', Ctrl: '\u2303', Alt: '\u2325', Option: '\u2325',
  AltGr: '\u2325', Shift: '\u21e7', Space: 'Space', Backspace: '\u232b',
};
const WORD_NAME = {
  CommandOrControl: 'Ctrl', CmdOrCtrl: 'Ctrl', Control: 'Ctrl', Ctrl: 'Ctrl',
  Command: 'Meta', Cmd: 'Meta', Alt: 'Alt', Option: 'Alt', AltGr: 'AltGr',
  Shift: 'Shift', Space: 'Space', Backspace: 'Backspace',
};

function prettyCombo(combo) {
  const mac = window.puuush.platform === 'darwin';
  return String(combo || '').split('+').map((k) => {
    if (mac) return MAC_SYMBOL[k] || (k.length === 1 ? k.toUpperCase() : k);
    return WORD_NAME[k] || (k.length === 1 ? k.toUpperCase() : k);
  }).join(mac ? '' : '+');
}

function startListening() {
  listening = true;
  $('hotkey').classList.add('listening');
  $('hotkey').value = 'комбинация… Esc — отмена';
  $('hotkey').focus();
}

function stopListening() {
  if (!listening) return;
  listening = false;
  $('hotkey').classList.remove('listening');
  $('hotkey').value = prettyCombo(settings.hotkey);
}

$('hotkey').addEventListener('click', startListening);
$('hotkey').addEventListener('focus', startListening);
// Без этого протабавал мимо поля, а надпись «нажми комбинацию…» оставалась
// висеть, хотя настройка не менялась.
$('hotkey').addEventListener('blur', stopListening);

document.addEventListener('keydown', async (e) => {
  if (!listening) return;
  // Tab должен уводить с поля. Раньше preventDefault срабатывал на любую
  // клавишу, и из режима прослушивания нельзя было выйти с клавиатуры.
  if (e.key === 'Tab') return stopListening();
  e.preventDefault();
  e.stopPropagation();
  if (e.key === 'Escape') return stopListening();
  if (e.key === 'Backspace' || e.key === 'Delete') return stopListening();
  const combo = keyFromEvent(e);
  // Обязателен хотя бы один модификатор. Без него globalShortcut забирает
  // клавишу у всех приложений сразу: Enter перестаёт работать везде, включая
  // это окно, из которого его только что выбрали.
  if (!combo || !combo.includes('+')) return;
  stopListening();
  const ok = await save({ hotkey: combo });
  if (!ok) {
    // save() при отказе перечитал настоящие настройки, но оптимистично
    // присвоенное значение комбинации затирало их обратно: поле показывало
    // комбинацию, которой на самом деле нет.
    renderSettings();
    return;
  }
  settings.hotkey = combo;
  renderSettings();
});

$('hotkeyTest').addEventListener('click', async () => {
  try {
    const ok = await window.puuush.reapplyHotkey();
    const shown = prettyCombo(settings.hotkey);
    setStatus(
      ok ? `хоткей ${shown} занять удалось`
         : `не удалось занять ${shown}, его держит другая программа`,
      ok ? 'ok' : 'bad'
    );
  } catch (e) {
    fail(e && e.message ? e.message : 'проверка не удалась');
  }
});

// ---------------------------------------------------------------------------
// Хостинг
// ---------------------------------------------------------------------------

function syncOwnVisibility() {
  const v = $('host').value;
  $('ownBox').style.display = v === 'own' || v === 'auto' ? 'block' : 'none';
}

function serverState(text, kind) {
  const el = $('serverState');
  el.textContent = text || '';
  el.className = text ? 'hint ' + (kind || '') : 'hint';
}

/** Где уйдёт следующий снимок: отвечает на вопрос, на который раньше
    приходилось отвечать в уме, глядя в меню трея. */
function showNextTarget() {
  const host = $('host').value;
  const el = $('nextTarget');
  if (host === 'own') {
    el.textContent = 'Следующий снимок уйдёт на свой сервер. Если он недоступен, загрузка не состоится.';
  } else if (host === 'auto') {
    el.textContent = 'Следующий снимок уйдёт на свой сервер, а если он недоступен — на внешний хостинг.';
  } else {
    const name = $('host').selectedOptions[0] ? $('host').selectedOptions[0].textContent : 'выбранный хостинг';
    el.textContent = `Следующий снимок уйдёт на ${name}. Это публичный хостинг.`;
  }
}

$('showKey').addEventListener('click', () => {
  const el = $('ownKey');
  const shown = el.type === 'password';
  el.type = shown ? 'text' : 'password';
  $('showKey').textContent = shown ? 'Скрыть' : 'Показать';
  el.focus();
});

$('verifyServer').addEventListener('click', async () => {
  serverState('проверяю…');
  const own = {
    base_url: $('ownUrl').value.trim(),
    write_key: $('ownKey').value.trim(),
  };
  // Сохраняем раньше проверки: поля пишутся по уходу фокуса, и без этого
  // проверка ушла бы на старый адрес.
  await save({ own });
  try {
    const r = await window.puuush.verifyServer(own);
    const files = r && r.files != null ? r.files : null;
    const mb = r && r.bytes != null ? Math.round(r.bytes / 1048576) : null;
    serverState(
      files == null
        ? 'сервер отвечает, ключ подходит.'
        : `сервер отвечает, ключ подходит. На нём ${files} файлов, ${mb} МБ.`,
      'ok'
    );
  } catch (e) {
    serverState(`сервер не настроен или не отвечает: ${e && e.message ? e.message : e}`, 'bad');
  }
});

$('host').addEventListener('change', async () => {
  syncOwnVisibility();
  showNextTarget();
  await save({ host: $('host').value });
});

$('ownUrl').addEventListener('change', async () => {
  serverState('');
  await save({ own: { base_url: $('ownUrl').value.trim() } });
});
$('ownKey').addEventListener('change', async () => {
  serverState('');
  await save({ own: { write_key: $('ownKey').value.trim() } });
});

// ---------------------------------------------------------------------------
// Поведение
// ---------------------------------------------------------------------------

$('openAfterUpload').addEventListener('change', () =>
  save({ openAfterUpload: $('openAfterUpload').checked }));
$('keepLocalCopy').addEventListener('change', () =>
  save({ keepLocalCopy: $('keepLocalCopy').checked }));
$('saveDir').addEventListener('change', () => save({ saveDir: $('saveDir').value.trim() }));
$('saveDirPick').addEventListener('click', async () => {
  try {
    const dir = await window.puuush.chooseDir();
    if (!dir) return;
    $('saveDir').value = dir;
    await save({ saveDir: dir });
  } catch (e) {
    fail(e && e.message ? e.message : 'папку выбрать не удалось');
  }
});

// ---------------------------------------------------------------------------
// Загрузка: три равноправных пути
// ---------------------------------------------------------------------------

async function runUpload(label, run) {
  clearStatus();
  setStatus(`${label}…`, 'busy');
  try {
    const r = await run();
    if (!r || !r.url) {
      fail(`${label}: сервер не вернул ссылку`);
      return null;
    }
    setStatus(
      r.copied === false
        ? `${r.url}\n\nбуфер занят, ссылка не скопирована, скопируй вручную`
        : `${r.url}\n\n${r.host}${r.temp ? ', ссылка временная' : ''} — скопировано в буфер`,
      r.copied === false ? 'bad' : 'ok'
    );
    await loadHistory();
    return r;
  } catch (e) {
    // Раньше здесь исключение пролетало мимо, и тег навсегда зависал
    // на «загружаю…»: второй клик не помогал, состояние не восстанавливалось.
    fail(`${label} не удалась: ${e && e.message ? e.message : e}`);
    return null;
  }
}

$('pickFile').addEventListener('click', async () => {
  let file;
  try {
    file = await window.puuush.chooseFile();
  } catch (e) {
    return fail(e && e.message ? e.message : 'диалог не открылся');
  }
  if (!file) return;
  await runUpload('Загрузка файла', () => window.puuush.uploadFile(file));
});

$('pickClip').addEventListener('click', async () => {
  await runUpload('Загрузка картинки из буфера', () => window.puuush.uploadClipboardImage());
});

const drop = $('drop');
['dragenter', 'dragover'].forEach((ev) =>
  drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach((ev) =>
  drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
drop.addEventListener('drop', (e) => {
  const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
  if (!file) return;
  const p = window.puuush.pathForFile(file);
  if (!p) return fail('не удалось определить путь к файлу');
  runUpload('Загрузка файла', () => window.puuush.uploadFile(p));
});

// ---------------------------------------------------------------------------
// История
// ---------------------------------------------------------------------------

const TEMP_LABEL = { true: 'временная', false: 'постоянная' };

function historyRow(item) {
  const tr = document.createElement('tr');

  const tdU = document.createElement('td');
  tdU.className = 'u';
  tdU.textContent = item.url;
  tdU.title = 'Скопировать ссылку';
  // С клавиатуры недоступная ссылка для человека, который живёт на хоткее,
  // просто не существует. Кликабельную строку делаем фокусируемой и
  // обрабатываем Enter и пробел.
  tdU.tabIndex = 0;
  tdU.setAttribute('role', 'button');
  tdU.addEventListener('click', () => {
    window.puuush.copyText(item.url);
    setStatus('ссылка скопирована', 'ok');
  });
  tdU.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    window.puuush.copyText(item.url);
    setStatus('ссылка скопирована', 'ok');
  });

  const tdT = document.createElement('td');
  tdT.className = 't';
  // Имя файла и источник в истории уже есть: store их пишет. Через неделю
  // человек узнаёт свою ссылку именно по ним, а не по голому адресу.
  const when = new Date(item.at).toLocaleString('ru-RU', {
    day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
  });
  tdT.textContent = `${item.source || item.host} · ${when}` +
    (item.temp ? ' · временная' : '');

  const tdB = document.createElement('td');
  tdB.style.textAlign = 'right';
  const open = document.createElement('button');
  open.textContent = 'Открыть';
  open.addEventListener('click', () => window.puuush.openExternal(item.url));
  tdB.appendChild(open);

  tr.append(tdU, tdT, tdB);
  return tr;
}

async function loadHistory() {
  const box = $('history');
  let list = [];
  try {
    list = await window.puuush.getHistory();
  } catch (e) {
    box.innerHTML = '';
    const div = document.createElement('div');
    div.className = 'empty';
    div.textContent = 'историю прочитать не удалось';
    box.appendChild(div);
    return;
  }
  if (!list.length) {
    box.innerHTML = '<div class="empty">пусто. Ссылки появятся здесь после первой загрузки.</div>';
    return;
  }
  box.innerHTML = '';
  for (const item of list) box.appendChild(historyRow(item));
}

$('clearHistory').addEventListener('click', async () => {
  // Удаление истории необратимо, а спрятано внизу окна.
  if (!window.confirm('Удалить всю историю ссылок?')) return;
  clearStatus();
  try {
    await window.puuush.clearHistory();
  } catch (e) {
    fail(e && e.message ? e.message : 'историю очистить не удалось');
  }
  loadHistory();
});

// ---------------------------------------------------------------------------
// Статусы из главного процесса
// ---------------------------------------------------------------------------

window.puuush.onProgress((p) => {
  if (!p) return;
  if (p.state === 'step') {
    // Главный процесс шлёт сюда человеческие причины («сервер отверг ключ»,
    // «ссылка не вывозит файл»). Раньше они уходили в никуда.
    if (p.message) setStatus(p.message, 'busy');
  } else if (p.state === 'capturing') setStatus('снимаю экран…', 'busy');
  else if (p.state === 'captured') setStatus('вырезал область, загружаю…', 'busy');
  else if (p.state === 'error') fail(p.message);
  else if (p.state === 'done') {
    // Главный процесс уже знает, копировалась ли ссылка и не уехала ли она
    // на публичный хостинг. Раньше эти поля игнорировались, и окно врало.
    const head = p.privacyDowngraded
      ? 'внимание: свой сервер не сработал, файл ушёл на публичный ' + p.host
      : (p.copied === false ? 'буфер занят' : p.host);
    setStatus(
      `${p.url}\n\n${head}${p.temp ? ' · ссылка временная' : ''}` +
      (p.copied === false ? ' — скопируй вручную' : ' — скопировано в буфер'),
      p.copied === false || p.privacyDowngraded ? 'bad' : 'ok'
    );
  }
});

// ---------------------------------------------------------------------------
// Старт
// ---------------------------------------------------------------------------

async function initHosts() {
  const sel = $('host');
  sel.innerHTML = '';
  const hosts = await window.puuush.hosts();
  const add = (value, text) => {
    const o = document.createElement('option');
    o.value = value;
    o.textContent = text;
    sel.appendChild(o);
  };
  add('auto', 'авто: свой сервер, потом ' + hosts.map((h) => h.name).join(', '));
  for (const h of hosts) add(h.name, h.label);
  add('own', 'только свой сервер — ничего не уходит наружу');
}

(async function init() {
  let broken = null;
  try {
    broken = await window.puuush.brokenSettings();
  } catch (e) { /* канал мог не ответить, покажем это отдельно */ }
  if (broken) showBroken(broken);

  try {
    settings = await window.puuush.getSettings();
  } catch (e) {
    // Раньше исключение уходило в консоль, и форма выглядела готовой с
    // пустыми полями. Теперь это видно.
    showBroken(`настройки прочитать не удалось: ${e && e.message ? e.message : e}`);
    fail('настройки прочитать не удалось');
    return;
  }

  try {
    await initHosts();
  } catch (e) {
    fail(`список хостингов не загрузился: ${e && e.message ? e.message : e}`);
    return;
  }

  renderSettings();
  await loadHistory();
})();
'use strict';
/** Окно настроек. Всё применяется сразу — отдельной кнопки «Сохранить» нет. */

const $ = (id) => document.getElementById(id);
let settings = {};
let listening = false;

function say(text, kind) {
  const el = $('status');
  el.textContent = text;
  el.className = 'show ' + (kind || '');
}

function clearSay() {
  $('status').className = '';
  $('stateTag').textContent = 'готов';
}

async function save(patch) {
  try {
    settings = await window.puuush.saveSettings(patch);
  } catch (e) {
    // Настройки не сохранились. Молча показывать новое значение нельзя:
    // после перезапуска всё откатится, а режим приватности вернётся в «авто».
    say(e && e.message ? e.message : String(e), 'bad');
    $('stateTag').textContent = 'не сохранено';
    settings = await window.puuush.getSettings();
    renderSettings();
    return settings;
  }
  return settings;
}

// --- хоткей ---

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

function startListening() {
  listening = true;
  $('hotkey').classList.add('listening');
  $('hotkey').value = 'нажми комбинацию…';
}

function stopListening() {
  listening = false;
  $('hotkey').classList.remove('listening');
  $('hotkey').value = settings.hotkey;
}

$('hotkey').addEventListener('click', startListening);
$('hotkey').addEventListener('focus', startListening);
// Без этого протабавал мимо поля, а надпись «нажми комбинацию…» осталась
// висеть, хотя настройка не менялась и поле показывало бы старый хоткей.
$('hotkey').addEventListener('blur', stopListening);

document.addEventListener('keydown', (e) => {
  if (!listening) return;
  e.preventDefault();
  e.stopPropagation();
  if (e.key === 'Escape') return stopListening();
  if (e.key === 'Backspace' || e.key === 'Delete') {
    return stopListening();
  }
  const combo = keyFromEvent(e);
  // Обязателен хотя бы один модификатор. Без него globalShortcut забирает
  // клавишу у всех приложений сразу: Enter перестаёт работать везде, включая
  // окно настроек, из которого его только что выбрали.
  if (!combo || !combo.includes('+')) return;
  $('hotkey').value = combo;
  settings.hotkey = combo;
  stopListening();
  save({ hotkey: combo });
});

$('hotkeyApply').addEventListener('click', startListening);

$('hotkeyTest').addEventListener('click', async () => {
  const ok = await window.puuush.reapplyHotkey();
  if (ok) say(`хоткей ${settings.hotkey} занять удалось`, 'ok');
  else say(`не удалось занять ${settings.hotkey} — он уже занят`, 'bad');
});

// --- хостинг ---

async function initHosts() {
  const hosts = await window.puuush.hosts();
  const sel = $('host');
  sel.innerHTML = '';
  const auto = document.createElement('option');
  auto.value = 'auto';
  auto.textContent = 'авто: свой box, потом catbox, pomf2, uguu';
  sel.appendChild(auto);
  for (const h of hosts) {
    const o = document.createElement('option');
    o.value = h.name;
    o.textContent = h.label;
    sel.appendChild(o);
  }
  const own = document.createElement('option');
  own.value = 'own';
  own.textContent = 'только свой box';
  sel.appendChild(own);
}

function syncOwnVisibility() {
  const v = $('host').value;
  $('ownBox').style.display = v === 'own' || v === 'auto' ? 'block' : 'none';
}

$('host').addEventListener('change', () => {
  save({ host: $('host').value });
  syncOwnVisibility();
});

$('ownUrl').addEventListener('change', () =>
  save({ own: { base_url: $('ownUrl').value.trim() } })
);
$('ownKey').addEventListener('change', () =>
  save({ own: { write_key: $('ownKey').value.trim() } })
);

$('openAfterUpload').addEventListener('change', () =>
  save({ openAfterUpload: $('openAfterUpload').checked })
);
$('keepLocalCopy').addEventListener('change', () =>
  save({ keepLocalCopy: $('keepLocalCopy').checked })
);
$('saveDir').addEventListener('change', () => save({ saveDir: $('saveDir').value.trim() }));
$('saveDirPick').addEventListener('click', async () => {
  const dir = await window.puuush.chooseDir();
  if (!dir) return;
  $('saveDir').value = dir;
  await save({ saveDir: dir });
});

// --- загрузка файла ---

async function doUpload(filePath) {
  if (!filePath) return;
  clearSay();
  $('stateTag').textContent = 'загружаю…';
  const r = await window.puuush.uploadFile(filePath);
  if (r) {
    $('stateTag').textContent = 'готово';
    say(r.url + '\n\nссылка скопирована в буфер', 'ok');
    await loadHistory();
  } else {
    $('stateTag').textContent = 'ошибка';
  }
}

$('pickFile').addEventListener('click', async () => {
  doUpload(await window.puuush.chooseFile());
});

const drop = $('drop');
['dragenter', 'dragover'].forEach((ev) =>
  drop.addEventListener(ev, (e) => {
    e.preventDefault();
    drop.classList.add('over');
  })
);
['dragleave', 'drop'].forEach((ev) =>
  drop.addEventListener(ev, (e) => {
    e.preventDefault();
    drop.classList.remove('over');
  })
);
drop.addEventListener('drop', (e) => {
  const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
  if (!file) return;
  const p = window.puuush.pathForFile(file);
  if (!p) return say('не удалось определить путь к файлу', 'bad');
  doUpload(p);
});

window.puuush.onProgress(({ state, message, url, host, temp }) => {
  if (state === 'step') say(message);
  else if (state === 'capturing') say('снимаю экран…');
  else if (state === 'error') {
    $('stateTag').textContent = 'ошибка';
    say(message, 'bad');
  } else if (state === 'done') {
    $('stateTag').textContent = 'готово';
    say(url + `\n\n${host}${temp ? ', временная ссылка' : ''} — скопировано в буфер`, 'ok');
  }
});

// --- история ---

async function loadHistory() {
  const list = await window.puuush.getHistory();
  const box = $('history');
  if (!list.length) {
    box.innerHTML = '<div class="empty">пусто</div>';
    return;
  }
  box.innerHTML = '';
  for (const h of list) {
    const tr = document.createElement('tr');

    const tdU = document.createElement('td');
    tdU.className = 'u';
    tdU.textContent = h.url;
    tdU.title = 'нажми, чтобы скопировать';
    tdU.style.cursor = 'pointer';
    tdU.addEventListener('click', () => {
      window.puuush.copyText(h.url);
      say('скопировано: ' + h.url, 'ok');
    });

    const tdT = document.createElement('td');
    tdT.className = 't';
    const when = new Date(h.at).toLocaleString('ru-RU', {
      day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
    });
    tdT.textContent = `${h.host}${h.temp ? ' ~время' : ''}`;
    tdT.title = when;

    const tdB = document.createElement('td');
    tdB.style.textAlign = 'right';
    const open = document.createElement('button');
    open.textContent = 'Открыть';
    open.addEventListener('click', () => window.puuush.openExternal(h.url));
    tdB.appendChild(open);

    tr.append(tdU, tdT, tdB);
    box.appendChild(tr);
  }
}

$('clearHistory').addEventListener('click', async () => {
  await window.puuush.clearHistory();
  loadHistory();
});

// --- старт ---

/** Раскладывает настройки по полям. Вызывается и при откате записи. */
function renderSettings() {
  $('hotkey').value = settings.hotkey;
  $('host').value = settings.host;
  $('ownUrl').value = settings.own.base_url || '';
  $('ownKey').value = settings.own.write_key || '';
  $('openAfterUpload').checked = !!settings.openAfterUpload;
  $('keepLocalCopy').checked = !!settings.keepLocalCopy;
  $('saveDir').value = settings.saveDir || '';
  syncOwnVisibility();
}

(async function init() {
  settings = await window.puuush.getSettings();
  await initHosts();
  renderSettings();
  await loadHistory();
})();
'use strict';
/**
 * Настройки и история. Всё в JSON рядом с приложением, без БД:
 * объём данных маленький, а переносить на другой компьютер просто — скопировал файл.
 */

const fs = require('node:fs');
const path = require('node:path');
const { app } = require('electron');

const HISTORY_LIMIT = 30;

const DEFAULTS = {
  hotkey: 'CommandOrControl+Shift+S',
  host: 'auto', // auto | catbox | pomf2 | uguu | own
  own: { base_url: '', write_key: '' },
  openAfterUpload: false,
  keepLocalCopy: true,
  saveDir: '', // пусто -> Pictures/puuush
};

function file(name) {
  return path.join(app.getPath('userData'), name);
}

/**
 * Пишет файл атомарно: сначала рядом временный, потом переименование.
 *
 * fs.writeFileSync обрывается на середине, если диск кончился или выдернули
 * питание. Тогда остаётся обрезанный JSON, который при следующем чтении тихо
 * превращается в значения по умолчанию. Для настроек это особенно скверно:
 * выбранный «только свой сервер» возвращался в «авто», и следующий скриншот
 * уезжал на публичный catbox без всякого предупреждения.
 */
function writeJson(name, data) {
  const target = file(name);
  const tmp = `${target}.tmp`;
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tmp, target);
    return true;
  } catch (e) {
    try {
      fs.unlinkSync(tmp);
    } catch (e2) {
      /* временного файла могло не быть — не страшно */
    }
    return false;
  }
}

/**
 * Файл настроек не прочитался: битый JSON или нет прав.
 *
 * Молча брать значения по умолчанию опасно: пользователь выбрал «только свой
 * box», чтобы скриншоты никуда не уходили наружу, а после перезапуска режим
 * вернулся в «авто», и следующий снимок уехал на публичный catbox. Поэтому
 * факт поломки запоминается, и клиент показывает его в трее и в окне настроек.
 */
let settingsBroken = null;

const SETTINGS_FILE = 'settings.json';

/**
 * Пометка о поломке ставится только файлу настроек.
 *
 * История читается тем же общим читателем JSON, и раньше проверка структуры
 * ругалась на неё: история и есть массив. Из-за этого она всегда читалась
 * пустой, а признак поломки настроек выставлялся историей — то есть любая
 * загрузка блокировалась навсегда.
 */
function noteBroken(name, reason) {
  console.error(`${name}: ${reason}`);
  if (name === SETTINGS_FILE) settingsBroken = `${name} ${reason}`;
}

const validSettings = (d) =>
  !!d && typeof d === 'object' && !Array.isArray(d) &&
  (!d.host || HOST_NAMES.includes(d.host));

const validHistory = (d) => Array.isArray(d);

/** Читает JSON и проверяет структуру вызывающим: у настроек и истории она разная. */
function readJson(name, fallback, validate) {
  let raw;
  try {
    raw = fs.readFileSync(file(name), 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return fallback; // файла ещё нет, это нормально
    noteBroken(name, `не прочитан: ${e.code || e.message}`);
    return fallback;
  }
  // Пустой файл раньше молча превращался в значения по умолчанию: режим
  // «только свой сервер» исчезал без следа. Пустой файл — поломка.
  if (!raw.trim()) {
    noteBroken(name, 'пуст');
    return fallback;
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    // В окно уходит понятная причина, сырое сообщение парсера остаётся в логе.
    console.error(`${name}: ${e.message}`);
    noteBroken(name, 'повреждён, JSON не читается');
    return fallback;
  }
  if (validate && !validate(data)) {
    noteBroken(name, 'неожиданная структура');
    return fallback;
  }
  return data;
}

/** Настройки снова записаны и читаются: поломка снята. */
function clearBroken() {
  settingsBroken = null;
}

/** Что сломалось в настройках, либо null, если всё в порядке. */
function brokenReason() {
  return settingsBroken;
}

const HOST_NAMES = ['auto', 'own', 'catbox', 'pomf2', 'uguu'];

function getSettings() {
  const saved = readJson('settings.json', {}, validSettings);
  const merged = { ...DEFAULTS, ...saved };
  merged.own = { ...DEFAULTS.own, ...(saved.own || {}) };
  if (!HOST_NAMES.includes(merged.host)) merged.host = 'auto';
  return merged;
}

/**
 * Сохраняет настройки.
 *
 * Бросает исключение, если запись не удалась. Молча возвращать «успех» было
 * опасно: окно настрочек показывало бы новое значение, а после перезапуска
 * всё откатывалось бы назад, а режим приватности молча возвращался в «авто».
 */
function setSettings(patch) {
  const current = getSettings();
  const next = { ...current, ...patch };
  if (patch.own) next.own = { ...current.own, ...patch.own };
  if (!writeJson('settings.json', next)) {
    throw new Error('не смог записать settings.json: нет прав или кончилось место');
  }
  return next;
}

/** Каталог для локальных копий скринов. */
function shotsDir() {
  const s = getSettings();
  const dir = s.saveDir
    ? path.resolve(s.saveDir.replace(/^~(?=$|\/)/, app.getPath('home')))
    : path.join(app.getPath('pictures'), 'puuush');
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (e) {
    /* не смогли — вернём как есть, вызывающий сам разберётся */
  }
  return dir;
}

function getHistory() {
  const h = readJson('history.json', [], validHistory);
  return Array.isArray(h) ? h : [];
}

function addHistory(entry) {
  const list = getHistory();
  list.unshift({ at: Date.now(), ...entry });
  // История вспомогательная: её потеря не должна ломать загрузку.
  writeJson('history.json', list.slice(0, HISTORY_LIMIT));
  return list.slice(0, HISTORY_LIMIT);
}

function clearHistory() {
  writeJson('history.json', []);
}

module.exports = {
  DEFAULTS,
  brokenReason,
  clearBroken,
  getSettings,
  setSettings,
  getHistory,
  addHistory,
  clearHistory,
  shotsDir,
};

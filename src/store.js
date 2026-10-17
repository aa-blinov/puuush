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
 * выбранный «только свой box» возвращался в «авто», и следующий скриншот
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

/** Сработало ли в прошлый раз чтение файла, который оказался битым. */
let corruptWarned = false;

function readJson(name, fallback) {
  let raw;
  try {
    raw = fs.readFileSync(file(name), 'utf8');
  } catch (e) {
    return fallback;
  }
  if (!raw.trim()) return fallback;
  try {
    const data = JSON.parse(raw);
    return data && typeof data === 'object' ? data : fallback;
  } catch (e) {
    // Молча откатываться нельзя: пользователь считает, что выбрал приватный
    // режим, а на деле получил значения по умолчанию. Сообщаем один раз.
    if (!corruptWarned) {
      corruptWarned = true;
      console.error(`Файл ${name} повреждён, беру значения по умолчанию: ${e.message}`);
    }
    return fallback;
  }
}

const HOST_NAMES = ['auto', 'own', 'catbox', 'pomf2', 'uguu'];

function getSettings() {
  const saved = readJson('settings.json', {});
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
  const h = readJson('history.json', []);
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
  getSettings,
  setSettings,
  getHistory,
  addHistory,
  clearHistory,
  shotsDir,
};
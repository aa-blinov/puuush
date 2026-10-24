'use strict';
/**
 * Настройки и история. Всё в JSON рядом с приложением, без БД:
 * объём данных маленький, а переносить на другой компьютер просто — скопировал файл.
 */

const { t, LANGS } = require('./i18n');
const fs = require('node:fs');
const path = require('node:path');
const { app } = require('electron');

const HISTORY_LIMIT = 30;
const HOST_NAMES = ['auto', 'own', 'catbox', 'pomf2', 'uguu'];

const DEFAULTS = {
  hotkey: 'CommandOrControl+Shift+S',
  imageHotkey: 'CommandOrControl+Alt+S', // картинка в буфер, без загрузки
  host: 'auto', // auto | catbox | pomf2 | uguu | own
  own: { base_url: '', write_key: '' },
  openAfterUpload: false,
  keepLocalCopy: true,
  saveDir: '', // пусто -> Pictures/puuush
  lang: 'en', // язык интерфейса; русский включается в настройках
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
  (!d.host || HOST_NAMES.includes(d.host)) &&
  (!d.lang || LANGS.includes(d.lang));

const validHistory = (d) => Array.isArray(d);

/** Читает JSON и проверяет структуру вызывающим: у настроек и истории она разная. */
function readJson(name, fallback, validate) {
  // Признак поломки описывает последнее чтение, а не любое прошлое: иначе
  // файл, поправленный руками (или удалённый), блокировал бы загрузки до
  // перезапуска. Каждая ветка поломки ниже выставляет его заново.
  if (name === SETTINGS_FILE) settingsBroken = null;
  let raw;
  try {
    raw = fs.readFileSync(file(name), 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return fallback; // файла ещё нет, это нормально
    noteBroken(name, t('store.notRead', { error: e.code || e.message }));
    return fallback;
  }
  // Пустой файл раньше молча превращался в значения по умолчанию: режим
  // «только свой сервер» исчезал без следа. Пустой файл — поломка.
  if (!raw.trim()) {
    noteBroken(name, t('store.empty'));
    return fallback;
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    // В окно уходит понятная причина, сырое сообщение парсера остаётся в логе.
    console.error(`${name}: ${e.message}`);
    noteBroken(name, t('store.broken'));
    return fallback;
  }
  if (validate && !validate(data)) {
    noteBroken(name, t('store.unexpected'));
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

function getSettings() {
  const saved = readJson('settings.json', {}, validSettings);
  const merged = { ...DEFAULTS, ...saved };
  merged.own = { ...DEFAULTS.own, ...(saved.own || {}) };
  if (!HOST_NAMES.includes(merged.host)) merged.host = 'auto';
  if (!LANGS.includes(merged.lang)) merged.lang = DEFAULTS.lang;
  return merged;
}

/**
 * Сохраняет настройки.
 *
 * Бросает исключение, если запись не удалась. Молча возвращать «успех» было
 * опасно: окно настрочек показывало бы новое значение, а после перезапуска
 * всё откатывалось бы назад, а режим приватности молча возвращался в «авто».
 *
 * Плохую папку отсекаем здесь, а не в обработчике IPC: так её не примет ни окно,
 * ни любой другой путь записи.
 */
function setSettings(patch) {
  checkPatch(patch);
  if (patch.saveDir !== undefined) checkShotsDir(patch.saveDir);
  const current = getSettings();
  const next = { ...current, ...patch };
  if (patch.own) next.own = { ...current.own, ...patch.own };
  if (!writeJson('settings.json', next)) {
    throw new Error(t('store.cannotWrite'));
  }
  return next;
}

const SETTING_TYPES = {
  hotkey: 'string', imageHotkey: 'string', host: 'string', saveDir: 'string',
  lang: 'string', openAfterUpload: 'boolean', keepLocalCopy: 'boolean',
  own: 'object',
};

/**
 * Значение, которое getSettings() потом не примет, нельзя класть на диск:
 * файл с host: 'bogus' при следующем чтении объявляется сломанным, и все
 * загрузки блокируются. Неизвестные ключи тоже отказ, а не тихая запись.
 */
function checkPatch(patch) {
  for (const [key, value] of Object.entries(patch)) {
    const ok = typeof value === SETTING_TYPES[key] && value !== null &&
      (key !== 'host' || HOST_NAMES.includes(value)) &&
      (key !== 'lang' || LANGS.includes(value));
    if (!ok) throw new Error(t('store.badValue', { key }));
  }
}

/**
 * Каталог для локальных копий. Пустая строка — Pictures/puuush. `~` в начале
 * раскрываем и на Windows: там люди пишут `~\Shots` так же часто, как `~/Shots`.
 */
function resolveShotsDir(saveDir) {
  return saveDir
    ? path.resolve(saveDir.replace(/^~(?=$|[\\/])/, app.getPath('home')))
    : path.join(app.getPath('pictures'), 'puuush');
}

/**
 * Проверяет папку, которую человек выбрал в настройках, до того как её
 * сохранить. Бросает понятную ошибку, если в ней нельзя создать файлы: иначе
 * плохой путь всплывает только на первом скриншоте, и причина теряется.
 */
function checkShotsDir(saveDir) {
  const dir = resolveShotsDir(saveDir);
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.accessSync(dir, fs.constants.W_OK);
  } catch (e) {
    throw new Error(t('store.saveDirBad', { path: dir, error: e.code || e.message }));
  }
}

/** Каталог для локальных копий скринов. Создаёт его, если его ещё нет. */
function shotsDir() {
  const dir = resolveShotsDir(getSettings().saveDir);
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
  checkShotsDir,
};

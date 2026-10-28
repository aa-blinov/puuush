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
const HOST_NAMES = ['auto', 'own', 'catbox', 'litterbox', 'x0', 'uguu', 'pomf2'];
const RECORD_TARGETS = ['cloud', 'disk', 'both'];
const PHOTO_MODES = ['link', 'clipboard'];
const VIDEO_MODES = ['link', 'clipboard', 'disk'];
const RECORD_AREAS = ['screen', 'region', 'all'];
const RECORD_FORMATS = ['video', 'gif'];
const RECORD_FPS = [30, 60];
const RECORD_GAINS = [1, 1.5, 2];

const DEFAULTS = {
  hotkey: 'CommandOrControl+Shift+S',
  imageHotkey: 'CommandOrControl+Alt+S', // картинка в буфер, без загрузки
  recordHotkey: 'CommandOrControl+Shift+R', // запись экрана со звуком
  host: 'auto', // auto | own | catbox | litterbox | x0 | uguu | pomf2
  // Порядок облачных хостингов, измеренный на этой машине. Пусто — порядок
  // по умолчанию. Регион меняет задержку, поэтому порядок не зашит.
  hostOrder: [],
  own: { base_url: '', write_key: '' },
  openAfterUpload: false,
  keepLocalCopy: true,
  saveDir: '', // пусто -> Pictures/puuush
  launchAtLogin: false, // только macOS и Windows; на Linux Electron это не умеет
  lang: 'en', // язык интерфейса; русский включается в настройках
  recordMicrophone: true, // микрофон в записи
  recordSystemAudio: true, // системный звук в записи (где система умеет)
  recordAllScreens: false, // совместимость со старыми настройками
  // cursor | all | id конкретного экрана. Новое поле важнее старого boolean.
  recordScreen: 'cursor',
  recordMaxSeconds: 0, // 0 -> без ограничения
  // Куда девать готовую запись: cloud — загрузить и дать ссылку, disk —
  // оставить файлом на диске, both — и то и другое. Снимок решается
  // настройкой keepLocalCopy, а запись встречи человек выбирает заранее.
  recordTarget: 'cloud', // устарело: старые настройки переносятся в videoMode
  // Что делать с записью: link — загрузить и дать ссылку, clipboard — файл
  // положить в буфер как файл, disk — оставить файлом и скопировать путь.
  videoMode: 'link', // link | clipboard | disk
  // Что делать со снимком: ссылка или картинка сразу в буфере.
  photoMode: 'link', // link | clipboard
  // Область записи: весь экран, выбранная рамкой область или все экраны.
  recordArea: 'screen', // screen | region | all
  // Формат записи: видео со звуком или GIF без звука.
  recordFormat: 'video', // video | gif
  recordFps: 30, // 30 | 60
  // Усиление микрофона. Один и тот же микрофон на разных машинах звучит
  // по-разному, и тихая запись встречи — это запись, которую не слушают.
  recordMicGain: 1, // 1 | 1.5 | 2
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
function noteBroken(name, key, vars) {
  console.error(`${name}: ${t(key, vars)}`);
  // Хранится ключ, а не готовая строка: чтение при старте идёт до setLang,
  // и переведённый текст застревал бы на языке момента чтения.
  if (name === SETTINGS_FILE) settingsBroken = { name, key, vars };
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
    noteBroken(name, 'store.notRead', { error: e.code || e.message });
    return fallback;
  }
  // Пустой файл раньше молча превращался в значения по умолчанию: режим
  // «только свой сервер» исчезал без следа. Пустой файл — поломка.
  if (!raw.trim()) {
    noteBroken(name, 'store.empty');
    return fallback;
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    // В окно уходит понятная причина, сырое сообщение парсера остаётся в логе.
    console.error(`${name}: ${e.message}`);
    noteBroken(name, 'store.broken');
    return fallback;
  }
  if (validate && !validate(data)) {
    noteBroken(name, 'store.unexpected');
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
  return settingsBroken ? `${settingsBroken.name} ${t(settingsBroken.key, settingsBroken.vars)}` : null;
}

function getSettings() {
  const saved = readJson('settings.json', {}, validSettings);
  const merged = { ...DEFAULTS, ...saved };
  merged.own = { ...DEFAULTS.own, ...(saved.own || {}) };
  if (!HOST_NAMES.includes(merged.host)) merged.host = 'auto';
  if (!RECORD_TARGETS.includes(merged.recordTarget)) merged.recordTarget = DEFAULTS.recordTarget;
  // Перенос: раньше «куда девать запись» лежало в recordTarget.
  if (!saved.videoMode) {
    // Старый файл знал только recordTarget: переносим его значение.
    merged.videoMode = saved.recordTarget === 'disk' ? 'disk' : 'link';
  } else if (!VIDEO_MODES.includes(merged.videoMode)) {
    merged.videoMode = 'link';
  }
  if (!PHOTO_MODES.includes(merged.photoMode)) merged.photoMode = DEFAULTS.photoMode;
  if (!RECORD_AREAS.includes(merged.recordArea)) merged.recordArea = DEFAULTS.recordArea;
  if (!RECORD_FORMATS.includes(merged.recordFormat)) merged.recordFormat = DEFAULTS.recordFormat;
  if (!RECORD_FPS.includes(Number(merged.recordFps))) merged.recordFps = DEFAULTS.recordFps;
  if (!RECORD_GAINS.includes(Number(merged.recordMicGain))) merged.recordMicGain = DEFAULTS.recordMicGain;
  if (!LANGS.includes(merged.lang)) merged.lang = DEFAULTS.lang;
  // Значение по умолчанию уже лежит в merged, поэтому смотрим именно на
  // сохранённый файл: старая версия писала только recordAllScreens.
  if (typeof saved.recordScreen !== 'string' || !saved.recordScreen) {
    merged.recordScreen = merged.recordAllScreens === true ? 'all' : 'cursor';
  }
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
  checkHotkeys(next);
  if (!writeJson('settings.json', next)) {
    throw new Error(t('store.cannotWrite'));
  }
  return next;
}

const SETTING_TYPES = {
  hotkey: 'string', imageHotkey: 'string', recordHotkey: 'string',
  hostOrder: 'array',
  host: 'string', saveDir: 'string',
  lang: 'string', openAfterUpload: 'boolean', keepLocalCopy: 'boolean', launchAtLogin: 'boolean',
  recordMicrophone: 'boolean', recordSystemAudio: 'boolean', recordAllScreens: 'boolean',
  recordScreen: 'string', recordMaxSeconds: 'number',
  recordTarget: 'string', recordMicGain: 'number',
  videoMode: 'string', photoMode: 'string', recordArea: 'string',
  recordFormat: 'string', recordFps: 'number',
  own: 'object',
};

/**
 * Три комбинации на одну клавишу не займутся.
 *
 * Проверка живёт здесь, а не в обработчике IPC, потому что настройки
 * пишутся ещё и из окна, и из командной строки: правило одно и должно
 * действовать везде. Раньше проверка стояла только в главном процессе, и
 * запись могла получить ту же комбинацию, что и снимок.
 */
function checkHotkeys(next) {
  const keys = ['hotkey', 'imageHotkey', 'recordHotkey'];
  for (let i = 0; i < keys.length; i++) {
    for (let j = i + 1; j < keys.length; j++) {
      if (next[keys[i]] && next[keys[i]] === next[keys[j]]) {
        throw new Error(t('note.sameHotkeys'));
      }
    }
  }
}

/**
 * Значение, которое getSettings() потом не примет, нельзя класть на диск:
 * файл с host: 'bogus' при следующем чтении объявляется сломанным, и все
 * загрузки блокируются. Неизвестные ключи тоже отказ, а не тихая запись.
 */
function checkPatch(patch) {
  for (const [key, value] of Object.entries(patch)) {
    const type = SETTING_TYPES[key];
    // У массива typeof — «object», поэтому он проверяется отдельно. Раньше
    // здесь стояло одно сравнение с typeof, и hostOrder не сохранялся
    // никогда: порядок хостингов молча оставался пустым.
    let ok = type !== undefined && value !== null &&
      (type === 'array' ? Array.isArray(value) : typeof value === type);
    if (ok && type === 'array') {
      ok = value.every((v) => typeof v === 'string');
    }
    ok = ok &&
      (key !== 'host' || HOST_NAMES.includes(value)) &&
      (key !== 'recordTarget' || RECORD_TARGETS.includes(value)) &&
      (key !== 'recordMicGain' || RECORD_GAINS.includes(Number(value))) &&
      (key !== 'videoMode' || VIDEO_MODES.includes(value)) &&
      (key !== 'photoMode' || PHOTO_MODES.includes(value)) &&
      (key !== 'recordArea' || RECORD_AREAS.includes(value)) &&
      (key !== 'recordFormat' || RECORD_FORMATS.includes(value)) &&
      (key !== 'recordFps' || RECORD_FPS.includes(Number(value))) &&
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

function historyEntryId(entry) {
  return `${entry.at || 0}|${entry.url || ''}|${entry.file || ''}`;
}

function updateHistoryEntry(id, patch) {
  const list = getHistory();
  const index = list.findIndex((entry) => entry && historyEntryId(entry) === id);
  if (index < 0) return false;
  list[index] = { ...list[index], ...patch };
  writeJson('history.json', list);
  return true;
}

module.exports = {
  RECORD_TARGETS, RECORD_GAINS, PHOTO_MODES, VIDEO_MODES, RECORD_AREAS, RECORD_FORMATS, RECORD_FPS,
  DEFAULTS,
  brokenReason,
  clearBroken,
  getSettings,
  setSettings,
  getHistory,
  addHistory,
  clearHistory,
  updateHistoryEntry,
  shotsDir,
  checkShotsDir,
};

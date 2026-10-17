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

function readJson(name, fallback) {
  try {
    const raw = fs.readFileSync(file(name), 'utf8');
    const data = JSON.parse(raw);
    return data && typeof data === 'object' ? data : fallback;
  } catch (e) {
    return fallback;
  }
}

function writeJson(name, data) {
  try {
    fs.mkdirSync(path.dirname(file(name)), { recursive: true });
    fs.writeFileSync(file(name), JSON.stringify(data, null, 2), 'utf8');
    return true;
  } catch (e) {
    return false;
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

function setSettings(patch) {
  const next = { ...getSettings(), ...patch };
  if (patch.own) next.own = { ...getSettings().own, ...patch.own };
  writeJson('settings.json', next);
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
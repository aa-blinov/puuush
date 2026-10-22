'use strict';
/**
 * Язык главного процесса.
 *
 * Слова лежат в src/locales/*.json, и читают их два разных мира: главный
 * процесс (этот файл) и окна интерфейса (renderer/shared/i18n.js). Одна копия
 * словарей на оба, иначе строка про «буфер занят» появится в двух местах и
 * разъедется.
 *
 * Язык по умолчанию английский. Русский включается человеком в настройках, и
 * выбор лежит в settings.json рядом с остальными.
 */
const fs = require('node:fs');
const path = require('node:path');

const DIR = path.join(__dirname, 'locales');
const LANGS = ['en', 'ru'];
const DEFAULT_LANG = 'en';

const dicts = {};
for (const lang of LANGS) {
  try {
    dicts[lang] = JSON.parse(fs.readFileSync(path.join(DIR, `${lang}.json`), 'utf8'));
  } catch (e) {
    // Словарей нет: приложение всё равно должно запуститься и показать
    // ключи вместо текста, а не упасть на чтении файла.
    dicts[lang] = {};
  }
}

let current = DEFAULT_LANG;

/** Переключает язык. Возвращает тот, который действительно включился. */
function setLang(lang) {
  current = LANGS.includes(lang) ? lang : DEFAULT_LANG;
  return current;
}

function getLang() {
  return current;
}

/**
 * Строка по ключу.
 *
 * Неизвестный ключ возвращается как есть: это видно сразу, и копию текста
 * видно в интерфейсе, а не пустое место.
 */
function t(key, vars) {
  const dict = dicts[current] || dicts[DEFAULT_LANG] || {};
  let s = dict[key];
  if (s === undefined) s = (dicts[DEFAULT_LANG] || {})[key];
  if (s === undefined) return key;
  if (!vars) return s;
  return s.replace(/\{(\w+)\}/g, (m, name) =>
    vars[name] === undefined || vars[name] === null ? m : String(vars[name])
  );
}

module.exports = { t, setLang, getLang, LANGS, DEFAULT_LANG };

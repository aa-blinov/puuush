/**
 * Язык окон интерфейса.
 *
 * Те же словари, что и у главного процесса, но читаются они здесь иначе:
 * окно перерисовывается само, когда язык меняется, поэтому переводчик лежит
 * в хранилище, а текст достаётся через $t('ключ').
 *
 *   import { t } from '../shared/i18n.js';
 *   <button>{$t('ui.close')}</button>
 */
import { writable, derived } from 'svelte/store';
import en from '../../src/locales/en.json';
import ru from '../../src/locales/ru.json';

export const LANGS = [
  { value: 'en', label: 'English' },
  { value: 'ru', label: 'Русский' },
];

export const DEFAULT_LANG = 'en';

const dicts = { en, ru };

/** Текущий язык окна. */
export const lang = writable(DEFAULT_LANG);

export function setLang(next) {
  lang.set(LANGS.some((l) => l.value === next) ? next : DEFAULT_LANG);
}

function translate(dict, key, vars) {
  const s = dict[key];
  if (s === undefined) return key;
  if (!vars) return s;
  return s.replace(/\{(\w+)\}/g, (m, name) =>
    vars[name] === undefined || vars[name] === null ? m : String(vars[name])
  );
}

/** Переводчик: $t('ui.close'). */
export const t = derived(lang, ($lang) => {
  const dict = dicts[$lang] || dicts[DEFAULT_LANG];
  return (key, vars) => translate(dict, key, vars);
});

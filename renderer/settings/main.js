/**
 * Окно настроек.
 *
 * Порядок импортов значим: тема ставится до того, как собранный интерфейс
 * появится, иначе окно мигнуло бы чужой темой.
 */
import '../shared/theme.js';
import '../shared/app.css';
import { setLang } from '../shared/i18n.js';
import App from './App.svelte';

// Язык ставится до отрисовки: окно не должно мигнуть по-английски.
setLang(window.puuush.lang());

const app = new App({ target: document.getElementById('app') });

export default app;

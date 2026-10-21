/**
 * Окно настроек.
 *
 * Порядок импортов значим: тема ставится до того, как собранный интерфейс
 * появится, иначе окно мигнуло бы чужой темой.
 */
import '../shared/theme.js';
import '../shared/app.css';
import App from './App.svelte';

const app = new App({ target: document.getElementById('app') });

export default app;

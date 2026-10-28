import '../shared/theme.js';
import '../shared/app.css';
import { setLang } from '../shared/i18n.js';
import App from './App.svelte';

setLang(window.puuush.lang());

const app = new App({ target: document.getElementById('app') });

export default app;

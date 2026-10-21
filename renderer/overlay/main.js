/**
 * Окно выбора области.
 *
 * Затемнение делается «дыркой» через box-shadow у рамки, а не отдельным
 * оверлеем: так выделенная область остаётся без тумана и без лишнего слоя
 * перерисовки.
 */
import '../shared/theme.js';
import './overlay.css';
import App from './App.svelte';

const app = new App({ target: document.getElementById('app') });

export default app;

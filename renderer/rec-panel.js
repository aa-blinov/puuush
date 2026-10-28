/**
 * Панель записи: время, пауза и остановка.
 *
 * Живёт поверх всех окон, но фокус не забирает: showInactive в главном
 * процессе. Кнопки шлют команду и ничего не решают сами, состояние всегда
 * приходит обратно из главного процесса — так панель и трей не расходятся.
 */
const timeEl = document.getElementById('time');
const toggle = document.getElementById('toggle');
const toggleIcon = document.getElementById('toggle-icon');
const stop = document.getElementById('stop');
let ru = false;

let paused = false;

function clock(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h ? h + ':' + pad(m) + ':' + pad(s) : pad(m) + ':' + pad(s);
}

function render(state, elapsed) {
  paused = state === 'paused';
  document.body.classList.toggle('paused', paused);
  timeEl.textContent = clock(elapsed || 0);
  toggle.title = paused ? (ru ? 'Продолжить' : 'Resume') : ru ? 'Пауза' : 'Pause';
  // Иконка меняется вместе с состоянием: две полоски — пауза, треугольник —
  // продолжение.
  toggleIcon.innerHTML = paused
    ? '<path d="M5 3.5v9l7-4.5z" />'
    : '<rect x="4" y="3" width="3" height="10" rx="1" /><rect x="9" y="3" width="3" height="10" rx="1" />';
}

toggle.addEventListener('click', () => {
  window.puuushChrome.action(paused ? 'resume' : 'pause');
});

stop.addEventListener('click', () => {
  window.puuushChrome.action('stop');
});

render('recording', 0);
if (window.puuushChrome) {
  window.puuushChrome.onState((payload) => {
    if (!payload) return;
    ru = payload.lang === 'ru';
    render(payload.state, payload.elapsed);
  });
}

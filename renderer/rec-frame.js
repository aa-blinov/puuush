/**
 * Рамка записи: тонкая граница по краю экрана и плашка со мигающей точкой.
 *
 * Окно прозрачное и не берёт мышь: единственное, что здесь есть, — граница
 * и надпись. Состояние приходит из главного процесса.
 */
const label = document.getElementById('label');
let ru = false;

function render(state) {
  const paused = state === 'paused';
  document.body.classList.toggle('paused', paused);
  label.textContent = paused ? (ru ? 'Пауза' : 'Paused') : ru ? 'Запись' : 'REC';
}

render('recording');
if (window.puuushChrome) {
  window.puuushChrome.onState((payload) => {
    if (!payload) return;
    ru = payload.lang === 'ru';
    render(payload.state);
  });
}

/**
 * Режим темы следует за системой.
 *
 * Кит задаёт тему атрибутами на <html>: data-theme выбирает палитру,
 * data-mode — светлую или тёмную. Приложение не даёт выбора темы, оно
 * только повторяет системную настройку и меняет её на ходу, когда человек
 * переключает тему в системе.
 *
 * Атрибут ставится до того, как собранный интерфейс отрисуется: иначе окно
 * мигнуло бы чужой темой.
 */

const query = window.matchMedia('(prefers-color-scheme: dark)');

function apply() {
  document.documentElement.dataset.mode = query.matches ? 'dark' : 'light';
}

apply();

if (typeof query.addEventListener === 'function') {
  query.addEventListener('change', apply);
} else if (typeof query.addListener === 'function') {
  // Старые сборки Chromium: событие изменения подписывается иначе.
  query.addListener(apply);
}

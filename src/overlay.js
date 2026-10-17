'use strict';
/**
 * Окно выбора области. Показывает снимок экрана и даёт выделить прямоугольник.
 *
 * Затемнение делается «дыркой» через box-shadow у #cut, а не отдельным оверлеем:
 * так выделенная область остаётся без тумана и без лишнего слоя перерисовки.
 */

const shot = document.getElementById('shot');
const veil = document.getElementById('veil');
const cut = document.getElementById('cut');
const size = document.getElementById('size');
const hint = document.getElementById('hint');
const err = document.getElementById('err');

let W = 0;
let H = 0;
let start = null;
let box = null;

// Три параметра, а не два: вызывается как clamp(значение, 0, W).
// С лишним 0 посередине любая координата схлопывалась в ноль и рамку
// нельзя было стянуть никуда.
function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(v, hi));
}

function showError(text) {
  err.textContent = text;
  err.style.display = 'block';
  veil.style.display = 'none';
  shot.style.display = 'none';
  hint.style.display = 'none';
}

window.puuush.onFrame(({ dataUrl, width, height }) => {
  W = width;
  H = height;
  shot.src = dataUrl;
  shot.style.display = 'block';
  shot.style.width = W + 'px';
  shot.style.height = H + 'px';
});

shot.addEventListener('load', () => {
  veil.style.display = 'block';
});

// Клик без перетаскивания = весь экран. Так удобнее, чем тянуть рамку во всю
// сторону, и работает на трекпадах без нажатия.
shot.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return;
  start = { x: clamp(e.clientX, 0, W), y: clamp(e.clientY, 0, H) };
  box = { ...start, width: 0, height: 0 };
  cut.style.display = 'block';
  paint();
});

window.addEventListener('mousemove', (e) => {
  if (!start) return;
  const x = clamp(e.clientX, 0, W);
  const y = clamp(e.clientY, 0, H);
  box = {
    x: Math.min(start.x, x),
    y: Math.min(start.y, y),
    width: Math.abs(x - start.x),
    height: Math.abs(y - start.y),
  };
  paint();
});

window.addEventListener('mouseup', () => {
  if (!start) return;
  start = null;
  // Совсем маленький прямоугольник считаем промахом: скорее всего это клик.
  if (box && (box.width < 4 || box.height < 4)) {
    confirm({ x: 0, y: 0, width: W, height: H });
    return;
  }
  paint();
});

function paint() {
  if (!box) return;
  cut.style.left = box.x + 'px';
  cut.style.top = box.y + 'px';
  cut.style.width = box.width + 'px';
  cut.style.height = box.height + 'px';
  veil.style.display = 'none';
  size.style.display = box.width > 40 && box.height > 20 ? 'block' : 'none';
  size.style.left = box.x + box.width / 2 + 'px';
  size.style.top = box.y - 22 + 'px';
  size.style.transform = 'translateX(-50%)';
  size.textContent = `${Math.round(box.width)} × ${Math.round(box.height)}`;
  hint.textContent = 'Enter — выделенное, Esc — отмена, заново — тяни рамку';
}

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    e.preventDefault();
    window.puuush.submitRegion(null);
  } else if (e.key === 'Enter') {
    e.preventDefault();
    confirm(box && box.width >= 4 && box.height >= 4 ? box : { x: 0, y: 0, width: W, height: H });
  } else if (e.key === ' ' && !start) {
    e.preventDefault();
    confirm({ x: 0, y: 0, width: W, height: H });
  }
});

function confirm(rect) {
  if (!rect || !rect.width || !rect.height) return;
  window.puuush.submitRegion(rect);
}

window.addEventListener('error', (e) => showError('Ошибка окна выбора: ' + e.message));
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
let end = null;
let box = null;
// На сколько пикселей мышь должна сместиться, чтобы это считалось протяжкой,
// а не кликом.
const CLICK_SLOP = 4;

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
  end = { ...start };
  box = { ...start, width: 0, height: 0 };
  cut.style.display = 'block';
  paint();
});

window.addEventListener('mousemove', (e) => {
  if (!start) return;
  const x = clamp(e.clientX, 0, W);
  const y = clamp(e.clientY, 0, H);
  end = { x, y };
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
  // Клик отличается от протяжки по тому, насколько сместилась мышь, а не по
  // размеру получившейся рамки. Раньше проверялось второе, и тонкое выделение
  // вроде 2 на 500 пикселей считалось кликом: человек тянул полоску, чтобы
  // выхватить кусок текста, а улетал весь экран вместе с соседними окнами.
  const moved = Math.hypot(end.x - start.x, end.y - start.y) >= CLICK_SLOP;
  start = null;
  if (!moved) {
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
  // Над рамкой подпись, если там есть место. У самого верхнего края её ставим
  // под нижний край рамки: пилюля подсказки перекрыла бы её. Если и снизу не
  // влезает, держим внутри рамки у низа.
  let top = box.y - 22;
  if (box.y < 26) top = box.y + box.height + 6;
  if (top + 20 > H) top = box.y + box.height - 26;
  size.style.top = top + 'px';
  size.style.transform = 'translateX(-50%)';
  size.textContent = `${Math.round(box.width)} × ${Math.round(box.height)}`;
  // Текст статичный, пользовательского ввода здесь нет, поэтому innerHTML безопасен.
  hint.innerHTML = '<kbd>Enter</kbd> подтвердить, <kbd>Esc</kbd> отменить, <kbd>Space</kbd> — весь экран, заново — тяни рамку';
}

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    e.preventDefault();
    window.puuush.submitRegion(null);
  } else if (e.key === 'Enter') {
    e.preventDefault();
    // Рамку отправляем какой бы тонкой ни была: человек специально тянул,
      // чтобы выхватить полоску в один или два пикселя. Раньше здесь стояла
      // та же проверка размера, что и на mouseup, и Enter после тонкой
      // протяжки отправлял весь экран вместе с соседними окнами.
      confirm(box && box.width && box.height ? box : { x: 0, y: 0, width: W, height: H });
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
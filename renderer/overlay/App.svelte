<script>
  /**
   * Окно выбора области: показывает снимок экрана и даёт выделить
   * прямоугольник.
   */
  import Keys from '../shared/Keys.svelte';
  import { setLang, t } from '../shared/i18n.js';

  /** Снимок экрана и его размер в пикселях. */
  let shotSrc = '';
  let W = 0;
  let H = 0;
  let ready = false;
  /** Верх рабочей области: под строкой меню, а не у самого края экрана. */
  let workTop = 0;

  /** Выделение: начало, конец и готовый прямоугольник. */
  let start = null;
  let end = null;
  let box = null;

  /** Текст ошибки. Непустой — окно показывает его вместо выбора области. */
  let error = '';

  // На сколько пикселей мышь должна сместиться, чтобы это считалось протяжкой,
  // а не кликом.
  const CLICK_SLOP = 4;

  // Три параметра, а не два: clamp(значение, 0, W).
  // С лишним 0 посередине любая координата схлопывалась в ноль и рамку
  // нельзя было стянуть никуда.
  function clamp(v, lo, hi) {
    return Math.max(lo, Math.min(v, hi));
  }

  $: veilVisible = ready && !box;
  $: sizeLabel = box ? computeSize(box, H, workTop) : null;

  /** Подпись размера: над рамкой, под ней или внутри — как поместится. */
  function computeSize(rect, height, topEdge) {
    if (!(rect.width > 40 && rect.height > 20)) return null;
    // Над рамкой подпись, если там есть место. У верхнего края рабочей области её
    // ставим под нижний край рамки: пилюля подсказки перекрыла бы её. Если и снизу
    // не влезает, держим внутри рамки у низа.
    let top = rect.y - 22;
    if (rect.y < topEdge + 26) top = rect.y + rect.height + 6;
    if (top + 20 > height) top = rect.y + rect.height - 26;
    return {
      left: rect.x + rect.width / 2,
      top,
      text: `${Math.round(rect.width)} × ${Math.round(rect.height)}`,
    };
  }

  window.puuush.onFrame(({ dataUrl, width, height, lang: frameLang, workTop: topEdge }) => {
    // Язык окна едет вместе со снимком: окно открывается на секунды, и
    // отдельный запрос за языком успел бы прийти позже первого кадра.
    if (frameLang) setLang(frameLang);
    W = width;
    H = height;
    workTop = topEdge || 0;
    shotSrc = dataUrl;
  });

  function onShotLoad() {
    ready = true;
  }

  // Клик без перетаскивания = весь экран. Так удобнее, чем тянуть рамку во всю
  // сторону, и работает на трекпадах без нажатия.
  function onMouseDown(event) {
    if (event.button !== 0) return;
    // Без этого Chromium на Windows начинает нативное перетаскивание картинки:
    // mousemove и mouseup перестают приходить, рамка не растёт, и работал
    // только пробел, которому мышь не нужна.
    event.preventDefault();
    start = { x: clamp(event.clientX, 0, W), y: clamp(event.clientY, 0, H) };
    end = { ...start };
    box = { ...start, width: 0, height: 0 };
  }

  // Рамка перерисовывается не чаще кадра: мышь шлёт события чаще, а тень в
  // 9999 px поверх полноэкранной картинки на Windows стоит дорого, и очередь
  // перерисовок давала отставание рамки от курсора.
  let frame = 0;
  function onMouseMove(event) {
    if (!start) return;
    const x = clamp(event.clientX, 0, W);
    const y = clamp(event.clientY, 0, H);
    end = { x, y };
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      if (!start) return;
      box = {
        x: Math.min(start.x, end.x),
        y: Math.min(start.y, end.y),
        width: Math.abs(end.x - start.x),
        height: Math.abs(end.y - start.y),
      };
    });
  }

  function onMouseUp() {
    if (!start) return;
    // Клик отличается от протяжки по тому, насколько сместилась мышь, а не по
    // размеру получившейся рамки. Раньше проверялось второе, и тонкое выделение
    // вроде 2 на 500 пикселей считалось кликом: человек тянул полоску, чтобы
    // выхватить кусок текста, а улетал весь экран вместе с соседними окнами.
    const moved = Math.hypot(end.x - start.x, end.y - start.y) >= CLICK_SLOP;
    // Последнее положение мыши должно попасть в рамку до отпускания: кадр мог
    // ещё не отработать.
    if (moved) {
      box = {
        x: Math.min(start.x, end.x),
        y: Math.min(start.y, end.y),
        width: Math.abs(end.x - start.x),
        height: Math.abs(end.y - start.y),
      };
    }
    start = null;
    if (!moved) {
      confirm({ x: 0, y: 0, width: W, height: H });
      return;
    }
    // Рамка выделена — снимок делается сразу.
    //
    // Прежде здесь ничего не происходило: после протяжки надо было ещё
    // нажать Enter, и человек отпускал мышь и ждал второго нажатия. В
    // интерфейсе это читалось как «выделение не сработало».
    //
    // Enter и пробел остаются: ими выбирают область с клавиатуры.
    confirm(box);
  }

  function onKeydown(event) {
    if (event.key === 'Escape') {
      event.preventDefault();
      window.puuush.submitRegion(null);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      // Рамку отправляем какой бы тонкой ни была: человек специально тянул,
      // чтобы выхватить полоску в один или два пикселя. Раньше здесь стояла
      // та же проверка размера, что и на mouseup, и Enter после тонкой
      // протяжки отправлял весь экран вместе с соседними окнами.
      confirm(box && box.width && box.height ? box : { x: 0, y: 0, width: W, height: H });
    } else if (event.key === ' ' && !start) {
      event.preventDefault();
      confirm({ x: 0, y: 0, width: W, height: H });
    }
  }

  function confirm(rect) {
    if (!rect || !rect.width || !rect.height) return;
    window.puuush.submitRegion(rect);
  }

  function onError(event) {
    error = $t('overlay.error', { message: event.message });
  }
</script>

<svelte:window on:mousemove={onMouseMove} on:mouseup={onMouseUp} on:keydown={onKeydown} on:error={onError} on:dragstart|preventDefault />

{#if error}
  <div class="err">{error}</div>
{:else}
  {#if shotSrc}
    <!--
      Снимок экрана — не элемент интерфейса, а подложка, по которой тянут
      рамку. Мышь на нём работает как на холсте, а не как на кнопке, и
      клавиатурой до него не добраться: выбор области делается клавишами
      Enter и Esc.
    -->
    <!-- svelte-ignore a11y-no-noninteractive-element-interactions -->
    <img
      id="shot"
      class="shot"
      src={shotSrc}
      alt=""
      draggable="false"
      role="presentation"
      style="width: {W}px; height: {H}px"
      on:load={onShotLoad}
      on:mousedown={onMouseDown}
    />
  {/if}

  {#if veilVisible}
    <div class="veil"></div>
  {/if}

  {#if box}
    <div
      class="cut"
      style="left: {box.x}px; top: {box.y}px; width: {box.width}px; height: {box.height}px"
    ></div>
  {/if}

  {#if sizeLabel}
    <div class="size" style="left: {sizeLabel.left}px; top: {sizeLabel.top}px">
      {sizeLabel.text}
    </div>
  {/if}

  <div class="hint" style="top: {workTop + 22}px">
    <Keys text={box ? $t('overlay.hint.after') : $t('overlay.hint.start')} />
  </div>
{/if}

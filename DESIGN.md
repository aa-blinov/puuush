---
name: puuush
description: Снимок области экрана и ссылка на него в буфере обмена. Одна линейка с monos.
colors:
  bg: "#282828"
  surface: "#3c3836"
  surface-deep: "#504945"
  fg: "#ebdbb2"
  muted: "#a89984"
  faint: "#928374"
  rule: "#504945"
  control: "#928374"
  ring: "#ebdbb2"
  ok: "#b8bb26"
  danger: "#ff8a7a"
  info: "#83a598"
  selection-bg: "#ebdbb2"
  selection-fg: "#282828"
  overlay-pill: "rgba(40, 40, 40, 0.94)"
  scrim: "rgba(0, 0, 0, 0.45)"
  bg-light: "#fbf1c7"
  surface-light: "#ebdbb2"
  surface-deep-light: "#d5c4a1"
  fg-light: "#3c3836"
  muted-light: "#665c54"
  faint-light: "#928374"
  rule-light: "#d5c4a1"
  control-light: "#928374"
  ring-light: "#3c3836"
  ok-light: "#5f5f0e"
  danger-light: "#cc241d"
  info-light: "#076678"
  overlay-pill-light: "rgba(251, 241, 199, 0.94)"
typography:
  body:
    fontFamily: "JetBrains Mono, ui-monospace, monospace"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.55
  title:
    fontFamily: "JetBrains Mono, ui-monospace, monospace"
    fontSize: "20px"
    fontWeight: 700
    lineHeight: 1.3
    letterSpacing: "-0.025em"
  label:
    fontFamily: "JetBrains Mono, ui-monospace, monospace"
    fontSize: "11px"
    fontWeight: 500
    lineHeight: 1.45
    letterSpacing: "0.12em"
  hint:
    fontFamily: "JetBrains Mono, ui-monospace, monospace"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.5
  tag:
    fontFamily: "JetBrains Mono, ui-monospace, monospace"
    fontSize: "11px"
    fontWeight: 500
    letterSpacing: "0.12em"
rounded:
  ui: "6px"
spacing:
  tight: "4px"
  snug: "8px"
  base: "12px"
  comfortable: "16px"
  roomy: "24px"
  section: "32px"
  input: "32px"
components:
  button-text:
    backgroundColor: "transparent"
    textColor: "{colors.fg}"
    typography: "label, 500"
    height: "28px"
  button-text-primary:
    backgroundColor: "transparent"
    textColor: "{colors.fg}"
    typography: "label, 700"
    height: "28px"
  field-underline:
    backgroundColor: "transparent"
    textColor: "{colors.fg}"
    height: "32px"
  tag:
    backgroundColor: "transparent"
    textColor: "{colors.muted}"
    rounded: "{rounded.ui}"
    height: "22px"
  banner-danger:
    backgroundColor: "transparent"
    textColor: "{colors.fg}"
    rounded: "{rounded.ui}"
  overlay-pill:
    backgroundColor: "{colors.overlay-pill}"
    textColor: "{colors.fg}"
    rounded: "{rounded.ui}"
---

# Design System: puuush

## Overview

**Creative North Star: "Карточка на столе"**

Скриншот уходит туда же, где лежат заметки monos: тёплая бумага, чернила и одна
моноширинная гарнитура. Приложение живёт в трее и появляется на секунды, поэтому
оно должно выглядеть как часть той же линейки, а не как отдельная утилита.

Линейка общая с monos (его `DESIGN.md`): палитра Gruvbox, JetBrains Mono, один
радиус 6px, текстовые кнопки, поля с подчёркиванием, плоскость без теней. Здесь
добавлено только то, что нужно окнам puuush: рамка выбора области и пилюля
подсказки.

Тёмная тема основная. Её проработали первой, светлая идёт по системе и
проверена отдельно.

**Key Characteristics:**
- тёплые фоны и чернила, без чистого белого и чистого чёрного;
- один шрифт на всё окно: JetBrains Mono, кириллица из той же семьи;
- метки капсом с разрядкой, основной текст обычного регистра;
- плоско в покое: тени не используются вообще;
- состояние показывается цветом и текстом сразу.

## Colors

Палитра Gruvbox, тёплая и низкой насыщенности. Тёмная тема задаёт значения без
суффикса, светлая использует суффикс `-light`. Оба набора включаются через
`prefers-color-scheme`.

### Primary
- **Night Warm** (`#282828`, светлая `#fbf1c7`): поверхность окна.
- **Night Shade** (`#3c3836`, светлая `#ebdbb2`): второй слой, фон кода и поверхности.

### Secondary
- **Ink** (`#ebdbb2`, светлая `#3c3836`): основной текст, фокус и выделение. Контраст 10.75:1 на тёмном, 10.22:1 на светлом.
- **Ink Soft** (`#a89984`, светлая `#665c54`): вторичный текст. На тёмном только на фоне окна (5.30:1), на поверхностях текст переходит на Ink.

### Tertiary
- **Olive** (`#b8bb26`, светлая `#5f5f0e`): успех. Светлый olive для текста не держит, поэтому в светлой теме берётся темнее.
- **Clay Red** (`#ff8a7a`, светлая `#cc241d`): ошибка. Тёмный оттенок в тёмной теме читается как предупреждение, поэтому взят светлее.
- **Slate Blue** (`#83a598`, светлая `#076678`): информация, в интерфейсе сейчас не используется.

### Neutral
- **Rule** (`#504945`, светлая `#d5c4a1`): линии разделов и строк. Декоративная, контрастом не измеряется.
- **Control** (`#928374`, оба варианта): подчёркивание полей и края контролов, 4.02:1 на тёмном и 3.24:1 на светлом.
- **Scrim** (`rgba(0, 0, 0, 0.45)`): затемнение экрана под окном выбора области.

### Named Rules
**The Warm Ground Rule.** Фоны тёплые по построению. Чистые `#ffffff` и `#000000` в окнах не появляются.

**The Contrast Floor Rule.** Текст не ниже 4.5:1, подчёркивание полей и кольцо фокуса не ниже 3:1 (WCAG 1.4.11). Значения проверены по формуле WCAG.

## Typography

**Font:** JetBrains Mono (`fonts/`, четыре подмножества: latin, latin-ext, cyrillic, cyrillic-ext, OFL-лицензия рядом). Системного шрифта нет: окно не грузит внешних ресурсов, а `font-src 'self'` пускает только шрифты из своей папки.

**Character:** карточки на столе. Все строки одного шрифта выравниваются по колонкам без усилий, поэтому иерархия держится на размере и весе, а не на смене гарнитуры.

### Hierarchy
- **Title** (700, 20px, 1.3, -0.025em): заголовок окна «puuush».
- **Label** (500, 11px, 1.45, 0.12em, капс): заголовки разделов, метки. Цвет Ink Soft.
- **Body** (400, 13px, 1.55): подписи полей, основной текст. Цвет Ink.
- **Hint** (400, 12px, 1.5, Ink Soft): пояснения, не длиннее 75ch.
- **Tag** (500, 10px, 0.12em, капс): статусные метки.

### Named Rules
**The One Face Rule.** Окно не смешивает гарнитуры. Все тексты JetBrains Mono, включая клавиши и адреса.

## Layout

Фиксированная ширина 720px, без горизонтальной прокрутки. Разделы идут друг за
другом, между ними линия Rule и отступ 32px сверху и 24px внутри. Подпись,
поле и кнопка стоят в строке: подпись 168px, поле растягивается, кнопки справа.
Строки-галочки: подпись на всю ширину, галочка справа.

Вертикальная прокрутка есть, если разделы не помещаются в высоту окна. История
прокручивается внутри своей рамки, высота ограничена 240px.

Оверлей выбора области не имеет сетки: затемнённый снимок на весь экран, рамка
выделения и подпись размера над рамкой (или под ней, если рамка у верхнего края).

## Elevation & Depth

Плоско. Слои различаются цветом фона, а не тенями, и тени в системе не используются.
Пилюля подсказки в оверлее держится на рамке Rule. Выделение в оверлее держится на
рамке Ink и на затемнении вокруг.

### Named Rules
**The Flat-By-Default Rule.** Окна плоские всегда. Если элемент нужно отделить, это делает рамка или смена цвета.

## Shapes

Один радиус: 6px для всех прямоугольников, то есть для меток, клавиш, баннера и пилюли. Поля-подчёркивания радиуса не имеют: это одна линия. Круга нет.

Пунктир допустим только у зоны перетаскивания файла.

## Components

### Buttons
- **Shape:** текст и есть кнопка, рамки нет. Высота 28px, горизонтальный отступ 4px.
- **Default:** капс, 11px, 500, разрядка 0.1em, цвет Ink.
- **Primary:** то же с весом 700. Одна на экран, для действия, с которого начинается задача.
- **Hover:** яркость 70%, без смены цвета.
- **Focus:** контур 2px Ink со смещением 2px.
- **Disabled:** прозрачность 30%.

### Fields
- **Style:** только нижняя линия 1px Control, без фона и радиуса, высота 32px.
- **Focus:** линия становится Ink, плюс тонкая тень-линия 1px того же цвета.
- **Invalid:** линия Clay Red.
- **Placeholder:** Ink Soft, не ниже 4.5:1.
- **Select:** нативная стрелка скрыта, своя стрелка Ink Soft справа.
- **Checkbox:** 16px, заливка Ink.

### Tags
- **Style:** рамка Rule 1px, радиус 6px, высота 22px, капс 10px.
- **State:** `ok` оливковый, `bad` красный, `busy` цветом Ink.

### Banners
- **Broken settings:** рамка Clay Red 1px, радиус 6px, текст Ink. Заголовок Clay Red, причина Ink Soft. Цветной полосы сбоку нет.

### Overlay
- **Hint pill:** фон Night Warm с прозрачностью 94%, рамка Rule, радиус 6px, текст Ink 12px. Клавиши в `kbd`: рамка Control, фон Night Shade, капс не нужен.
- **Selection:** рамка 1px Ink, тонкая тёмная линия снаружи и затемнение Scrim вокруг.
- **Size label:** 20px в высоту, фон Ink, текст Night Warm (инверсия), радиус 6px.

## Do's and Don'ts

### Do:
- **Do** читать цвета через переменные темы, не писать hex внутри правил.
- **Do** проверять новое окно в тёмной теме первой, светлую потом.
- **Do** держать подчёркнутые поля и текстовые кнопки: это и есть линейка.
- **Do** писать состояние цветом и текстом сразу.

### Don't:
- **Don't** вводить залитые, рамочные или таблеточные кнопки. Текст в капсе и есть кнопка.
- **Don't** ставить тени в покое. Окна плоские.
- **Don't** использовать системный шрифт вместо JetBrains Mono.
- **Don't** красить функциональные цвета ради украшения: зелёный, красный и оливковый означают состояние.
- **Don't** брать чистый белый или чистый чёрный для фона окна.

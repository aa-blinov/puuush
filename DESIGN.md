---
name: puuush
description: "Окна трея, которые не просят внимания: нейтральная система в духе shadcn/ui для настроек и выбора области."
colors:
  bg: "#ffffff"
  surface: "#f4f4f5"
  fg: "#09090b"
  muted: "#52525b"
  placeholder: "#71717a"
  control-border: "#8e8e96"
  border: "#e4e4e7"
  ring: "#2563eb"
  primary: "#18181b"
  primary-fg: "#fafafa"
  primary-hover: "#27272a"
  danger: "#b91c1c"
  danger-bg: "#fef2f2"
  danger-border: "#fca5a5"
  ok: "#15803d"
  ok-bg: "#f0fdf4"
  ok-border: "#86efac"
  bg-dark: "#09090b"
  surface-dark: "#18181b"
  fg-dark: "#fafafa"
  muted-dark: "#a1a1aa"
  placeholder-dark: "#8a8a93"
  control-border-dark: "#71717a"
  border-dark: "#27272a"
  ring-dark: "#60a5fa"
  primary-dark: "#fafafa"
  primary-fg-dark: "#18181b"
  danger-dark: "#f87171"
  ok-dark: "#4ade80"
  scrim: "rgba(0, 0, 0, 0.45)"
typography:
  body:
    fontFamily: "ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Ubuntu, sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.5
  title:
    fontFamily: "ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Ubuntu, sans-serif"
    fontSize: "20px"
    fontWeight: 600
    lineHeight: 1.2
    letterSpacing: "-0.02em"
  section:
    fontFamily: "ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Ubuntu, sans-serif"
    fontSize: "14px"
    fontWeight: 600
    lineHeight: 1.4
    letterSpacing: "-0.01em"
  mono:
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace"
    fontSize: "12px"
    fontWeight: 500
    lineHeight: 1.5
  caption:
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace"
    fontSize: "11px"
    fontWeight: 500
    lineHeight: 1.4
rounded:
  sm: "4px"
  md: "6px"
  lg: "8px"
  pill: "999px"
spacing:
  xs: "6px"
  sm: "10px"
  md: "14px"
  lg: "20px"
  xl: "28px"
components:
  button-default:
    backgroundColor: "{colors.bg}"
    textColor: "{colors.fg}"
    rounded: "{rounded.md}"
    padding: "0 12px"
    height: "32px"
  button-default-hover:
    backgroundColor: "{colors.surface}"
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.primary-fg}"
    rounded: "{rounded.md}"
    padding: "0 12px"
    height: "32px"
  button-primary-hover:
    backgroundColor: "{colors.primary-hover}"
  input-text:
    backgroundColor: "{colors.bg}"
    textColor: "{colors.fg}"
    rounded: "{rounded.md}"
    padding: "0 10px"
    height: "32px"
  tag:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.muted}"
    rounded: "{rounded.pill}"
    padding: "0 8px"
    height: "22px"
---

# Design System: puuush

## Overview

**Creative North Star: "The Quiet Tool"**

Окна puuush появляются на секунды и возвращаются в фон. Система держится на
нейтральных слоях, тонких границах и тексте, который читается с первого
взгляда. Акцент один и служит только фокусу и выделению. Цветом сообщается
состояние, а не украшение.

Система повторяет нейтральную базу shadcn/ui: четыре слоя серого, граница 1px,
радиусы 6px и 8px, кольцо фокуса 2px. Тема следует за ОС, светлая и тёмная
равноправны.

**Key Characteristics:**
- нейтральные слои, без градиентов и стеклянных эффектов;
- одна кнопка-действие на экран, остальные контуры;
- состояния читаются текстом и цветом одновременно, не только цветом.

## Colors

Нейтральная палитра и один холодный акцент фокуса. Тёмная тема перечисляет
отдельные токены с суффиксом `-dark` и включается через `prefers-color-scheme`.

### Primary
- **Ink Black** (#18181b): фон главной кнопки. Единственная крупная заливка в окне.
- **Ink White** (#fafafa): текст главной кнопки и тёмная заливка в тёмной теме.

### Secondary
- **Focus Blue** (#2563eb, тёмная #60a5fa): кольцо фокуса, рамка области при выборе, выделение текста. Контраст 5.17:1 на белом и 7.83:1 на тёмном.

### Tertiary
- **Failure Red** (#b91c1c, тёмная #f87171): текст ошибки и рамка сломанного файла настроек.
- **Confirm Green** (#15803d, тёмная #4ade80): текст успешной проверки.

### Neutral
- **Paper** (#ffffff, тёмная #09090b): основной фон окна.
- **Quiet Slate** (#f4f4f5, тёмная #18181b): поля истории, статус, наведение.
- **Ink** (#09090b, тёмная #fafafa): основной текст, контраст 19.9:1.
- **Muted Ink** (#52525b, тёмная #a1a1aa): подписи и подсказки, не ниже 4.5:1.
- **Placeholder Gray** (#71717a, тёмная #8a8a93): плейсхолдеры, не ниже 4.5:1.
- **Control Edge** (#8e8e96, тёмная #71717a): рамка полей и кнопок, 3.25:1 на белом, 4.12:1 на тёмном.
- **Hairline** (#e4e4e7, тёмная #27272a): разделители секций, не контрол.
- **Scrim** (rgba(0, 0, 0, 0.45)): затемнение экрана под окном выбора области. Одно и то же в обеих темах.

### Named Rules
**The One Accent Rule.** Синий фокуса появляется только там, где элемент получил
клавиатуру или выделен. Ничего не красится синим ради красоты.

**The Contrast Floor Rule.** Текст не ниже 4.5:1, границы контролов и кольцо
фокуса не ниже 3:1. Значения проверены по WCAG, а не на глаз.

## Typography

**Display Font:** системный стек (`ui-sans-serif`, `system-ui`, `-apple-system`, `Segoe UI`, `Roboto`, `Ubuntu`). Загружаемых шрифтов нет: CSP окна запрещает внешние ресурсы, и системный шрифт каждой ОС читается привычно.
**Body Font:** тот же стек.
**Label/Mono Font:** `ui-monospace`, `SFMono-Regular`, `Menlo`, `Consolas`. Только для сочетания клавиш, пути, ключа и статуса.

**Character:** один семейство на всё окно. Продуктовый интерфейс служит задаче, поэтому характер держится на плотности и весе, а не на гарнитуре.

### Hierarchy
- **Title** (600, 20px, 1.2, -0.02em): заголовок окна «puuush».
- **Section** (600, 14px, 1.4, -0.01em): заголовки секций «Горячая клавиша», «Куда загружать».
- **Body** (400, 13px, 1.5): подписи полей, текст кнопок.
- **Hint** (400, 12px, 1.5, цвет Muted Ink): пояснения под полями, не длиннее 75ch.
- **Mono** (500, 12px, 1.5): сочетание клавиш, адрес сервера в статусе.
- **Caption** (500, 11px, 1.4, моноширинный): клавиши в подсказке оверлея, подпись размера, адреса в истории.

### Named Rules
**The One Family Rule.** Все тексты окна идут одним системным семейством. Моноширинный только для данных, которые человек сверяет посимвольно.

## Layout

Окно фиксированной ширины 720px, без горизонтальной прокрутки. Секции стоят
друг за другом, разделены линией Hairline и отступом 28px сверху и 20px
внутри. Сетка строк: подпись 168px, поле растягивается, кнопки справа.
Строки-галочки: подпись на всю ширину, галочка справа. Длинный список истории
прокручивается внутри своей рамки, высота ограничена 240px.

Оверлей выбора области не имеет сетки: затемнённый снимок на весь экран, рамка
выделения и подпись размера над ней на 22px.

## Elevation & Depth

Система плоская. Слои различаются цветом фона (Paper, Quiet Slate), а не тенями.
Единственная тень в системе — `0 1px 2px rgba(0,0,0,.08)` у всплывающих подсказок
оверлея, и только там, где рамка уже задаёт край.

### Shadow Vocabulary
- **Pill Lift** (`box-shadow: 0 1px 2px rgba(0,0,0,.08)`): подсказка и сообщение об ошибке в оверлее. Рамка остаётся основным краем.
- **Selection Edge** (`box-shadow: 0 0 0 1px rgba(0,0,0,.35), 0 0 0 9999px rgba(0,0,0,.45)`): рамка выделения и затемнение вокруг неё.

### Named Rules
**The Flat-By-Default Rule.** Поверхности плоские в покое. Тень появляется
только у плавающих элементов поверх чужого экрана.

## Shapes

Радиусы трёх размеров: 6px для контролов и кнопок, 8px для панелей и
предупреждений, 999px для тегов. Граница 1px, без обводок толще и без цветной
полосы сбоку. Пунктирная рамка только у зоны перетаскивания файла.

## Components

### Buttons
- **Shape:** 6px (`{rounded.md}`), высота 32px, горизонтальный отступ 12px.
- **Default (контур):** фон Paper, текст Ink, граница Control Edge. Наведение меняет фон на Quiet Slate.
- **Primary (заливка):** фон Ink Black, текст Ink White. Одна на экран, для действия, с которого начинается задача: «Выбрать файл…».
- **Focus:** кольцо 2px Focus Blue со смещением 2px. Без него кнопка не сделана.
- **Disabled:** прозрачность 50%, курсор по умолчанию.

### Inputs / Fields
- **Style:** фон Paper, граница 1px Control Edge, радиус 6px, высота 32px, отступ 10px.
- **Focus:** кольцо 2px Focus Blue со смещением 1px. Граница не меняется.
- **Placeholder:** Placeholder Gray, не ниже 4.5:1.
- **Select:** нативная стрелка скрыта, своя стрелка 12px цвета Muted Ink справа, отступ справа 34px.
- **Checkbox:** 16px, заливка в цвет Primary.

### Tags
- **Style:** пилюля 22px, фон Quiet Slate, текст Muted Ink, граница Hairline.
- **State:** `ok` зелёный, `bad` красный, `busy` с текстом Ink.

### Banners
- **Broken settings:** фон Danger Bg, граница Danger Border, заголовок Failure Red. Текст причины и последствия — Ink и Muted Ink.

### Overlay Hint
- **Style:** пилюля с радиусом 8px, фон Paper с прозрачностью 94%, граница Hairline. Клавиши в `<kbd>`: фон Quiet Slate, граница Control Edge, моноширинный 11px.
- **Size label:** 20px в высоту, радиус 4px, инверсия фона и текста (Ink на Paper и наоборот).

## Do's and Don'ts

### Do:
- **Do** держать кольцо фокуса 2px Focus Blue на каждом интерактивном элементе.
- **Do** подписывать действие глаголом: «Выбрать файл…», «Проверить сервер».
- **Do** показывать состояние текстом и цветом одновременно.
- **Do** проверять контраст новых токенов по WCAG перед коммитом.

### Don't:
- **Don't** делать больше одной кнопки Primary на экран.
- **Don't** использовать нативную стрелку `select`: она у каждой ОС своя.
- **Don't** добавлять веб-шрифты: окно работает без сети, а CSP их не пускает.
- **Don't** ставить тень с большим размытием рядом с тонкой рамкой. Выбери одно.
- **Don't** красить текст серым ниже 4.5:1 к фону, даже если «так привычнее».

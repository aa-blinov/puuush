---
name: puuush
description: A screenshot of a region of the screen and the link to it in the clipboard, on one line with monos.
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
---

# Design system: puuush

## Overview

**Creative North Star: "a card on the table"**

The screenshot goes where the notes already lie: warm paper, dark ink and a
single monospace family. The app lives in the tray and shows itself for a
few seconds at a time, so it has to look like part of that family rather
than like a separate utility.

The family is shared with monos, whose own `DESIGN.md` holds the same
palette, the same face and the same components: the Gruvbox palette, JetBrains
Mono, one radius of 6px, text buttons, underlined fields, and flat surfaces
with no shadows at all. Two things are added here for the windows puuush
needs: the frame of the region picker and the hint pill above it.

The dark theme is the primary one. It was worked out first, and the light
theme follows the system and was checked on its own.

Key characteristics:

- warm grounds and dark ink, with no pure white and no pure black;
- one font across the whole window, JetBrains Mono, with Cyrillic from the
  same family;
- labels in caps with letter spacing, body text in ordinary case;
- flat at rest, and the system uses no shadow at all;
- state is shown by colour and by text at the same time.

## Colors

The palette is Gruvbox, warm and low in saturation. The dark theme sets the
values without a suffix and the light theme uses the `-light` suffix. Both
sets are switched by `prefers-color-scheme`.

### Primary

- **Night Warm** (`#282828`, light `#fbf1c7`): the surface of the window.
- **Night Shade** (`#3c3836`, light `#ebdbb2`): the second layer, the ground
  of code blocks and of the surfaces that sit on the window.

### Secondary

- **Ink** (`#ebdbb2`, light `#3c3836`): body text, the focus ring and the
  selection. The contrast is 10.75:1 on the dark ground and 10.22:1 on the
  light one.
- **Ink Soft** (`#a89984`, light `#665c54`): secondary text. On the dark
  theme it only reaches 5.30:1 against the window ground, so on the raised
  surfaces the text switches back to Ink.

### Tertiary

- **Olive** (`#b8bb26`, light `#5f5f0e`): success. The bright olive does not
  hold as text on paper, so the light theme takes a darker one.
- **Clay Red** (`#ff8a7a`, light `#cc241d`): error. On the dark ground the
  lighter shade reads as a warning rather than as a stop, so it is the one
  that is used there.
- **Slate Blue** (`#83a598`, light `#076678`): information. The interface
  does not use it today.

### Neutral

- **Rule** (`#504945`, light `#d5c4a1`): the lines that divide sections and
  rows. Decoration, and not measured for contrast.
- **Control** (`#928374`, the same in both themes): the underline of a field
  and the edge of a control. 4.02:1 on the dark ground and 3.24:1 on the
  light one.
- **Scrim** (`rgba(0, 0, 0, 0.45)`): the dimming of the screen under the
  region picker.

### Named rules

**The Warm Ground Rule.** The grounds are warm by construction. Pure
`#ffffff` and pure `#000000` do not appear in the windows.

**The Contrast Floor Rule.** Text is never below 4.5:1, and the underline of
a field and the focus ring are never below 3:1, which is WCAG 1.4.11. The
values in the frontmatter were measured with the WCAG formula.

## Typography

**Font:** JetBrains Mono, in four subsets under `fonts/`: latin, latin-ext,
cyrillic and cyrillic-ext, with the OFL licence beside them. There is no
system font: the window loads no external resource, and the Content
Security Policy sets `font-src 'self'`, which allows only the fonts in its
own folder.

**Character:** a card on the table. Lines of one font line up into columns
without effort, so the hierarchy rests on size and weight rather than on a
change of family.

### Hierarchy

- **Title** (700, 20px, 1.3, -0.025em): the window title, "puuush".
- **Label** (500, 11px, 1.45, 0.12em, caps): the section headings and the
  field labels. The colour is Ink Soft.
- **Body** (400, 13px, 1.55): the field values and the main text. The colour
  is Ink.
- **Hint** (400, 12px, 1.5, Ink Soft): the explanations under the fields, at
  most 75 characters a line.
- **Tag** (500, 11px, 0.12em, caps): the status tags.

### Named rules

**The One Face Rule.** The window does not mix families. All of the text is
JetBrains Mono, keys and addresses included.

## Layout

The settings window is 720 pixels wide and 700 tall, with no horizontal
scroll. The sections follow each other, and between them there is a line in
the colour of a rule, 32 pixels of space above and 24 pixels of padding
inside.

A label, a field and a button stand in one row: the label takes 168
pixels, the field takes what is left, and the buttons sit on the right. A
checkbox row is different: the label takes the whole width and the checkbox
sits on the right, so that a long label never wraps.

There is vertical scrolling when the sections do not fit the height of the
window. The history scrolls inside its own frame, whose height is capped at
240 pixels.

The region picker has no grid. It is a dimmed capture over the whole
screen, a selection frame, and the size of the selection above the frame, or
below it when the frame is against the top of the screen.

## Elevation & Depth

Flat. The layers are told apart by the colour of the ground, and the system
uses no shadows. The hint pill in the picker rests on a rule-coloured
border, and the selection rests on an ink-coloured border with the dimming
around it.

### Named rules

**The Flat By Default Rule.** The windows are flat at all times. When an
element has to be set apart, a border or a change of colour does it.

## Shapes

One radius: 6px for every rectangle, which means the tags, the keys, the
banner and the pill. The underlined fields have no radius, because they are
a single line. There is no circle anywhere.

A dashed line is allowed in one place only, around the drop target for a
file.

## Components

### Buttons

- **Shape:** the text is the button, and there is no frame around it. The
  height is 28 pixels and the horizontal padding is 4.
- **Default:** caps, 11px, weight 500, 0.1em of letter spacing, the colour
  Ink.
- **Primary:** the same at weight 700. One per screen, on the action the
  task starts from.
- **Hover:** the brightness drops to 70%, and the colour does not change.
- **Focus:** a 2px ring in Ink, offset by 2.
- **Disabled:** 30% opacity.

### Fields

- **Style:** a 1px underline in the colour of a control, no background and
  no radius, 32 pixels tall.
- **Focus:** the line becomes Ink, and a thin shadow line in the same colour
  is added under it.
- **Invalid:** the line becomes Clay Red.
- **Placeholder:** Ink Soft, never below 4.5:1.
- **Select:** the native arrow is hidden and replaced with one in Ink Soft
  on the right, because the native one is drawn differently on every
  operating system.
- **Checkbox:** 16 pixels, filled with Ink.

### Tags

- **Style:** a 1px border in the colour of a rule, a radius of 6, a height
  of 22, caps at 11px.
- **State:** `ok` is olive, `bad` is clay red, `busy` takes the colour of
  Ink.

### Banners

- **Broken settings:** a 1px border in Clay Red, a radius of 6, the text in
  Ink. The heading is Clay Red and the reason is Ink Soft. There is no
  coloured bar down the side.

### Overlay

- **Hint pill:** the ground of Night Warm at 94% opacity, a border in the
  colour of a rule, a radius of 6, the text in Ink at 12px. The keys sit in
  `kbd` with a border in the colour of a control and the ground of Night
  Shade.
- **Selection:** a 1px border in Ink, a thin dark line outside it, and the
  scrim around it.
- **Size label:** 20 pixels tall, the ground of Ink, the text of Night Warm
  inverted, a radius of 6.

## Do's and Don'ts

### Do:

- **Do** read the colours through the theme variables, and never write a hex
  value inside a rule.
- **Do** check a new window in the dark theme first and in the light theme
  second.
- **Do** keep the underlined fields and the text buttons. That is the
  family.
- **Do** show the state by colour and by text at the same time.
- **Do** turn every transition off under `prefers-reduced-motion`.

### Don't:

- **Don't** introduce filled, framed or pill-shaped buttons. Caps in the text
  are the button.
- **Don't** put a shadow on anything at rest. The windows are flat.
- **Don't** fall back on the system font instead of JetBrains Mono.
- **Don't** paint the functional colours for decoration. Green, red and
  olive mean a state.
- **Don't** use a pure white or a pure black for the ground of a window.

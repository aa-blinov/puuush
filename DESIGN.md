---
name: puuush
description: A screenshot of a region of the screen and the link to it in the clipboard, on one line with monos.
kit: "@monos/ui"
palette: gruvbox
colors:
  canvas: "#282828"
  surface: "#3c3836"
  surface-2: "#504945"
  ink: "#ebdbb2"
  ink-soft: "#b1a491"
  ink-faint: "#b1a491"
  ink-muted: "#928374"
  line: "#504945"
  accent: "#83a598"
  danger: "#fb4934"
  warning: "#fe8019"
  success: "#b8bb26"
  info: "#83a598"
  selection-bg: "#ebdbb2"
  selection-fg: "#282828"
  overlay-pill: "color-mix(in srgb, var(--ui-bg) 94%, transparent)"
  scrim: "rgba(0, 0, 0, 0.45)"
  canvas-light: "#fbf1c7"
  surface-light: "#ebdbb2"
  surface-2-light: "#d5c4a1"
  ink-light: "#3c3836"
  ink-soft-light: "#6a5e55"
  line-light: "#d5c4a1"
  accent-light: "#458588"
  danger-light: "#cc241d"
  warning-light: "#d65d0e"
  success-light: "#98971a"
typography:
  base:
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
  body:
    fontFamily: "JetBrains Mono, ui-monospace, monospace"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.45
  tag:
    fontFamily: "JetBrains Mono, ui-monospace, monospace"
    fontSize: "11px"
    fontWeight: 500
    letterSpacing: "0.12em"
rounded:
  ui: "6px"
spacing:
  hair: "2px"
  tight: "4px"
  field: "6px"
  snug: "8px"
  input: "10px"
  base: "12px"
  comfortable: "16px"
  roomy: "24px"
  section: "32px"
---

# Design system: puuush

## Overview

**Creative North Star: "a card on the table"**

The screenshot goes where the notes already lie: warm paper, dark ink and a
single monospace family. The app lives in the tray and shows itself for a
few seconds at a time, so it has to look like part of that family rather
than like a separate utility.

The system is the [monos-ui](https://github.com/aa-blinov/monos-ui) kit, and
this file says what the app adds to it. The kit holds the components, the
tokens and the themes; the rules of the kit are the rules here:

- **Colour is a role, not a value.** A component reads `var(--ui-…)` and
  never names a colour of the palette. Changing the theme changes values, not
  components.
- **One radius.** Every rectangle is `--ui-radius`, which is 6px. Only what is
  round by nature is round.
- **Text is the button.** There is no filled button and no framed button. A
  frame belongs to the selected state of a switch and to nothing else.
- **Flat at rest.** A card has a shadow of 3% black, and raises it only on
  hover and in overlays.
- **A quiet focus.** Two pixels in the ink of the theme, and only from the
  keyboard.
- **The words belong to the product.** The kit carries no labels of its own;
  they arrive as props and as content.

The kit's own `DESIGN.md` describes the system in full, and the app follows
it rather than restating it. Two things are added here for the windows
puuush needs: the frame of the region picker and the hint pill above it.

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

The palette is Gruvbox, warm and low in saturation, and it comes from the kit
as a theme rather than as a list of values in this app. The dark theme sets
the values without a suffix and the light theme uses the `-light` suffix.
Both sets are switched by `prefers-color-scheme`: the window puts `data-mode`
on `<html>` and follows the system, so a change of theme in the system
changes the window at once.

### Primary

- **Canvas** (`#282828`, light `#fbf1c7`): the surface of the window.
- **Surface** (`#3c3836`, light `#ebdbb2`): the second layer, the ground of
  the file list and of the surfaces that sit on the window.

### Secondary

- **Ink** (`#ebdbb2`, light `#3c3836`): body text, the focus ring and the
  selection.
- **Ink Soft** (`#b1a491`, light `#6a5e55`): secondary text and field labels.
- **Ink Faint** (`#b1a491`, light `#6a5e55`): metadata, the time of a row in
  the history.
- **Ink Muted** (`#928374`, both themes): decoration and disabled state. Not
  for a sentence.

### Tertiary

- **Success** (`#b8bb26`, light `#98971a`): a state that succeeded.
- **Danger** (`#fb4934`, light `#cc241d`): a state that failed.
- **Warning** (`#fe8019`, light `#d65d0e`): a state that needs a decision.
- **Accent** (`#83a598`, light `#458588`): information and the selected
  state of a switch.

### Neutral

- **Line** (`#504945`, light `#d5c4a1`): the lines that divide sections and
  rows. Decoration, and not measured for contrast.
- **Scrim** (`rgba(0, 0, 0, 0.45)`): the dimming of the screen under the
  region picker.

### Named rules

**The Role Rule.** The app names no colour of its own. Every colour in the
windows is a role of the kit, and the three values that belong to the app
alone are the scrim, the pill and the size label of the picker.

**The Warm Ground Rule.** The grounds are warm by construction. Pure
`#ffffff` and pure `#000000` do not appear in the windows.

**The Contrast Floor Rule.** The kit measures its own roles against AA, on
the page and on the card, in all twelve pairs of theme and mode. The app
adds no colour, so the floor does not have to be checked again.

## Typography

**Font:** JetBrains Mono, in four subsets under `renderer/fonts/`: latin,
latin-ext, cyrillic and cyrillic-ext, with the OFL licence beside them.
There is no system font: the window loads no external resource, and the
Content Security Policy sets `font-src 'self'`, which allows only the fonts
in its own folder.

**Character:** a card on the table. Lines of one font line up into columns
without effort, so the hierarchy rests on size and weight rather than on a
change of family.

### Hierarchy

The sizes come from the kit's scale; the app picks a step of it.

- **Title** (700, 20px, 1.3, -0.025em): the window title, "puuush".
- **Label** (500, 11px, 0.12em, caps): the field labels and the section
  headings. The colour is Ink Soft.
- **Body** (400, 13px, 1.55): the field values and the main text.
- **Whisper** (400, 11px): the section headings, and the metadata.
- **Tag** (500, 11px, 0.12em, caps): the status tags.

### Named rules

**The One Face Rule.** The window does not mix families. All of the text is
JetBrains Mono, keys and addresses included.

## Layout

The settings window is 720 pixels wide and 700 tall, with no horizontal
scroll. The sections follow each other, and between them there is a line in
the colour of a rule, 32 pixels of space above and 24 pixels of padding
inside. The column itself is 42rem wide, so that a long hint never runs
across the whole window.

A label stands above its field, the way the kit lays out a form. An action
that belongs to a field stands in the same row, on the right, and sits on
the lower edge of the field. A checkbox row is a row of its own.

There is vertical scrolling when the sections do not fit the height of the
window. The history is a list of rows with hairline separators, and an empty
history shows the kit's empty state rather than an empty box.

The region picker has no grid. It is a dimmed capture over the whole
screen, a selection frame, and the size of the selection above the frame, or
below it when the frame is against the top of the screen.

## Elevation & Depth

Flat. The layers are told apart by the colour of the ground, and the system
uses no shadows. The hint pill in the picker rests on a line-coloured
border, and the selection rests on an ink-coloured border with the dimming
around it.

### Named rules

**The Flat By Default Rule.** The windows are flat at all times. When an
element has to be set apart, a border or a change of colour does it.

## Shapes

One radius: 6px for every rectangle, which means the tags, the keys, the
banner and the pill. There is no circle anywhere.

A dashed line is allowed in one place only, around the drop target for a
file, and that drop target belongs to the kit.

## Components

The components come from the kit. The app supplies the words and the
behaviour, and nothing else: `PageHeader` for the head of the window,
`Section` for the sections, `Button` for the actions, `TextField` and
`SelectField` for the fields, `Checkbox` for the switches, `Notice` for the
messages, `Badge` for the state, `EmptyState` for the empty history,
`FileUpload` for the drop target and `Kbd` for the keys in the hint.

### Fields

- **Style:** the kit's underlined field, no background and no radius.
- **Focus:** the line becomes Ink.
- **Invalid:** the line becomes Danger, and the address field says so even
  when the message is read out loud.
- **Select:** the kit's own arrow, in Ink Soft on the right.

### Tags

- **Style:** the kit's badge: a border in the colour of a line, a radius of
  6, caps at 11px.
- **State:** `ok` is success, `bad` is danger, `busy` takes the accent.

### Banners

- **Broken settings:** the kit's notice with the danger tone, the reason
  under the heading, and the wording that says what the person has to do.

### Overlay

- **Hint pill:** the ground of the window at 94% opacity, a border in the
  colour of a line, a radius of 6, the text in Ink. The keys sit in the
  kit's `Kbd`.
- **Selection:** a 1px border in Ink, a thin dark line outside it, and the
  scrim around it.
- **Size label:** 20 pixels tall, the ground of Ink, the text of the canvas
  inverted, a radius of 6.

## Do's and Don'ts

### Do:

- **Do** read the colours through the theme variables, and never write a hex
  value inside a rule.
- **Do** reach for a component of the kit before writing a new one.
- **Do** check a new window in the dark theme first and in the light theme
  second.
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

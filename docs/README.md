# Documentation

The index of the documents in this folder.

`puuush` is a tray application for taking a screenshot of a region of the
screen, uploading it and putting the link in the clipboard. The documents
here cover how that is put together and what the interface looks like.

| Document | What it covers |
| --- | --- |
| [architecture.md](architecture.md) | The modules, the data flow, the decisions behind them and the boundaries. |
| [screenshots/README.md](screenshots/README.md) | What the three pictures in this folder show and where they come from. |
| [../README.md](../README.md) | The front door: what it does, how to run it and how to configure it. |
| [../AGENTS.md](../AGENTS.md) | The commands, the layout of the tree, and the traps. |
| [../PRODUCT.md](../PRODUCT.md) | Who the app is for, and what it must not turn into. |
| [../DESIGN.md](../DESIGN.md) | The visual system: the palette, the type, the components of the two windows. |
| [../server/README.md](../server/README.md) | The upload server that ships with the app. |

The three pictures themselves sit in `docs/`, next to this folder. The README
links to them from the top of the page, and the paths there are shorter
that way.

| Picture | What it shows |
| --- | --- |
| [ui-overlay.png](ui-overlay.png) | The region picker over a real screen. |
| [ui-settings.png](ui-settings.png) | The settings window. |
| [ui-settings-broken.png](ui-settings-broken.png) | The settings window when the configuration file could not be read. |

## Reading order

New here: [../README.md](../README.md), then [architecture.md](architecture.md)
for how the app is put together.

Changing the code: [architecture.md](architecture.md), then
[../AGENTS.md](../AGENTS.md) for the traps. The traps cover the crop in
device pixels, the atomic write of the settings and the fallback order of
the uploads, which are the parts that cost a rebuild to learn.

Changing the look of the windows: [../DESIGN.md](../DESIGN.md) says what the
app adds to the interface kit, and the components live in `renderer/`. The
tokens, the themes and the components themselves come from the
[monos-ui](https://github.com/aa-blinov/monos-ui) kit.

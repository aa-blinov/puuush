# AGENTS.md — agent context for `puuush`

An Electron app that screenshots a region of the screen, uploads it, and puts
the link in the clipboard. It lives in the tray and has no main window, and
it ships with its own upload server.

This file is what you need to work on the project without reading all of it.

## Run / build / test

```bash
npm ci          # install
npm start       # run the app
npm run cli     # run the app from the command line
npm test        # the Node test runner, two files
npm run check   # the tests, plus node --check on the three entry files
npm run icons   # re-render the icons from assets/icon.svg
npm run dist    # build for macOS, Windows and Linux
```

Node 22 and Electron 44. There is no build step for the app itself:
electron-builder produces the installers, and `npm run check` is what CI runs.

## Where things live

| Path | What it holds |
| --- | --- |
| `src/main.js` | The tray, the global hotkey, the region picker, the settings window. The only file that touches Electron's `app`. |
| `src/capture.js` | The screen capture and the crop. Knows about display scaling, nothing else. |
| `src/upload.js` | The upload targets, the fallback order, the file name rules. Knows nothing about Electron. |
| `src/store.js` | The settings file, and what happens when it cannot be read. |
| `src/preload-overlay.js` | The region picker's preload. The picker is a separate window. |
| `server/index.js` | The upload receiver. `node:http` and nothing else, on purpose. |
| `server/config.example.json` | The server configuration, with the values filled in. |
| `server/puuush-server.service` | The systemd unit the server runs under. |
| `test/electron/` | The checks that need a real Electron window. |
| `assets/` | The icons, and the tray images. |

## Traps

- **The crop is in device pixels, not pointer pixels.** `display.scaleFactor`
  is the wrong number on some setups, and `src/capture.js` says so in a
  comment near the top. The frame is cut from the original capture, so a
  Retina display keeps its resolution. Get this wrong and a Retina screenshot
  comes out at half size, cropped to the wrong area.
- **The key travels in the `Authorization` header.** Putting it in the URL
  puts it in the access log of every proxy in front of the server, in plain
  text. The header is the only place it goes.
- **The server has no dependencies, and that is a rule.** It runs on `node:http`
  because the host already has Node 22 and an update is a file copy and a
  `systemctl restart`. Adding a dependency breaks the update procedure.
- **Caddy serves the files, the Node process does not.** The Node process
  accepts uploads and keeps the ledger. Caddy already serves everything else
  on that machine, and a second server in the hot path only makes it slower.
- **The upload order is the fallback order.** The configured server is tried
  first, then catbox, pomf2, and uguu. A candidate that answers with a broken
  link is not a candidate, and the next one is tried.
- **The client marks its own uploads.** The first bytes of the file are a
  random marker, and the server recognises it. That is how the server tells
  its own files from a file somebody else posted, and it is what lets the
  "own server only" mode work.
- **File names are transliterated.** Cyrillic in a name becomes Latin, and
  anything that does not survive the transliteration becomes a hash tail. A
  name that cannot be encoded cannot be stored.

## Style / safety rails

- **No dependencies in `server/`.** The whole point of the server is that it
  updates by copying one file.
- **The key never goes in a URL.**
- **Do not add a main window.** The app is a tray app. A window that shows
  up unasked is a bug.
- **Comments explain why, never what.** The comments in this codebase are
  unusually good on this point. Keep them that way.

## Where the product truth lives

`PRODUCT.md` holds it. Read it before changing the behaviour of the app, and
write the change there when the behaviour changes.

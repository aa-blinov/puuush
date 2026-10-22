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
npm test              # the Node test runner, two files
npm run check         # build the windows, svelte-check, the tests
npm run test:electron # the checks that need a real Electron window
npm run build:renderer # build the two windows from renderer/
npm run shots         # re-take the screenshots in the README
npm run icons         # re-render the icons from assets/icon.svg
npm run dist          # build for macOS, Windows and Linux
npm run dist:linux    # build one platform
npm run release:notes 1.1.0  # the release notes of a version
```

Node 22 and Electron 44. The app itself has one build step: the two windows
are built from `renderer/` into `src/renderer/` by Vite, and the built files
stay out of git. Every step that starts the app or packs it builds the
windows first, and `npm run check` is what CI runs.

## Where things live

| Path | What it holds |
| --- | --- |
| `src/main.js` | The tray, the global hotkey, the region picker, the settings window. The only file that touches Electron's `app`. |
| `src/capture.js` | The screen capture and the crop. Knows about display scaling, nothing else. |
| `src/upload.js` | The upload targets, the fallback order, the file name rules. Knows nothing about Electron. |
| `src/store.js` | The settings file, and what happens when it cannot be read. |
| `src/preload-overlay.js` | The region picker's preload. The picker is a separate window. |
| `renderer/` | The sources of the two windows: Svelte 4, Tailwind and the monos-ui kit. |
| `src/renderer/` | The built windows. Not in git; built by `npm run build:renderer`. |
| `server/index.js` | The upload receiver. `node:http` and nothing else, on purpose. |
| `server/config.example.json` | The server configuration, with the values filled in. |
| `server/puuush-server.service` | The systemd unit the server runs under. |
| `test/electron/` | The checks that need a real Electron window. |
| `assets/` | The icons, and the tray images. |
| `site/` | The published site. It is plain HTML and CSS, and GitHub Pages serves it as it is. |

## Releases

A tag of `v*` builds the installers for all three platforms and publishes them
on the releases page. The workflow is `.github/workflows/release.yml`: it
checks the tag against the version in `package.json`, builds on the runner of
each platform (electron-builder cannot cross-build), and publishes the files
with the matching section of `CHANGELOG.md` as the body.

## Traps

- **Версия в теге и в package.json должны совпадать.** Workflow проверяет это
  сам и останавливается, если они разошлись: релиз с чужим номером хуже,
  чем никакого.
- **Сборка идёт нативно на своей ОС.** `.dmg` собирается только на macOS, а
  `.exe` только на Windows, и обе архитектуры macOS — на своих раннерах.
  Кросс-сборка electron-builder не умеет.
- **Подпись есть только у сборок, которые кто-то подписал.** Сейчас её нет:
  macOS спросит про незнакомого разработчика, Windows — про SmartScreen, и
  оба раза это снимается одним кликом. Автообновление без подписи не
  приедет, поэтому его и нет.

- **The windows are built, and the build is not optional.** `src/renderer/`
  is not in git. A change to `renderer/` without a build leaves the app
  showing the previous windows, and a packaging run without the build leaves
  the package without any windows at all.
- **The kit is not on npm.** It is installed from its repository, and
  `npm ci` fetches it from there. Its components are Svelte sources, so the
  Tailwind config has to scan `node_modules/@monos/ui/src` as well, or the
  classes of the components never reach the stylesheet.
- **A preload in a sandboxed window cannot read the disk.** It gets
  `electron` and a handful of Node modules, and nothing else. Data for the
  renderer comes over IPC.
- **The words of the interface live in two dictionaries.**
  `src/locales/en.json` and `src/locales/ru.json`, и читают их и главный
  процесс, и окна. Новое слово идёт в оба файла: в тестах проверки берут
  текст из словаря, а не пишут руками.
- **Язык по умолчанию английский**, а русский человек включает в настройках.
  Выбор лежит в `settings.json` рядом с остальными, и главный процесс
  переключает язык на лету, когда окно его меняет.
- **Сайт лежит в `site/` и публикуется сам.** Это обычные HTML и CSS без
  сборки: workflow `pages.yml` отдаёт каталог `site/` как есть. Картинки для
  сайта снимает `npm run shots` вместе с картинками для README, и лежат они
  в `site/media/`.
- **Свой сервер внутри зовётся `own`.** Раньше он звался «свой box», и
  главный процесс узнавал о его сбое по совпадению в тексте. С переводом
  текст перестал быть надёжным признаком, и сбой теперь помечается на самой
  ошибке.

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

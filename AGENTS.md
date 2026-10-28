# AGENTS.md — agent context for `puuush`

An Electron app that screenshots a region of the screen or records a video or
GIF, uploads the result and puts the link, image or file in the clipboard. It
lives in the tray and has no main window, and it ships with its own upload
server.

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
| `src/cli.js`, `src/selftest.js` | `--cli` and `--selftest`. Both get what they need from `main.js` as arguments, none touches the tray itself. |
| `src/toast.js` | The corner popup "copied to the clipboard". No focus, no mouse, gone in a few seconds; not a main window. |
| `src/hotkey.js` | Hotkey string parsing. Pure. |
| `src/capture.js` | The screen capture and the crop. Knows about display scaling, nothing else. |
| `src/clipboard.js` | The clipboard: text, the picture out of it, the picture into it. Asynchronous in Electron 44, so every call is awaited. |
| `src/upload.js` | The upload targets, the fallback order, the file name rules. Knows nothing about Electron. |
| `src/recorder.js` | The recording session: streams, screen or region bounds, WebM/GIF file on disk, pause and stop. |
| `src/recording-chrome.js` | The red recording frame and the timer/pause/stop panel, excluded from the capture. |
| `src/local-server.js` | The local share: the file is already on disk, and this serves it while the app is open. |
| `src/store.js` | The settings file, and what happens when it cannot be read. |
| `src/preload-overlay.js` | The region picker's preload. The picker is a separate window. |
| `renderer/` | The sources of the settings, region picker and recording chrome, plus the recorder page and GIF encoder. Svelte 4, Tailwind and the monos-ui kit. |
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
  first, then the cloud hosts in the order measured by the speed test, and
  x0.at, uguu, pomf2, catbox, litterbox by default. A candidate that answers
  with a broken link is not a candidate, and the next one is tried.
- **Cloud latency is regional.** The speed test uploads a small file to every
  cloud host from this machine and saves the working order in `hostOrder`.
  Do not hard-code a "fastest" host: it is different in different countries.
- **Every host has a file limit.** A file over a host's `max` is skipped with
  the reason, not sent to fail after a long upload. A host that failed
  recently is skipped for five minutes.
- **A big file goes as a stream.** Over 8 MiB the body is not built in memory:
  the head, the file from the disk and the tail go to the socket in turn. The
  own server takes a big file straight to disk the same way. A recording of a
  meeting is hundreds of megabytes, and two copies of it in RAM would be a
  problem on any ordinary machine.
- **A video recording is one WebM file.** Video and the mixed audio track come
  from the same MediaRecorder. The microphone and the Windows loopback device
  are joined in Web Audio and checked by source count before the file starts.
  GIF takes a separate path and has no audio at all.
- **GIF is encoded on the recording page.** `renderer/recorder/gif.js` builds a
  6x7x6 palette per frame and writes GIF89a directly: there is no ffmpeg and no
  second native dependency. The direct palette index and typed-array LZW
  dictionary are what keep 30 and 60 fps usable; going back to a nearest-colour
  scan over all 256 palette entries makes the encoder fall far below the
  selected frame rate. The width caps are 1600 for 30 fps and 960 for 60.
- **The recording takes one chosen screen or region by default.**
  `recordArea` is `screen`, `region` or `all`; for `screen`, `recordScreen` is
  `cursor`, `all` or a display id, and an unknown id falls back to the pointer.
  The video frame is scaled to at most 2560 pixels wide. Three monitors in one
  frame are expensive to encode and unreadable, so all screens is a choice, not
  the default.
- **The client marks its own uploads.** The first bytes of the file are a
  random marker, and the server recognises it. That is how the server tells
  its own files from a file somebody else posted, and it is what lets the
  "own server only" mode work.
- **A picker window may answer after it is closed.** Every screen has its own
  picker, and choosing on one closes the rest. The IPC handler compares the
  numeric sender id, never `win.webContents`: touching a destroyed window
  throws "Object has been destroyed" and Electron shows a modal error over
  the whole desktop.
- **Recording chrome is excluded from the capture on purpose.** The frame and
  the panel call `setContentProtection(true)`: on Windows that is
  WDA_EXCLUDEFROMCAPTURE, so they are visible on the monitor and absent from
  the recording. Removing the call puts a red border into every video.
- **A frameless window is clamped to the work area.** Without
  `setResizable(true)` around `setBounds`, Windows shaves the taskbar height
  off the window, and the bottom of the screen is left uncovered. This applies
  both to the recording frame and to the region picker.
- **The panel talks back over its own channel.** `recording-chrome.js` owns
  `puuush:chrome-action` while a recording runs and removes the listener with
  the windows; main.js must not listen to it as well, or every click is
  handled twice.
- **Tray states have a priority.** A running recording blinks red; an upload
  shows the busy icon only when no recording is active. `uploadsInFlight` is a
  counter, not a boolean, because a screenshot and a long video may upload at
  the same time.
- **File names are transliterated.** Cyrillic in a name becomes Latin, and
  anything that does not survive the transliteration becomes a hash tail. A
  name that cannot be encoded cannot be stored.

- **Settings and gallery use the native Electron frame.** Leave the native
  titlebar available so the whole top edge moves the window and Windows draws
  the app icon and window controls. The windows call `setMenu(null)` and hide
  the menu bar; a web titlebar here would take over dragging again.

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

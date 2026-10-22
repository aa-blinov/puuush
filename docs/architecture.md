# Architecture

How puuush is put together.

The app is a tray application. It has no main window: the hotkey and the
tray menu are the whole interface, and the settings window opens only when
somebody asks for it. Everything the app does is a short sequence, and the
sequence is the product.

## The shape

The client is a small Electron app with no dependencies beyond Electron
itself, and the server is a Node process with no dependencies at all. The
split between them is deliberate and it is the main boundary in the
repository.

| Path | What it is responsible for |
| --- | --- |
| `src/main.js` | The tray, the global hotkey, the region picker, the settings window and the command line mode. The only file that touches Electron's `app`. |
| `src/capture.js` | The screen capture and the crop. It knows about display scaling and nothing else. |
| `src/upload.js` | The upload targets, the fallback order and the file name rules. It knows nothing about Electron. |
| `src/store.js` | The settings file, the history and what happens when the settings cannot be read. |
| `src/i18n.js` | The language of the main process: it reads the dictionaries and hands out the words. |
| `src/locales/` | The words of the interface, one file per language, for the main process and the windows alike. |
| `renderer/overlay/` | The sources of the region picker window: the frame, the size label and the selection. |
| `renderer/settings/` | The sources of the settings window and its behaviour. |
| `renderer/shared/` | What both windows share: the theme, the font and the page. |
| `src/preload-overlay.js` | The preload of the region picker. |
| `src/preload.js` | The preload of the settings window. |
| `server/index.js` | The upload receiver. `node:http` and nothing else. |
| `server/config.example.json` | The server configuration, with the values filled in. |
| `server/puuush-server.service` | The systemd unit the server runs under. |
| `test/puuush.test.js`, `test/regressions.test.js` | The tests that do not need a window. |
| `test/electron/` | The checks that need a real Electron window. |
| `assets/` | The icons and the tray images. |
| `src/renderer/` | The built windows. Not in git: `npm run build:renderer` builds them from `renderer/`. |

## The data flow

The main path, from the hotkey to the clipboard:

```
hotkey -> screen capture -> region crop -> upload -> link -> clipboard
```

The capture happens before the picker window opens, so that the window
itself is not in the picture the user picks a region from. The frame is cut
out of the original capture and not out of the picture on screen, so a
Retina display keeps its full resolution in the uploaded file.

The upload tries the configured server first. When there is none, or when
the server refuses the file, it falls back to catbox, then pomf2, then
uguu, in that order. Every candidate is tried with the same file, and the
first one that answers with a link that really resolves wins.

The link is then put in the clipboard, and the clipboard is read back to
confirm that it took. On X11 without a clipboard manager `writeText`
succeeds and the selection dies immediately, so the app would report a link
that there is nothing to paste. When the read back fails, the link is
shown in a dialog instead.

The command line path skips the picker:

```
puuush --cli file.png -> publish -> the link on standard output
```

The server side:

```
client -> POST /v1/uploads, key in the Authorization header
       -> file written into the data directory
       -> 201 with the public url
Caddy -> serves the files themselves
```

## Decisions worth knowing about

### The crop is in device pixels, not pointer pixels

`display.scaleFactor` is the wrong number on some setups, and `src/capture.js`
says so in a comment near the top. The scale is taken from the size of the
frame that really arrived, not from the size that was asked for. On Linux
with fractional scaling, on a monitor without honest HiDPI, or when the
compositor shrinks the frame, Electron returns a different number, and a
crop computed from the requested size cuts the wrong area with no visible
sign.

### The capture is taken before the picker opens

The screen is captured first, and the picker is a transparent full-screen
window that shows the picture. The other order would put the picker in the
picture, and the user would be picking a region of a picture that contains
the window they are picking in.

### The picker dims with a hole rather than with a layer

`#cut` carries `box-shadow: 0 0 0 9999px rgba(0,0,0,0.45)`, so the dimming
is a hole punched around the selection. The selected area stays clear, with
no fog over it and no second layer to repaint while the frame is dragged.

### The upload order is the fallback order

The configured server is tried first, then catbox, then pomf2, then uguu. A
candidate that answers with a broken link is not a candidate: every
candidate is checked with a real request before its link is handed over.
The hosts that were checked and left out are written down in the comment at
the top of `src/upload.js`: 0x0.st turned off uploads, and file.io answers
with a redirect instead of a link.

### The key travels in the `Authorization` header

Putting it in the URL puts it in the access log of every proxy in front of
the server, in plain text. The header is the only place it goes, on both
the client and the server.

### The server has no dependencies, and that is a rule

It runs on `node:http` because the host already has Node 22 and an update
is a file copy and a `systemctl restart`. A dependency would break the
update procedure.

### Caddy serves the files, the Node process does not

The Node process accepts uploads and keeps the ledger. Caddy already serves
everything else on that machine, and a second server in the hot path only
makes it slower.

### The settings are written atomically

`src/store.js` writes to a temporary file beside the target and renames it
over the original. `fs.writeFileSync` can stop in the middle when the disk
fills up or the power goes, and a truncated JSON file reads as the default
settings at the next start. For this app that is the worst possible
failure: a chosen "own server only" would come back as "auto", and the next
screenshot would go to a public host without a word of warning.

### A broken settings file blocks the upload

The window shows a banner with the reason and the default values, and the
upload is refused rather than silently sent to a public host. The command
line mode refuses it as well.

### The client marks its own uploads

The first bytes of the file are a random marker, and the server recognises
it. That is how the server tells its own files from a file somebody else
posted, and it is what lets the "own server only" mode work.

### File names are transliterated

Cyrillic in a name becomes Latin, and anything that does not survive the
transliteration becomes a hash tail, so that two files with the same
Cyrillic name do not collapse into one. A name that cannot be encoded
cannot be stored.

## Boundaries

- **`src/capture.js` may not know about the tray, the hotkey or the
  settings.** It captures and crops.
- **`src/upload.js` may not require Electron.** It takes a path and returns
  a url, which is what lets the command line mode reuse it.
- **`src/store.js` is the only file that knows where the settings live.**
  Everything else asks it.
- **`server/` may not take a dependency.** The whole point of the server is
  that it updates by copying one file.
- **The key never goes in a URL.**
- **The app has no main window.** A window that shows up unasked is a bug.

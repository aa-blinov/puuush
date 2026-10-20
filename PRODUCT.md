# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

The application is a desktop app (Electron 44) with a small upload server
(Node, `node:http`) that the team can run on its own machine. The interface is
a tray app and a region picker, both native windows.

## Users

The owner of the repositories, and a team that shares a chat. The situation:
a screenshot of part of the screen is needed in a conversation, and the
sequence of taking it, saving it, uploading it, copying the link and pasting
it is six steps that interrupt whatever the person was doing.

The second audience is nobody yet. The repository is private, the app is
unsigned, and there is no download count, because there is nowhere to count
it.

## Product Purpose

The app does one thing: it turns a region of the screen into a link in the
clipboard.

The shortcut is the whole product. `Ctrl+Shift+S` (or `Cmd+Shift+S`) starts
the capture, the frame is dragged, `Enter` confirms, and the clipboard holds
the link. Everything else in the app exists to make that sequence short and
to make the failure visible when it does not work.

Success for the user: the link is in the clipboard before they have thought
about where to paste it. Success for the product: the file lands on the
team's own server rather than on a public host, and the interface says which
one served the last link.

## Positioning

A neighbouring screenshot tool takes a picture and asks you to save it. This
one keeps no file, shows no window, and leaves the result where the next
action happens, in the clipboard.

The second difference is the server. The public hosts are a fallback, not the
default, and the setting that says "only my server" is honoured. A team that
cannot upload its screenshots to a public host can still use the app, and the
app tells it when it did.

The third is the crop. The frame is cut from the original screen capture
rather than from the picture on screen, so a Retina screenshot keeps its real
resolution instead of coming out half size.

## Operating Context

The app sits in the tray and runs all day. It is triggered by a global
hotkey, so the person using it is in another window, in another application,
and usually mid-sentence in a chat. The app must not steal focus, and it must
not open a window that covers what the person is doing.

The region picker is the one window that does open, and it closes to the tray
when it loses focus.

The server runs on the team's own machine, behind Caddy, and is updated by
copying one file and restarting the systemd unit. The people who operate it
are not the people who use the app.

## Capabilities and Constraints

Confirmed by the code:

- Three ways to upload: a region of the screen, an arbitrary file, and an
  image from the clipboard.
- The own server is tried first, then catbox, then pomf2, then uguu.
- A link is checked with a real request before it is copied to the clipboard.
- The crop is taken from the original capture, so a Retina display keeps its
  resolution.
- A file larger than 64 MiB is refused before it is sent.
- File names are transliterated to Latin, and a name that does not survive
  becomes a hash tail.
- Links carry 96 bits of entropy, and the client marks its own uploads so
  the server can tell them apart.
- The key travels in the `Authorization` header.
- The server has no dependencies and uses `node:http`.

Deliberately not true, and worth knowing before a change:

- The app is not signed. macOS and Windows both ask before they open it.
- There is no automatic update.
- There is no user account and no per-user namespace on the server.

## Brand Commitments

**Name:** puuush. **Tone:** plain and technical. The interface speaks in short
sentences and shows the state of the upload rather than reassuring the user.

The interface reports a failure rather than hiding it: a broken configuration
file produces a window that says so, instead of silently falling back to
defaults.

## Evidence on Hand

- `README.md` describes the flow, the fallback order and the server
  configuration.
- `docs/ui-overlay.png`, `docs/ui-settings.png` and
  `docs/ui-settings-broken.png` are the real interface.
- `src/upload.js` lists the hosts and the order they are tried in.
- `server/index.js` holds the configuration defaults and the identifier
  length.
- `test/puuush.test.js` and `test/regressions.test.js` cover the parts that
  can be tested without a window.

Absent, and not to be invented: no download counts, no usage numbers, no
testimonials, and no comparison with other screenshot tools. The app is
private and unsigned, so there is nothing to count.

## Product Principles

1. **The shortcut is the product.** Every feature that adds a step between
   the hotkey and the clipboard is a feature that has to earn its place.
2. **All paths cost the same.** A region, a file and the clipboard are three
   equal ways in, with the same guarantee and the same error messages.
3. **A failure is never silent.** A refused upload, an unreadable
   configuration and a broken link each say so in the interface, in the tray
   menu and in the status line, and not only in a log.
4. **The own server is the default.** The public hosts are the fallback, and
   the user always knows which one served the last link.

## Accessibility & Inclusion

- **The hotkey is the only required input.** The region picker needs the
  pointer to draw a frame, and everything else works from the keyboard.
- **The picker does not steal focus.** The window that is behind it keeps
  the caret, so the person can keep typing and paste when the link arrives.
- **The interface states the outcome in words.** A failed upload is a
  sentence in the status line, not only a colour on a tray icon.
- **A standard for contrast has not been set.** The window follows the system
  theme, and the text colours come from the design tokens in `DESIGN.md`.

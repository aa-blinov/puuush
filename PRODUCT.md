# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

The application is a desktop app (Electron 44) with a small upload server
(Node, `node:http`) that the team can run on its own machine. The interface is
a tray app, a region picker and a settings window. The settings window uses
Electron's native titlebar, native controls and the window title `puuush`.

## Users

The owner of the repositories, and a team that shares a chat. The situation:
a screenshot of part of the screen is needed in a conversation, and the
sequence of taking it, saving it, uploading it, copying the link and pasting
it is six steps that interrupt whatever the person was doing.

The second audience is nobody yet. The repository is private, the app is
unsigned, and there is no download count, because there is nowhere to count
it.

## Product Purpose

The app does two things: it turns a region of the screen into a link in the
clipboard, and it records the screen with sound into a link.

The shortcut is the whole product. `Ctrl+Shift+S` (or `Cmd+Shift+S`) starts
the capture, the frame is dragged, `Enter` confirms, and the clipboard holds
the link. Everything else in the app exists to make that sequence short and
to make the failure visible when it does not work.

There is a second shortcut for the same frame, `Ctrl+Alt+S` (`Cmd+Alt+S`) by
default. It uploads nothing: the picture itself goes to the clipboard, for the
places that take an image rather than a link. The two shortcuts are set
separately, and they must not be the same.

There is a third shortcut, `Ctrl+Shift+R` (`Cmd+Shift+R`), and it records the
screen instead of cutting it. The same key starts and stops the recording, so
a meeting is recorded by pressing one key twice. A recording can take the
whole display, a region chosen with the same frame as a screenshot, or every
display in one frame. Video takes the microphone, and, where the system allows
it, the system sound: on Windows the loopback device of the output is
available, and on other systems only the microphone is. The two sources end up
in one WebM file with one mixed audio track.

The format setting also offers GIF. GIF is silent by design, runs at 30 or 60
frames per second and keeps the animation readable by capping its width at
1600 pixels for 30 and 960 for 60. It does not stretch a slow frame: the next
frame gets the real elapsed delay, so the animation stays the same length as
the recording.

While the recording runs, a red frame sits around the recorded screen and a
panel with the timer, the pause button and the stop button sits at the bottom
of that screen. Neither is captured into the recording. The tray icon blinks
red for as long as the recording lasts, and a left click on it opens the menu.
The pause stops both the clock and the data, and the same recording continues
after it.

Screenshots and recordings have separate destination settings. A screenshot
can upload and return a link, or go straight to the clipboard as an image. A
recording can upload and return a link, go to the clipboard as a file, or stay
on the disk with its path shown. While an upload runs, the tray shows the busy
icon, so a long recording does not look like a frozen app.

The microphone is taken without the browser audio processing (echo
cancellation, noise suppression, automatic gain), because those flatten the
voice and cut the quiet parts. A gain setting of 100, 150 or 200 percent
covers the microphones that are simply quiet.
By default the recording takes the screen the pointer is on, not every screen:
a meeting is one window, and three monitors side by side make a frame that is
expensive to encode and hard to read. The settings can pin one specific display,
ask for a region, or record every screen into one frame when that is what is
wanted.

The region picker opens on every screen at once, and the frame is confirmed
by releasing the mouse. The region that was dragged is captured immediately:
there is no second Enter to press. Enter and the space bar stay for the
keyboard.

The gallery is opened on request from the tray or settings. It scans the
capture folder as well as upload history, so local-only recordings and files
remain visible even when they have no link. Saved images and animated GIFs
preview in their cards, and WebM/video files play there with controls. The
gallery also lets a person copy an image or file, copy or open its link, reveal
the source in the file manager, and save or move a copy. It does not open by
itself.

Success for the user: the link is in the clipboard before they have thought
about where to paste it. Success for the product: the file lands on the
team's own server rather than on a public host, and the interface says which
one served the last link.

## Positioning

A neighbouring screenshot tool takes a picture and asks you to save it. This
one keeps the capture flow out of the way and puts a link or image in the
clipboard. Local copies are optional, and the gallery makes saved results
available again when they are needed.

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

The region picker is the window that opens unasked, and it closes to the tray
when it loses focus. The settings and gallery windows open only when the
person asks for them. They use Electron's native window frame and app icon,
and both stay resizable. The top edge belongs to the window manager so the
whole strip moves the window.

The server runs on the team's own machine, behind Caddy, and is updated by
copying one file and restarting the systemd unit. The people who operate it
are not the people who use the app.

## Capabilities and Constraints

Confirmed by the code:

- Three ways to upload: a region of the screen, an arbitrary file, and an
  image from the clipboard.
- Two shortcuts for a region. One uploads and copies the link. The other
  copies the picture and uploads nothing.
- A third shortcut records the screen with the microphone and, on Windows, the
  system sound. One key starts and stops it.
- The region picker opens on every screen at once, and the frame is cut
  straight after the drag.
- Files over 8 MiB are uploaded as a stream and never held in memory: the
  recording of a meeting is hundreds of megabytes, and two copies of it in
  RAM would be a problem on any ordinary machine.
- The own server takes files over 8 MiB straight to disk, the same way.
- The recording takes one screen by default: the screen under the pointer,
  a region chosen before it starts, a specific display chosen in the settings,
  or every display side by side. The video frame is scaled to at most 2560
  pixels wide.
- A recording can be a WebM with mixed audio or a silent GIF at 30 or 60
  frames per second. GIF keeps its own frame delays, does not stretch a slow
  encoder, and is capped at 1600 pixels wide for 30 fps and 960 for 60.
- The microphone and the Windows system loopback are mixed into one audio
  track, so a player does not silently choose only one of them.
- Quitting the app while a recording is running stops it and saves the WebM
  before the process exits.
- The recording shows a frame around the recorded screen and a panel with the
  timer, pause and stop. Both windows are excluded from the capture and take
  no focus; the frame also lets the mouse through.
- Settings and gallery use Electron's native titlebar and app icon. The menu
  bar is hidden, and the system controls move, resize and close each window.
- A separate gallery window opens only when requested from the tray or
  settings; it scans the capture folder and history, previews images/GIFs,
  plays local videos inline, and acts on files and upload links.
- The tray icon blinks while a recording runs, shows work while an upload is
  in progress, and a left click on it opens the menu.
- Screenshots and recordings have separate destinations. A screenshot is a
  link or an image in the clipboard. A recording is a link, a file in the
  clipboard, or a file on the disk, without a link in the last two cases.
- The microphone is taken with echo cancellation, noise suppression and
  automatic gain all off, and can be amplified to 150 or 200 percent.
- Two uploads at once are queued rather than refused: a screenshot taken while
  the recording is uploading still gets its link.
- A shortcut needs a modifier other than Shift: `Shift+A` would take capital
  A from every application. A shortcut that cannot be taken leaves the
  previous one saved and working.
- "Start at login" (`launchAtLogin`, off by default) exists on macOS and
  Windows only; Electron cannot do it on Linux, so the checkbox is not shown.
- The own server is tried first, then the cloud hosts in the order that the
  speed test measured on this machine, and the default order otherwise
  (x0.at, uguu, pomf2, catbox, litterbox).
- The hint in the picker sits below the top of the work area, so on macOS it
  stays off the menu bar.
- A link is checked with a real request before it is copied to the clipboard.
- A local link works while the app is open: the file is already on the disk,
  and the link serves it from a small server next to the app.
- The crop is taken from the original capture, so a Retina display keeps its
  resolution.
- A screenshot or an ordinary file larger than 64 MiB is refused before it
  is sent. A screen recording has a four-gigabyte client ceiling and is sent
  as a stream; the own server applies its configured video limit.
- File names are transliterated to Latin, and a name that does not survive
  becomes a hash tail.
- Links carry 96 bits of entropy, and the client marks its own uploads so
  the server can tell them apart.
- Cloud hosts differ by region: the settings window has a speed test that
  uploads a small file to every cloud host from this machine, shows the time,
  and puts the working ones in that order for the auto mode.
- Every cloud host has its own file limit, and a file that is too big is
  skipped with the reason rather than sent to fail.
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

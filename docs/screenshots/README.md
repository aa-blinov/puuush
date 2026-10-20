# Screenshots

Three pictures of the interface, and where each one comes from.

The files themselves are one folder up, in `docs/`. The README links to them
from the top of the page, and the paths there are shorter that way. This folder holds the index.

| Picture | What it shows |
| --- | --- |
| [../ui-overlay.png](../ui-overlay.png) | The region picker. |
| [../ui-settings.png](../ui-settings.png) | The settings window. |
| [../ui-settings-broken.png](../ui-settings-broken.png) | The settings window when the configuration file could not be read. |

## The region picker

The full-screen transparent window that appears after the hotkey. The
screen underneath is dimmed, the selection frame is drawn with a 1px line
in the colour of the theme's ink, and the size of the selection is printed
above the frame, or below it when the frame is against the top of the
screen.

The pill at the top is the keyboard reference: `Enter` confirms, `Esc`
cancels, `Space` takes the whole screen, and dragging again starts a new
frame.

The picture was taken on a machine with an editor open behind it, because a
picker over an empty desktop says nothing about how the frame behaves over
a busy screen.

## The settings window

The 720 pixel window with the hotkey, the upload target, the behaviour
toggles, the upload test area and the history. Every value here is read
from `settings.json` in the application's data directory.

## The settings window with an unreadable configuration

The same window after the configuration file could not be read. The banner
at the top is the difference: it says so, gives the reason, and states that
the values on screen are the defaults. The upload is refused while the
file is broken, so that a screenshot chosen as "own server only" does not
go to a public host because the settings did not load.

## A note on the files

The pictures are referenced from the README by relative path, so they
resolve both on GitHub and in a local checkout. The house-style checker
verifies that every image reference points at a file that exists, so a
renamed picture cannot quietly break the README.

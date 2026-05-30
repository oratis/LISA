## What's new in v0.5.0 — LISA can see

LISA gets **eyes**. Hand her a screenshot and talk about it — from anywhere,
with one keystroke.

### Screenshot → talk

- **Global hotkey ⌃⌥S** (Lisa.app, system-wide): press it in *any* app, drag a
  region (the familiar macOS crosshair), and the shot lands straight in Lisa's
  composer. Type your question, send — she sees it. The Lisa window stays out
  of the way during capture and only comes forward once the shot is attached,
  so it never covers what you're trying to capture.
- **📷 button** in the chat composer for the same thing without the keyboard.
- **View ▸ Screenshot for Lisa** menu item (⌃⌥S) for discoverability.

### How it works

- A new `POST /api/vision/capture` endpoint shells out to the macOS
  `screencapture` utility (interactive crosshair or full-screen), returns the
  PNG as the exact attachment shape `/chat` already accepts — so the screenshot
  rides LISA's normal image-understanding path into the model. Escape cancels
  cleanly.
- The native global hotkey is registered via Carbon `RegisterEventHotKey`
  (dependency-free, works whether or not Lisa is frontmost), and drives the
  page's capture bridge.
- Privacy: nothing is captured or sent until you press the hotkey/button, and
  the screenshot only leaves the machine when you send the message it's
  attached to — same as any other attachment.

### Notes

- macOS will ask for **Screen Recording** permission for Lisa.app on first use
  (System Settings → Privacy & Security → Screen Recording). That's required by
  `screencapture`.
- Test suite: **170 passing** (added the capture arg-builder + platform-guard
  tests). Still zero new runtime dependencies.

### Upgrade

```sh
npm install -g @oratis/lisa            # 0.5.0
# or
brew update && brew upgrade lisa
# or grab the signed + notarized Lisa-Suite-v0.5.0.dmg below (the hotkey is
# Lisa.app-only, so the DMG is the way to get it)
```

## What's new in v0.3.0

The Mac native apps get a full pass: Lisa.app has been redesigned from
the pixel-art shell to a modern glass-morphism layout with a live
sidebar, and LisaIsland is more reliable for the small interactions
that were previously broken. Plus the first cut of native distribution
— Lisa.app + LisaIsland.app now ship as a single DMG via GitHub
Releases.

### Lisa.app — full redesign

- New layout: 280px sidebar (identity card · currently wanting ·
  Claude Code monitor · last reflection · SOUL/SKILLS/MEMORY/TOOLS ·
  session id) + chat pane with restyled bubbles and gradient SEND
  button.
- Identity card shows born date + days alive + live mood.
- Claude Code monitor card is live — sessions stream in via SSE,
  state shows as a pulsing/solid orange pip per row.
- Title bar is draggable (Swift-side DragHandleView) — the top 36pt
  acts as a window-move zone with double-click-to-zoom.
- Window defaults to 1200×800 on first launch (autosave namespace
  bumped, so prior small windows from the old shell reset cleanly).
- 📎 Attach button now actually opens a file picker. WKWebView on macOS
  doesn't ship one — we implemented `WKUIDelegate.runOpenPanelWith` to
  bridge to a sheet-style NSOpenPanel.
- ⌘V paste-to-attach: screenshots, browser image copies, etc. — the
  textarea (and a document-level fallback) detects image items in
  the clipboard and routes them through the same upload path as the
  file picker. Multiple images at once supported.
- Right-click → Inspect Element enabled on macOS 13.3+ for runtime
  debugging.

### LisaIsland — three real bugfixes

- **Open chat / Dismiss / Claude row clicks** used to silently
  collapse the pill instead of doing anything. Root cause: the
  Swift-side `sendEvent` was intercepting every mouseDown in the
  window (drag handler) and rewriting it to `pill.click()`. Fixed
  with a hit-test against the pill rect — clicks outside the pill
  pass through to the WebView normally.
- **Open chat** now launches the native Lisa.app (via bundle id
  `ai.meetlisa.app`) when installed; falls back to the browser at
  localhost:5757 if not.
- **Expanding a Claude session row** used to render a broken vertical
  stack of fragments. Root cause: the `<li>` was flex-row and the
  trail + action buttons got jammed in alongside pip/proj/time when
  the row opened. Fix: wrap the header in a `.head` div, switch the
  `<li>` to flex-column.

### Claude Code state — waiting-for-permission detection

The "Claude is asking for permission" state didn't fire in the island
pill, because Claude Code logs nothing to its jsonl when it pops a
permission prompt — the prompt lives entirely in its TUI.

- New staleness heuristic in the watcher: any "working" session whose
  jsonl hasn't grown in 5s gets promoted to "waiting/permission". This
  is the only on-disk signal that's actually available.
- A periodic 3s re-poll catches the staleness without needing an fs
  event (which is exactly what's missing during a wait).
- The island pill dot flips from pulsing → solid orange, and the
  native macOS notification fires per the existing Phase 3 flow.

### Distribution — Lisa Suite DMG

`Lisa-Suite-v0.3.0.dmg` is the new way to install. Drag both apps to
the Applications symlink, drag the result to your Mac.

Two paths in CI:
- **Signed + notarized** when the six Apple Developer ID secrets are
  present in the repo — opens cleanly with no Gatekeeper warning.
- **Ad-hoc signed** otherwise — works locally; downloaded copies need
  a one-line `xattr -d com.apple.quarantine /Applications/Lisa.app`
  to clear quarantine.

See `docs/RELEASING.md` for the full secret list + flow.

### Smaller polish

- Switched mascot to the cyan-halo "C" candidate (was the orange one
  briefly during a previous release).
- HTML chat shell extracted from `server.ts` into `src/web/lisa-html.ts`
  — server module drops from 2280 to ~680 lines, much easier to read.
- Service-worker cache namespace bumped (`lisa-v1` → `lisa-v2-redesign`)
  so the new shell takes effect on first reload after upgrade.

### Install (Mac)

```
# Option 1: from the DMG (this release)
# → download Lisa-Suite-v0.3.0.dmg, drag both apps to /Applications
# → install the backend:
npm install -g @oratis/lisa
mkdir -p ~/.lisa && echo 'ANTHROPIC_API_KEY=sk-ant-...' > ~/.lisa/config.env
lisa serve --web
# → open Lisa.app / LisaIsland.app

# Option 2: CLI only (no native apps)
npm install -g @oratis/lisa
# (same config step)
lisa serve --web    # web UI at localhost:5757
```

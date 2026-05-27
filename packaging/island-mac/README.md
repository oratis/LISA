# LisaIsland.app — native Mac shell for the island widget

Phase 2.1 of [`docs/MAC_ISLAND_PLAN.md`](../../docs/MAC_ISLAND_PLAN.md).

A native macOS app that hosts the Phase 1 web widget
(`http://localhost:5757/island`) in a borderless, transparent,
always-on-top window. No Dock icon, no menu bar app name.

## Status

| Phase | What | Status |
|---|---|---|
| 2.1 | App skeleton + WKWebView + borderless top-center window | ✅ here |
| 2.2 | NotchDetector — anchor to right of notch on MBP 14/16 | planned |
| 2.3 | LisaProbe — graceful offline overlay | planned |
| 2.4 | ScreenContextWatcher — auto-hide on fullscreen + screen capture | planned |

## Requirements

- macOS 13 or later
- Swift 5.9+ (bundled with Xcode 15 / current Command Line Tools)
- LISA running at `localhost:5757` (`lisa serve --web`)

## Build

```sh
cd packaging/island-mac
bash build.sh
```

Output: `LisaIsland.app` in this directory.

## Run

Start LISA first:

```sh
lisa serve --web
```

Then launch the app:

```sh
open LisaIsland.app
```

A small pill appears centered at the top of your main screen — same
pixel-art avatar + live mood + idle-message ★ as the web widget, just
without a browser window wrapping it.

## Install (optional)

```sh
cp -r LisaIsland.app /Applications/
```

Or drag the `.app` to `/Applications/` in Finder.

## Quit

`⌘Q` while the island is focused, or:

```sh
killall LisaIsland
```

The app intentionally has no close button — closing the only window
doesn't quit (Phase 2.3 + later need it alive to detect LISA coming
back online).

## Architecture

```
LisaIsland.app/
└── Contents/
    ├── Info.plist                       # LSUIElement: true (no Dock icon)
    ├── MacOS/
    │   └── LisaIsland                   # compiled binary
    └── Resources/
```

Source layout:

```
Sources/LisaIsland/
├── main.swift           # NSApplication boot (accessory policy)
├── AppDelegate.swift    # window + minimal ⌘Q menu
├── IslandWindow.swift   # borderless NSPanel at statusBar level
└── IslandContent.swift  # WKWebView + open_full_gui message handler
```

Communication with LISA is entirely through `http://localhost:5757`:

- `GET /island` — the widget HTML (served by `src/web/island.ts`)
- `GET /events` — SSE for live mood / chat / idle pulses
- `GET /api/island/ping` — periodic state poll
- `POST /api/island/dismiss-unread` — clear ★ flag
- `window.webkit.messageHandlers.island.postMessage({type:"open_full_gui"})`
  → app opens `http://localhost:5757/` in the default browser

The app does **not** persist anything to disk. Killing it loses nothing;
all state lives in `~/.lisa/` owned by the LISA engine.

## Distribution

This MVP is **ad-hoc signed only**. On first launch macOS Gatekeeper
will prompt; either right-click → Open, or run:

```sh
xattr -dr com.apple.quarantine LisaIsland.app
```

Apple Developer ID signing + notarization is Phase 4 of the plan.
Homebrew Cask distribution likewise lands then.

## License

MIT — same as the parent LISA repo.

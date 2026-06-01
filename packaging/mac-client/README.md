# Lisa.app — native Mac client

Dockable macOS app hosting the LISA chat GUI. The always-on-top notch pill
("Lisa Island") is built in — toggle it from **Lisa ▸ Settings… ▸ Show Lisa
Island**. (It used to be a separate `LisaIsland.app`; its window code now
lives under [`Sources/Lisa/Island/`](Sources/Lisa/Island/).)

| | Chat window | Lisa Island (built-in) |
|---|---|---|
| What it is | Active conversation window | Passive observer (small pill at the notch) |
| Window chrome | standard (titlebar, traffic lights) | borderless, always on top |
| Loads | `/` (the chat GUI) | `/island` |
| How to show | opens at launch | Settings… ▸ Show Lisa Island |

Talks only to `localhost:5757`.

## Requirements

- macOS 13 or later
- Swift 5.9+ (bundled with Xcode 15 / current Command Line Tools)
- LISA running at `localhost:5757` (`lisa serve --web`)

## Build

```sh
cd packaging/mac-client
bash build.sh
```

Output: `Lisa.app` in this directory. App icon is generated at build
time from `src/web/assets/lisa-mascot.png` via `sips` + `iconutil` —
no binary blobs committed to git.

## Run

Start LISA first:

```sh
lisa serve --web
```

Then:

```sh
open Lisa.app
```

A 1200×800 window opens with the chat GUI. Window position + size are
remembered across launches (via `NSWindow.frameAutosaveName`).

## Install

```sh
cp -r Lisa.app /Applications/
```

To launch at login: System Settings → General → Login Items → drag in
`/Applications/Lisa.app`.

## Keyboard shortcuts

| Shortcut | Action |
|---|---|
| `⌘N` | New / show window |
| `⌘W` | Close window (app stays in Dock) |
| `⌘R` | Reload chat |
| `⌘F` | Toggle fullscreen |
| `⌘M` | Minimize |
| `⌘H` | Hide |
| `⌘Q` | Quit |

## Architecture

```
Sources/Lisa/
├── main.swift          # NSApplication boot (.regular policy)
├── AppDelegate.swift   # window lifecycle + standard menu bar
├── MainWindow.swift    # NSWindow + frame autosave + WebContent VC
└── WebContent.swift    # WKWebView + auto-retry + external link handler
```

Communication with LISA is identical to LisaIsland.app — all goes
through `localhost:5757`. No state stored locally; killing the app
loses nothing.

## Distribution

Currently **ad-hoc signed only**. First launch on macOS Gatekeeper
will prompt; right-click → Open the first time, or:

```sh
xattr -dr com.apple.quarantine Lisa.app
```

Apple Developer ID signing + notarization + Homebrew Cask are Phase 4
of [`docs/MAC_ISLAND_PLAN.md`](../../docs/MAC_ISLAND_PLAN.md).

## License

MIT — same as the parent LISA repo.

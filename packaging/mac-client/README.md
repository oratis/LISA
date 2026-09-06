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

The app doesn't require you to install the backend by hand: if the `lisa` CLI
isn't there, **Lisa ▸ Set Up Backend…** walks through it (see below).

## Backend setup wizard

The download is one click, but the backend is a separate npm package — so the
app ships a guided sheet instead of assuming a terminal. Open it from
**Lisa ▸ Set Up Backend…**, from **Set Up…** in the menu-bar popover, or from
**Set up backend…** on the offline splash; it also opens on its own when a
start attempt finds no `lisa` on your PATH.

It checks Node.js and the backend on your *login* shell (`zsh -lc`, plus
explicit nvm / fnm / Volta / Homebrew / `~/.npm-global` paths — a GUI app
doesn't read `~/.zshrc`, so a Node that "works in Terminal" would otherwise be
invisible), then shows exactly one next step:

| It found | You get |
|---|---|
| No Node.js (or older than 20) | `brew install node` with a Copy button, a nodejs.org link, and **Re-check** |
| Node.js but no backend | **Install backend** — runs `npm install -g @oratis/lisa` with live output and a spinner, then starts `lisa serve --web` |
| Everything | **Start backend**, plus **Update backend** to pull the latest release |

If the global install fails, the failure is classified rather than dumped: an
`EACCES` gets the standard no-sudo fix (move npm's prefix to `~/.npm-global`,
add it to `~/.zprofile`) shown verbatim with **Apply fix and retry**; a network
failure gets a retry; an `EBADENGINE` sends you back to the Node.js step.

`~/.lisa/serve-command.txt` still overrides everything — with it in place the
wizard reports ready and never checks for the CLI, because you own that command
line.

Terminal remains a first-class path; the wizard's own footer spells it out:

```sh
npm install -g @oratis/lisa   # one-time
lisa serve --web              # start the backend
```

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
Sources/LisaSetup/
└── BackendSetup.swift  # pure setup logic: probe/install scripts, decide(), failure classes

Sources/Lisa/
├── main.swift                    # NSApplication boot (.regular policy)
├── AppDelegate.swift             # window lifecycle + standard menu bar
├── MainWindow.swift              # NSWindow + frame autosave + WebContent VC
├── WebContent.swift              # WKWebView + auto-retry + external link handler
├── BackendController.swift       # spawn/probe/restart `lisa serve --web`
├── BackendSetupController.swift  # the install wizard's AppKit sheet
└── ShellRunner.swift             # `zsh -lc` + streamed, ANSI-stripped output
```

`LisaSetup` is AppKit-free on purpose so the wizard's decisions are unit-tested:

```sh
swift test    # Tests/LisaSetupTests
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

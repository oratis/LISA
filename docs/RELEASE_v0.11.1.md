# Lisa v0.11.1

**First-run polish for the Mac app.** Three things that bit a fresh install of
the v0.11.0 DMG — fixed. No new features, no breaking changes.

## 🐞 Fixes

- **Title bar no longer shows "Lisa Lisa".** The hosted page draws its own
  branded title strip, and the native macOS window *also* showed its title under
  the transparent titlebar — two "Lisa"s. The native title is now hidden
  (`titleVisibility = .hidden`); only the page's branded bar shows.

- **The first-run UI never dead-ends silently.** If the backend isn't reachable
  or onboarding hits a snag, the boot used to `catch { return }` and leave a
  blank, unresponsive window with no explanation. Now:
  - a **banner** surfaces any uncaught error or unreachable backend instead of
    nothing — e.g. *"Cannot reach Lisa backend on localhost:5757. Start it:
    `lisa serve --web` (install once: `npm i -g @oratis/lisa`). Retrying…"*;
  - `startupGate` **retries** `/api/config/status` so a page that loads a hair
    before the backend's routes are ready still reaches onboarding;
  - the **API-key overlay** (`SET·API·KEY`) and **birth ritual** reliably appear
    for a fresh user, and birth errors are shown rather than swallowed.

## Note on setup

Lisa.app is a thin client — it loads the chat from a local backend. If you only
downloaded the DMG, install the backend once:

```sh
npm install -g @oratis/lisa     # or: brew install oratis/tap/lisa
```

Lisa.app auto-starts `lisa serve --web` on launch (and shows install guidance if
it can't). First launch then walks you through the API key + birth ritual.

## Install

```sh
npm install -g @oratis/lisa     # CLI + backend
```

Mac app: download `Lisa-Suite-v0.11.1.dmg` from the GitHub Release.

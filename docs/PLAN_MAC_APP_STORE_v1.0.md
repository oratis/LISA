# PLAN — Can Lisa.app ship on the Mac App Store? (v1.0 assessment)

**Question:** Telloria/Markup are on the App Store. Can Lisa.app go on the **Mac
App Store (MAS)** too, by reusing the same mechanism?

**TL;DR verdict:**

| Build | MAS-eligible? | Why |
| --- | --- | --- |
| **Full Lisa.app** (local agent control plane) | ❌ **No** | Its core *is* the things the App Sandbox forbids: spawn + steer your local `claude`/`codex`, a detached `lisa serve`, `~/.lisa` outside the container, git/PTY subprocesses, Sense. |
| **Thin "Lisa" client** (chat UI → a server) | ✅ **Yes** | A WKWebView that only does `network.client` — exactly Markup's sandbox profile. This is the **cloud edition** (`LISA_EDITION=cloud`) given a Mac wrapper. |

So "上线 Mac App Store" is **possible — but only for the cloud/thin flavor**, not
the full local app. The full app's correct home is **Developer ID + notarized
DMG** (off-store) — which is *also* how Markup ships its direct channel, on the
same Apple account (`wangharp@gmail.com`, team `9LH9NBX7P4`).

---

## 1. How Markup gets onto the Mac App Store (the mechanism)

Markup ships **dual-path** (`docs/app-store/MAS-publishing-plan.md`,
`scripts/build-mas.sh`):

- **MAS path** — `Entitlements.mas.plist` with `com.apple.security.app-sandbox =
  true` + a *minimal* capability set (`network.client`,
  `files.user-selected.read-write`, `files.bookmarks.app-scope`,
  `application-identifier`, `team-identifier`). Universal binary, embedded
  `embedded.provisionprofile`, signed **Apple Distribution**, packaged with
  `productbuild` into a `.pkg` signed **3rd Party Mac Developer Installer**,
  uploaded via Transporter/`altool`. **Not** notarized (App Review replaces it).
- **Direct path** — `Entitlements.plist` with hardened-runtime exceptions
  (`cs.disable-library-validation`, `cs.allow-jit`, …), signed **Developer ID
  Application**, **notarized** (`notarytool`) + stapled into a `.dmg`.

**Why Markup *can* be sandboxed:** it is a **self-contained document app**. It
spawns **no child processes**, bundles **no helper CLIs**, and needs only
network + user-picked folders. That is the entire reason it fits the sandbox.

## 2. Why the full Lisa.app cannot be sandboxed

The App Sandbox is **mandatory** for MAS. Lisa.app's whole Mac value proposition
is the opposite of self-contained — it is a **local process orchestrator**.
Capability by capability:

| Lisa Mac capability | Code | Sandbox verdict |
| --- | --- | --- |
| WKWebView chat GUI | `WebContent.swift` | ✅ fine (Markup proves it) |
| Start the backend by shelling out | `BackendController.start()` — `/bin/zsh -lc "nohup lisa serve --web … & disown"` | ❌ spawning an external, PATH-resolved (`npm`/Homebrew) binary — forbidden |
| Detached survival (`nohup … & disown`) | same | ❌ sandbox reaps child processes on app exit; outliving the app is forbidden |
| Backend writes `~/.lisa` | `NSHomeDirectory()/.lisa` | ❌ sandbox confines writes to the container (`~/Library/Containers/…`) + user-selected paths |
| Backend spawns the user's `claude`/`codex` | `dispatch_agent`, adopt-idle `claude --resume` | ❌ executing arbitrary non-bundled executables — forbidden |
| PTY agents | `node-pty` (`LISA_PTY_AGENTS=1`) | ❌ spawning shells/CLIs under a pty — forbidden |
| `git` on the soul repo | soul store subprocess | ❌ spawning `/usr/bin/git` — forbidden (needs in-process libgit2) |
| Reading `~/.claude/sessions/*` | agent control plane | ❌ another app's files outside the container — forbidden |
| Sense (screen/voice) | Sense module | ⚠️ ScreenCaptureKit needs a TCC prompt + scrutiny; reading *other apps'* windows ≈ automation/accessibility — effectively forbidden in-sandbox |
| Local server the iOS app pairs to | `serve --web` on `:5757` | ⚠️ needs `network.server`; allowed, but only meaningful if the backend runs — which it can't, here |

This is not a tuning problem you fix with a few entitlements. **Temporary-exception
entitlements** exist but (a) App Review rejects general-purpose "run other
binaries" orchestrators, and (b) they would still not grant detached survival or
free `~/` access. Developer tools that orchestrate local processes (terminals,
IDEs, Docker Desktop, most git GUIs that shell out) are essentially **never** on
the MAS for exactly this reason — they ship Developer ID + notarized.

**Lisa.app is already on the right track for off-store:** its current
`Resources/Entitlements.plist` is a *hardened-runtime* profile (no `app-sandbox`
key), and `build.sh:120` notes "Proper signing (Developer ID + notarization) is
Phase 4." That Phase 4 — not MAS — is the home for the full app.

## 3. The two real options

### Option A — Full Lisa.app via Developer ID + notarized DMG (NOT the store)
Keep every local-agent power; distribute off-store. This is **Markup's own direct
path**, reusable almost verbatim:
- `codesign --options runtime --entitlements Resources/Entitlements.plist --sign
  "Developer ID Application: … (9LH9NBX7P4)"` (the entitlements file already
  exists and is correct).
- `xcrun notarytool submit --wait` (reuse the `AC_PASSWORD` keychain profile /
  ASC API key already set up for the iOS TestFlight flow) → `xcrun stapler
  staple` → `.dmg`.
- Gatekeeper-clean, double-click installable, auto-updates via the existing
  `Updater.swift` (GitHub Releases). **"Not on the store" ≠ "not shippable."**

### Option B — A sandboxed "Lisa" MAS client = the cloud edition with a Mac shell
A second, *different* product: a WKWebView that connects to a **server** instead
of running one. The server is either **LISA Cloud** (what we just scaffolded in
`docs/PLAN_CLOUD_v1.0.md`) or a `lisa serve` the user started themselves. It does
nothing the sandbox forbids — `network.client` only — so it drops straight into
**Markup's MAS pipeline**. Reuse:
- `LISA_EDITION=cloud` (`src/edition.ts`) — already hides the Mac-only
  capabilities; the MAS client surfaces only chat + companion + cloud agents.
- A `packaging/mac-mas-client/Entitlements.mas.plist` mirroring Markup's
  (`app-sandbox`, `network.client`, `application-identifier 9LH9NBX7P4.ai.meetlisa.app`,
  `team-identifier 9LH9NBX7P4`; add `files.user-selected.read-write` only if we
  let users attach files).
- Markup's `build-mas.sh` shape: universal build → embed provisioning profile →
  `codesign` (Apple Distribution) → `productbuild` (.pkg, 3rd Party Mac Developer
  Installer) → Transporter. Same team, same ASC account.

The catch: a thin client is only useful with a backend to talk to, so **Option B
depends on LISA Cloud reaching at least C2** (per-user persistence) — otherwise
"Lisa for Mac" in the store is a chat window pointed at a demo soul that resets.

### Rejected — sandbox the full app with temporary-exception entitlements
Not worth it: App Review rejects local-orchestrator apps, and the exceptions
still wouldn't grant detached survival or `~/.lisa`. It would also fork the whole
backend's process model for a build Apple is likely to reject anyway.

## 4. Recommendation

**Mirror Markup's dual-path — but split by *edition*, not by feature-flag**, since
for Lisa the delta is the entire process core, not a banner:

1. **Now / unblocks real Mac distribution: Option A.** Finish the full app's
   Developer ID + notarization (build.sh "Phase 4"), ship a notarized `.dmg`.
   This is the honest answer to "can people install Lisa on a Mac without the
   terminal?" and it needs no Apple *review*, only notarization (automated).
2. **Later, after Cloud C2: Option B.** A sandboxed cloud-client "Lisa" on the
   Mac App Store, reusing the cloud edition + Markup's MAS scripts. This is the
   "discoverable in the store, no-Mac-power-needed" on-ramp — the Mac sibling of
   the iOS app, and it shares the App Review demo story with the iOS submission.

So: **yes, Lisa can be on the Mac App Store — as the cloud client.** The full
local app stays a notarized DMG, by design and in good company.

## 5. Open questions for review

1. **Bundle id collision** — if a user could have *both* the MAS cloud-client and
   the DMG full app, they need distinct ids. Note the current allocation: the
   **full Mac app already uses `ai.meetlisa.app`** (`packaging/mac-client/Resources/Info.plist`),
   and **iOS standardized on `ai.meetlisa.main`** (the app group, widgets, and
   `PRODUCT_BUNDLE_IDENTIFIER`, aligned to the ASC app record). So `ai.meetlisa.app`
   is *not* free to hand a new MAS client — either the MAS cloud client takes a new
   id (e.g. `ai.meetlisa.cloud`) and the full app keeps `ai.meetlisa.app`, or the
   full app migrates (e.g. to `ai.meetlisa.studio`) and the cloud client inherits
   `ai.meetlisa.app`. Given iOS is `…main`, also decide whether the family's
   canonical root should be `.main` rather than `.app`.
2. **Sequencing** — ship the notarized DMG (Option A) for v1.0 and defer the MAS
   client (Option B) until Cloud C2 lands? (Recommended.)
3. **Naming in the store** — "Lisa" (cloud client) vs "Lisa Studio" (full DMG), to
   set the right expectation about which one runs local agents.
4. **Is off-store acceptable for the flagship?** If being *in the Mac App Store*
   is a hard product requirement for the full app, the answer is still no — the
   orchestrator core can't be sandboxed; we'd have to redefine the Mac product.

---

*Mechanism reference: `~/Documents/Claude/Markup` —
`src-tauri/Entitlements.mas.plist`, `scripts/build-mas.sh`,
`scripts/sign-and-notarize.sh`, `docs/app-store/MAS-publishing-plan.md`. Same
Apple account + team `9LH9NBX7P4` as Lisa's iOS submission.*

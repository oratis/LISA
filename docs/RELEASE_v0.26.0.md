# Lisa v0.26.0

**Lisa.app now brings its own backend.** Downloading the DMG used to get you an
app that couldn't do anything: it looked for `lisa serve --web` on the login
shell's PATH, so you had to install Node and `npm i -g @oratis/lisa` first — the
disk image's own README said so. The app now carries a full backend and its own
Node runtime, and starts them the first time you open it. Alongside that: the
In-App Purchases App Review couldn't find are reachable again, and the
"backend offline" banner stopped covering the window it was describing.

## 🖥 A DMG that works on a Mac with nothing installed

`packaging/mac-client/embed-runtime.sh` stages the runtime into the bundle at
build time — `Contents/Resources/backend/{dist,node_modules,package.json}` plus
`Contents/Resources/node-runtime/bin/node`. Verified the way it matters, with
`env -i HOME=<empty> PATH=/usr/bin:/bin`: the embedded Node runs the embedded
backend and answers HTTP 200.

Packaging decisions worth knowing:

- **`--omit=optional`** drops node-pty, the only native module in the tree, so
  the embedded backend stays pure JS — bound to no Node ABI and needing no
  `disable-library-validation` under the hardened runtime. PTY agents degrade to
  the 503 they already returned without node-pty.
- The Node binary is **checksum-pinned in the repo**, not just against the
  `SHASUMS256.txt` fetched beside it: that file comes from the same host over
  the same connection as the tarball, so it cannot vouch for it. The pin caught a
  truncated download during testing and refused to embed it.
- It is `strip -x`'d (22MB per arch), lipo'd universal, and **re-signed** —
  lipo drops nodejs.org's signature and arm64 refuses an unsigned Mach-O.
- Start order is `serve-command.txt` → embedded → `lisa` on PATH. **The override
  still wins**: someone who wrote that file wants their own tree to run, and
  silently substituting the bundled copy would make their edits vanish.

Autostart also stopped looking broken. It always ran; the problem was that a
backend which died instantly left the app silent for 20 seconds and then said
`timeout`. `BackendController` now reads the backend's own fatal line out of
`~/.lisa/backend.log` and names which start path produced it.

App 339MB, DMG 156MB. `LISA_EMBED_ARCHS=arm64` saves ~90MB;
`LISA_SKIP_EMBED=1` skips the embed for Swift-only iteration.

## 💳 The In-App Purchases are findable again

App Review rejected Lisa Pocket 1.1 under Guideline 2.1(b) — "we cannot locate
the In-App Purchases". It was our own conditional UI: the only route to the
credit packs sat inside `if let q = quota, q.available, window > 0`, so a
`/api/billing/quota` that timed out, 401'd or 503'd left the app with **no** way
to reach them at all.

- "Add credits…" now renders for any signed-in account; the quota fetch only
  decides whether the allowance rows appear above it.
- A turn refused for lack of credits (402) offers the packs **in the chat
  bubble**, a second route that needs no Settings trip.
- An empty StoreKit response is treated as a **failure**, not a loaded empty
  list. StoreKit answers with an empty array rather than an error when products
  aren't available yet, and a sheet spinning on "Loading packs…" forever is
  exactly what an unreachable IAP looks like from the outside.

Server-side, App Review buys in Apple's sandbox while the cloud edition rejects
every non-Production JWS (anti-minting). Named review accounts are now
allowlisted — and those sandbox credits are marked in the ledger and capped, so
a credential that by design gets typed into App Store Connect cannot mint
without limit.

## 🔔 The offline banner became a bottom toast

The safety-net banner was a wide slab pinned at `top: 12px`, styled from an
inline string. In the Mac client it landed squarely on the window's title bar and
the whole top function bar — the first thing you saw when the backend was down
was a message covering the UI it was describing.

It is now a compact bottom-anchored toast that draws from the theme tokens and
tracks Nebula ↔ Calm, rides above the composer (re-measured per call, so a
textarea that grew while you typed can't cover it), and carries an optional
copy-on-click command chip. The first two startup retries say "Waking Lisa up…"
in a calm tone — the desktop app is normally still starting the backend, and a
red error at t+4s is a lie — before escalating.

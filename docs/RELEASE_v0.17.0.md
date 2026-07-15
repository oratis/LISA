# Lisa v0.17.0

The **"legible and connected"** release. v0.16 gave Lisa a life inside her Room;
v0.17 makes the parts you actually read and touch every day behave: her replies
render as real **Markdown** instead of raw `###`/`**`/```` ``` ````, connecting a
**mailbox** is a guided, verified flow instead of a bare form, and — the big one
— **web conversations finally evolve her desires** (they never did before). Plus
the `lisa mail` CLI works again, and she stands centered on the rug.

Typecheck green · full test suite green (**984 tests**, snapshot refreshed) · no
breaking changes.

## ✨ What's new since v0.16.0

### Web — Lisa's Markdown renders as styled HTML (#238)

Lisa emits standard Markdown, but the web client dropped her replies in via
`textContent`, so every `###` / `**` / `-` / ```` ``` ```` / table showed up as a
literal symbol. A new source-injected `renderMarkdown()` (`src/web/md-render.ts`)
now renders headings, bold/italic, inline + fenced code (with a language label +
copy button), nested lists, blockquotes, rules, tables, and links restricted to
`http`/`https`/`mailto`. It's wired into every surface that shows her prose — the
streaming chat bubble (re-rendered once per animation frame), history bubbles, and
the idle **★** reflection cards on the Room and Island.

**Escape-first by design:** her output is model-generated and untrusted, so every
text run is HTML-escaped *before* any tag is introduced — no `javascript:`/`data:`
hrefs, no attribute breakout, no raw-HTML passthrough (19+ unit tests cover the
XSS and link-scheme surface).

### Mail — guided connect modal + verify-before-save (#234)

Connecting a mailbox used to drop you in front of a bare Email / App-password /
IMAP-host form with no hint what an "app password" is, and the web endpoint stored
whatever you typed **without checking it** — so a wrong password produced a
silently empty digest. Now both ends explain themselves:

- A provider picker (**Gmail / iCloud / QQ / 163 / Outlook / Other**) with
  per-provider numbered setup steps and a prominent **"Open App Passwords ↗"**
  link; labels, placeholders, and IMAP host adapt to the provider, and typing an
  address auto-detects it from the domain.
- The backend `probeAccount()` does a single-message fetch to confirm the
  credentials actually sign in, and `POST /api/mail/connect` **verifies before
  storing** — returning a plain-language hint ("Gmail rejected the sign-in. Use a
  16-character app password…") instead of persisting an unusable mailbox.

Still read-only, still IMAP + app-password.

## 🔧 Fixes

- **`lisa mail connect` works again (#233).** `mail` was missing from the CLI's
  raw-subcommand set, so `--email` / `--pass` / `--client-id` were rejected as
  "unknown flag" and `--provider` / `--host` / `--port` were silently swallowed as
  global flags — the whole `lisa mail connect` command was unusable in 0.16.0.
  Its trailing flags now reach the handler verbatim, while `autostart` /
  `heartbeat` keep parsing their own recognized global flags.
- **Web conversations now evolve Lisa's desires (#242).** `reflectOnSession` — the
  only automatic way a conversation turns into or updates a desire — was wired to
  the CLI and channel router only; the web `POST /reflect` endpoint existed but no
  client ever called it, so *web chats never touched her desires at all.* A
  debounced reflection scheduler now reflects once after a quiet stretch with new
  user input (default 5 min), independent of the hour-long "dream" idle.
- **Lisa stands centered on the rug (#228).** Re-anchored `#lisa-wrap` so she's
  centered and grounded on the rug in both room themes, in every pose.

## 🛡️ Review hardening

Every PR in this release was reviewed before merge; three latent defects were
caught and fixed as part of it:

- **Markdown renderer infinite loop (#238).** The fenced-code opener was stricter
  than the fence detector, so an ordinary ```` ```c# ```` / ```` ```c++ ````
  / ```` ```objective-c ```` block wedged the render loop forever and froze the
  tab mid-stream. The opener now accepts any info string (first token = lang), with
  a regression test and a forward-progress guard.
- **IMAP session leak (#234).** `probeAccount` closed the connector when the 20s
  timeout won the race — while the connection was still opening, so the close was a
  no-op and the later-succeeding session leaked. Cleanup now chains onto the probe
  actually settling.
- **CLI flag regression (#233).** The first cut of the mail fix also swallowed
  `autostart install --port/--channels/--imessage` and `heartbeat run --model`;
  the two behaviors are now split so both work.

## 📝 Notes

- No breaking changes; soul / mood / heartbeat / Reve are untouched.
- The web Markdown renderer is the same function in the browser and the unit
  tests (source-injected via `.toString()`), so what's tested is what ships.

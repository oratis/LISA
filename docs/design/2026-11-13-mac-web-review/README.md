# Mac and Web design review — mockups

Evidence and proposals for [REVIEW_DESIGN_MAC_WEB_v0.31.0.md](../../REVIEW_DESIGN_MAC_WEB_v0.31.0.md).
**Nothing here is shipped.** The proposals are waiting for confirmation, and the
prototype files are not loaded by the app.

| Folder | Contents |
| --- | --- |
| [`current/`](current/) | The shell as served by `ae84d9a7` (v0.31.0): chat in both themes, the wide three-column layout, Dashboard, Rêve, Room, Settings, the key gate, the cloud sign-in card, and the phone, short-window and Mac-minimum-window layouts. |
| [`mockups/`](mockups/) | One before/after pair per proposal. |
| [`prototype/`](prototype/) | The proposals as code: `proposed.css`, `proposed.js`, `proposed-fleet.css`, the capture script, and the Mac account-window sketch. |

## How the mockups were made

Each "before" is a screenshot of the real shell. Each "after" is the same page,
same data, with `proposed.css` and `proposed.js` injected through the debugger.
The prototype only reads tokens that already exist in
`src/web/assets/client/main.css`; it adds no colour.

Both instances were throwaway: their own `LISA_HOME`, a placeholder key, and
`ANTHROPIC_BASE_URL` pointed at a local stub, the same arrangement as
`tests/e2e/helpers/lisa-server.ts`. No model was called and `~/.lisa` was not
read. The chat turns, soul and memory in the screenshots are synthetic.

## Index

| Mockup | Finding | Shows |
| --- | --- | --- |
| `m01-sidebar-*` | D-1 | The sidebar at 1200×800 and 900×640. The session tree grows from 193px to 396px, and from 33px to 325px. |
| `m02-control` | D-2, D-11 | Control carries the Remote Macs entry and a proper empty state. |
| `m03-fleet-*` | D-2 | The Remote Macs page restyled with the shell's tokens, in Nebula and Calm. |
| `m04-kb` | D-3, D-11 | The link bar aligned to the page grid; an empty state without the stray divider. |
| `m05-buttons-*` | D-6 | The rail action and the delegate dialog with one button system. |
| `m06-settings`, `m06-sense` | D-7 | One switch, one select style, section labels outside the card. |
| `m07-plus-menu`, `m07-memory` | D-8 | Line icons instead of emoji and Unicode glyphs. |
| `m08-mail` | D-11 | The Mail empty state. |
| `m09-birth` | D-12 | The finished ritual at 1200×800. Before: the closing line and ENTER sit below the viewport. After: the step list scrolls and both stay in view, with an opaque backdrop and a plain-language seed line. |
| `m10-chat-rail-open` | D-4, D-5, D-15 | A placeholder that fits, grouped function-bar icons, and a rail toggle that lights when the rail is open. |
| `m11-login` | D-14 | The cloud sign-in card with Lisa on it. |
| `m12-mac-account-accent` | D-18 | The Mac account window's hard-coded accent beside the shell accents. |

## Limits

- `m12` is a redraw from the sizes in `CloudComponents.swift` and
  `AccountWindow.swift`, not a screenshot. The native client does not build
  without Xcode, so no native window was captured.
- Screenshots come from Chromium, not WKWebView. Font rendering differs
  slightly; layout does not.
- The Remote Macs "after" translates the page's strings to English to match
  the shell. The strings are placeholders for the mockup, not final copy.

## Regenerating

Start two instances from the repo root after `npm run build`: one with a born
soul and a few chat turns, one with no soul and no key. Then:

```sh
BASE=http://127.0.0.1:5868 FRESH=http://127.0.0.1:5869 \
  node docs/design/2026-11-13-mac-web-review/prototype/capture.mjs
```

Pass mockup names as arguments to regenerate a subset. `m09-birth` consumes the
fresh instance, because the ritual completes. `m11-login` needs `LOGIN_HTML` set
to a file holding the `LOGIN_HTML` export of `src/web/login.ts`.

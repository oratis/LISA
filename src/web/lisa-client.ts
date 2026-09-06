/**
 * Inline client <script> for the Lisa chat shell (MAIN_HTML).
 *
 * The full browser-side runtime — attachments, vision capture, voice
 * dictation, SSE, the key gate, the birth ritual, history infinite-scroll,
 * modal panels, send + streaming, the sidebar wiring, the ⌘K switcher — lives
 * at `assets/client/main.js`, a real .js file.
 *
 * It used to be a ~4000-line template literal in this module. That cost was
 * not theoretical: every backslash in a regex had to be doubled, a backtick in
 * a comment silently ended the literal (it happened twice while this file was
 * being edited), and no editor could parse any of it. `npm run typecheck:client`
 * now type-checks the real file against a DOM lib.
 *
 * It is read once at module load and inlined by lisa-html.ts exactly as
 * before — single-file HTML delivery is a product promise, so this is a
 * build-time source split, NOT a runtime one. The path resolves from
 * import.meta.url so it works under tsx and from the compiled build alike.
 */

import { readFileSync } from "node:fs";

export const MAIN_CLIENT_JS = readFileSync(
  new URL("./assets/client/main.js", import.meta.url),
  "utf8",
);

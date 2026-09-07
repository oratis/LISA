/**
 * Inline <style> CSS for the Lisa chat shell (MAIN_HTML).
 *
 * The stylesheet itself lives at `assets/client/main.css` — a real .css file
 * that an editor can lint, fold and colour. It used to be a ~3000-line
 * template literal in this module, which meant no syntax highlighting, no
 * bracket matching, and a stray backtick anywhere in a comment broke the
 * build.
 *
 * It is read once at module load and inlined by lisa-html.ts exactly as
 * before: single-file HTML delivery is a product promise (one GET, no
 * secondary requests, works from a file:// copy), so this is a build-time
 * source split, NOT a runtime one.
 *
 * The path resolves from import.meta.url, so it works both under tsx
 * (src/web/…) and from the compiled build (dist/web/… where `assets` is a
 * symlink to src/web/assets in development and a real copy in the published
 * package — see the copy-assets / prepublishOnly scripts).
 */

import { readFileSync } from "node:fs";

export const MAIN_CSS = readFileSync(
  new URL("./assets/client/main.css", import.meta.url),
  "utf8",
);

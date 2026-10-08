import { readFileSync } from "node:fs";

/** Versioned artwork manifest is shared by Web, Island, gallery and iOS. */
export const SOFT_INK_MANIFEST = JSON.parse(
  readFileSync(new URL("./assets/visuals/soft-ink-v1/manifest.json", import.meta.url), "utf8"),
);
export const SOFT_INK_JS =
  "window.LISA_ART = " +
  JSON.stringify(SOFT_INK_MANIFEST) +
  ";\n" +
  readFileSync(new URL("./assets/client/soft-ink.js", import.meta.url), "utf8");

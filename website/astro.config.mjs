// @ts-check
import { defineConfig } from "astro/config";

// Lisa's official website. Static, bilingual, no client JS by default.
//
// Local-only dev for now (Q2 of PRODUCTIZATION_PLAN — Cloudflare Pages
// deferred). Run: cd website && npm install && npm run dev
//
// i18n: English at /, Chinese at /zh-CN/.
export default defineConfig({
  site: "https://meetlisa.dev",
  i18n: {
    defaultLocale: "en",
    locales: ["en", "zh-CN"],
    routing: { prefixDefaultLocale: false },
  },
  // Symlink the project's existing 114 mood portraits + the mascot etc. into
  // /public/assets so they're served as static files. The symlink is created
  // by `npm run prebuild` (see package.json scripts).
});

/*
 * Regenerates the before/after mockups in ../mockups.
 *
 * Run from the repo root against two throwaway instances (never your real
 * ~/.lisa): BASE has a born soul and a few chat turns, FRESH has neither soul
 * nor key and points at a stub model, so the birth ritual can run offline.
 *
 *   BASE=http://127.0.0.1:5868 FRESH=http://127.0.0.1:5869 \
 *     node docs/design/2026-11-13-mac-web-review/prototype/capture.mjs [name…]
 *
 * "before" is the shell exactly as served. "after" is the same page with
 * proposed.css + proposed.js injected — a prototype of the proposal, not a
 * build of it.
 */
import { createRequire } from "node:module";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const require = createRequire(path.join(process.cwd(), "package.json"));
const { chromium } = require("playwright");
const sharp = require("sharp");

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, "..", "mockups");
const BASE = process.env.BASE || "http://127.0.0.1:5868";
const FRESH = process.env.FRESH || "http://127.0.0.1:5869";
const LOGIN = process.env.LOGIN_HTML || "";
const only = process.argv.slice(2);
const CSS = await fs.readFile(path.join(HERE, "proposed.css"), "utf8");
const JS = await fs.readFile(path.join(HERE, "proposed.js"), "utf8");
const FLEET_CSS = await fs.readFile(path.join(HERE, "proposed-fleet.css"), "utf8");

await fs.mkdir(OUT, { recursive: true });
const browser = await chromium.launch(
  process.env.CHROME_EXE ? { executablePath: process.env.CHROME_EXE } : {},
);

async function open({ w = 1200, h = 800, theme = "nebula", rail = "", url = BASE }) {
  const ctx = await browser.newContext({
    viewport: { width: w, height: h },
    deviceScaleFactor: 2,
    colorScheme: theme === "calm" ? "light" : "dark",
    reducedMotion: "reduce",
    // /fleet serves a strict style-src; the prototype stylesheet is inline.
    bypassCSP: true,
  });
  await ctx.addInitScript(
    ([t, r]) => {
      try {
        localStorage.setItem("lisa-theme", t);
        if (r) localStorage.setItem("lisaRightbar", r);
      } catch {}
    },
    [theme, rail],
  );
  const page = await ctx.newPage();
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1500);
  return { ctx, page };
}

async function save(page, name, clip) {
  const raw = await page.screenshot(clip ? { clip } : {});
  // Full windows at 1x keep the folder small; crops stay at 1.5x so text is legible.
  const width = clip ? Math.round(clip.width * 1.5) : page.viewportSize().width;
  await sharp(raw)
    .resize({ width })
    .png({ palette: true, quality: 85, effort: 8 })
    .toFile(path.join(OUT, name + ".png"));
  console.log("wrote", name);
}

async function inject(page) {
  // The shell's CSP forbids inline <script>; evaluate() goes through the
  // debugger instead, which is the right channel for a prototype anyway.
  await page.addStyleTag({ content: CSS });
  await page.evaluate(JS);
}

/** One before/after pair on the shell. */
async function pair(name, opts, setup, apply) {
  if (only.length && !only.includes(name)) return;
  const { ctx, page } = await open(opts);
  if (setup) await setup(page);
  await page.waitForTimeout(opts.settle ?? 700);
  await save(page, name + "-before", opts.clip);
  await inject(page);
  await apply(page);
  await page.waitForTimeout(500);
  await save(page, name + "-after", opts.clip);
  await ctx.close();
}

const view =
  (name, wait = 1100) =>
  async (page) => {
    await page.evaluate((n) => window.lisaShowView(n), name);
    await page.waitForTimeout(wait);
  };
const run =
  (...names) =>
  (page) =>
    page.evaluate((ns) => ns.forEach((n) => window.LisaProposals[n]()), names);

// D-1 — sidebar at the Mac default size and in a short window.
await pair(
  "m01-sidebar-1200x800",
  { clip: { x: 0, y: 0, width: 600, height: 800 } },
  null,
  run("sidebar"),
);
await pair(
  "m01-sidebar-900x640",
  { w: 900, h: 640, clip: { x: 0, y: 0, width: 600, height: 640 } },
  null,
  run("sidebar"),
);

// D-2 + D-11 — Control carries the Remote Macs entry and a real empty state.
await pair("m02-control", {}, view("control"), run("sidebar", "controlHeader", "emptyControl"));

// D-2 — the Remote Macs page itself, both themes.
for (const theme of ["nebula", "calm"]) {
  const name = "m03-fleet-" + theme;
  if (only.length && !only.includes(name)) continue;
  const { ctx, page } = await open({ theme, url: BASE + "/fleet" });
  await save(page, name + "-before");
  await page.evaluate(
    ([css, t]) => {
      document.querySelectorAll('link[rel="stylesheet"]').forEach((l) => l.remove());
      const s = document.createElement("style");
      s.textContent = css;
      document.head.appendChild(s);
      if (t === "calm") document.body.dataset.theme = "calm";
      // The page follows the shell's language instead of being Chinese-only.
      const set = (sel, text) => {
        const el = document.querySelector(sel);
        if (el) el.textContent = text;
      };
      set("header a", "← Lisa");
      set("h1", "Remote Macs");
      set("section h2", "My machines");
      set("#refresh", "Refresh");
      set("#notice", "Sign in to Lisa on this Mac first.");
      document.querySelector("#hosts")?.setAttribute("data-empty", "No machines yet.");
      const sum = document.querySelector("#local summary");
      if (sum) sum.innerHTML = "Use this Mac as a host <small>Not set up</small>";
    },
    [FLEET_CSS, theme],
  );
  await page.waitForTimeout(400);
  await save(page, name + "-after");
  await ctx.close();
}

// D-3 + D-11 — knowledge base alignment and empty state.
await pair("m04-kb", {}, view("kb"), run("kb", "emptyKb"));

// D-6 — buttons: the rail action and the delegate dialog.
await pair(
  "m05-buttons-rail",
  { w: 1440, h: 900, rail: "open", clip: { x: 1120, y: 36, width: 320, height: 500 } },
  null,
  run("buttons"),
);
await pair(
  "m05-buttons-dialog",
  { clip: { x: 220, y: 180, width: 760, height: 440 } },
  async (page) => {
    await page.evaluate(() => window.lisaOpenDelegate && window.lisaOpenDelegate());
  },
  run("buttons"),
);

// D-7 — controls: Settings (light theme) and Sense consent.
await pair("m06-settings", { theme: "calm" }, view("settings", 1500), run("settingsControls"));
await pair(
  "m06-sense",
  { clip: { x: 272, y: 290, width: 928, height: 420 } },
  view("sense"),
  run("senseControls"),
);

// D-8 — icons: composer menu and Memory rows.
await pair(
  "m07-plus-menu",
  { clip: { x: 272, y: 560, width: 460, height: 240 } },
  async (page) => {
    await page.locator("#plusBtn").click();
  },
  run("plusIcons"),
);
await pair(
  "m07-memory",
  { clip: { x: 272, y: 36, width: 928, height: 400 } },
  view("memory"),
  run("memoryIcons"),
);

// D-11 — Mail empty state.
await pair("m08-mail", {}, view("mail"), run("emptyMail"));

// D-4 / D-5 / D-15 — composer hint and function-bar groups with the rail open.
await pair("m10-chat-rail-open", { rail: "open" }, null, run("composer", "fnbar", "buttons"));

// D-12 — birth ritual. Consumes the FRESH instance (it is born afterwards).
if (!only.length || only.includes("m09-birth")) {
  const { ctx, page } = await open({ url: FRESH });
  const gate = page.locator("#cfgKey");
  if (await gate.isVisible().catch(() => false)) {
    await gate.fill("sk-ant-api03-" + "a".repeat(60));
    await page.locator("#cfgSave").click();
    await page.waitForTimeout(14000);
    await save(page, "m09-birth-before");
    await inject(page);
    await page.evaluate(() => window.LisaProposals.birth());
    await page.waitForTimeout(400);
    await save(page, "m09-birth-after");
  } else {
    console.log("m09-birth skipped: FRESH instance is already born");
  }
  await ctx.close();
}

// D-14 — cloud sign-in card (static render of LOGIN_HTML).
if (LOGIN && (!only.length || only.includes("m11-login"))) {
  const { ctx, page } = await open({ url: "file://" + LOGIN });
  const clip = { x: 300, y: 100, width: 600, height: 600 };
  await save(page, "m11-login-before", clip);
  // Inlined: the shell's assets are same-origin only, and this page is file://.
  const avatar =
    "data:image/png;base64," +
    (await fs.readFile(path.join(process.cwd(), "src/web/assets/icon-192.png"))).toString("base64");
  await page.evaluate((src) => {
    const card = document.querySelector(".card");
    const img = document.createElement("img");
    img.src = src;
    img.alt = "";
    img.style.cssText =
      "width:56px;height:56px;border-radius:50%;display:block;margin:0 0 14px;object-fit:cover;object-position:50% 22%";
    card.prepend(img);
    card.querySelector("h1").textContent = "Welcome back";
  }, avatar);
  await page.waitForTimeout(600);
  await save(page, "m11-login-after", clip);
  await ctx.close();
}

await browser.close();

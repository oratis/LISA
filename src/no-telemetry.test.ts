/**
 * "No telemetry" is a published promise, not just a design preference:
 *
 *   website/src/pages/index.astro    "No cloud sync, no telemetry, no account of any kind."
 *   website/src/pages/privacy.astro  "…collect no analytics, no advertising identifiers,
 *                                     and contain no third-party tracking SDKs."
 *   website/src/pages/cloud.astro    "…no training on your data, no analytics SDKs."
 *
 * plus the Chinese mirrors of all three. Today those statements are true — there
 * is no analytics SDK, no tracking pixel, and no phone-home anywhere in the
 * tree. Nothing enforced it, so one `npm install` of a convenience wrapper, or
 * one copy-pasted snippet in a layout, would quietly turn a published privacy
 * claim into a false statement.
 *
 * This is that enforcement. It runs in the normal suite, so it gates every PR
 * through .github/workflows/ci.yml and blocks `prepublishOnly` too.
 *
 * If this test fails, the choice is: remove the tracker, or change the promise
 * on the website. Do not add an exemption without doing one of those.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Trackers, written in their SDK-shaped forms.
 *
 * Deliberately NOT bare English words: "segment", "heap" and "plausible" all
 * occur in ordinary prose and identifiers in this repo (13, 35 and 2 files
 * respectively at the time of writing), and "amplitude" is an audio term. A
 * deny-list that cries wolf gets deleted, so each entry here is a token that
 * only appears when an actual SDK or endpoint is present.
 */
const TRACKER_TOKENS = [
  "google-analytics.com",
  "googletagmanager",
  "gtag(",
  "ga('create'",
  "cdn.segment.com",
  "segment.io/v1",
  "analytics.load(",
  "mixpanel",
  "@amplitude",
  "amplitude-js",
  "posthog",
  "@sentry/",
  "sentry-cli",
  "plausible.io",
  "umami.js",
  "usefathom.com",
  "matomo",
  "hotjar",
  "statsig",
  "bugsnag",
  "firebase/analytics",
  "FirebaseAnalytics",
  "Crashlytics",
  "appsflyer",
  "onesignal",
  "logrocket",
  "heap.io",
  "clarity.ms",
  "braze.com",
  "datadoghq",
  "newrelic",
];

/** Directories whose contents ship to a user, in one form or another. */
const SCAN_ROOTS = ["src", "website/src", "packaging/ios-companion/Sources"];

/**
 * The pages that carry the promises, listed by path on purpose.
 *
 * Hard-coding them (rather than grepping for English phrases like "no
 * telemetry") is what keeps the Chinese pages covered: zh-CN/index.astro says
 * "无云同步、无遥测、无任何账号" and zh-CN/cloud.astro says "没有分析 SDK", which
 * no English keyword search would ever find. It also means renaming or deleting
 * a promise page breaks this test loudly instead of silently shrinking what is
 * being guarded.
 */
const PROMISE_PAGES = [
  "website/src/pages/index.astro",
  "website/src/pages/privacy.astro",
  "website/src/pages/cloud.astro",
  "website/src/pages/zh-CN/index.astro",
  "website/src/pages/zh-CN/privacy.astro",
  "website/src/pages/zh-CN/cloud.astro",
];

const SKIP_DIRS = new Set(["node_modules", "dist", ".git", "assets"]);

function walk(dir: string, out: string[] = []): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      walk(full, out);
    } else if (e.isFile()) {
      // This file names every tracker it bans, and the other test files are
      // not shipped behaviour.
      if (e.name.endsWith(".test.ts")) continue;
      out.push(full);
    }
  }
  return out;
}

/** Every tracker token present in `text`, matched case-insensitively. */
function trackersIn(text: string): string[] {
  const hay = text.toLowerCase();
  return TRACKER_TOKENS.filter((t) => hay.includes(t.toLowerCase()));
}

describe("no telemetry — the promise on the website stays true", () => {
  test("the deny-list actually matches a real SDK (guard is not vacuous)", () => {
    // If this ever passes with an empty result, every other test here is
    // meaningless.
    assert.deepEqual(trackersIn('import posthog from "posthog-js";'), ["posthog"]);
    assert.deepEqual(trackersIn('<script src="https://www.googletagmanager.com/gtm.js">'), [
      "googletagmanager",
    ]);
    assert.deepEqual(trackersIn("import * as Sentry from '@sentry/node'"), ["@sentry/"]);
  });

  test("the deny-list does not fire on ordinary English or audio terms", () => {
    // The false positives a naive word-list would produce, and why the tokens
    // above are SDK-shaped.
    assert.deepEqual(trackersIn("that is a plausible explanation"), []);
    assert.deepEqual(trackersIn("the heap grows; segment the buffer"), []);
    assert.deepEqual(trackersIn("normalize the amplitude of the waveform"), []);
  });

  test("every promise page still exists", () => {
    // A rename must break this test, not quietly reduce coverage.
    for (const rel of PROMISE_PAGES) {
      assert.ok(
        fs.existsSync(path.join(REPO_ROOT, rel)),
        `${rel} is gone — update PROMISE_PAGES, and check the promise moved with it`,
      );
    }
  });

  test("no promise page loads a tracker", () => {
    for (const rel of PROMISE_PAGES) {
      const hits = trackersIn(fs.readFileSync(path.join(REPO_ROOT, rel), "utf8"));
      assert.deepEqual(
        hits,
        [],
        `${rel} promises no analytics but references: ${hits.join(", ")}`,
      );
    }
  });

  test("no shipped source anywhere references a tracking SDK", () => {
    const offenders: string[] = [];
    for (const root of SCAN_ROOTS) {
      const abs = path.join(REPO_ROOT, root);
      if (!fs.existsSync(abs)) continue;
      for (const file of walk(abs)) {
        let text: string;
        try {
          text = fs.readFileSync(file, "utf8");
        } catch {
          continue; // unreadable / binary
        }
        const hits = trackersIn(text);
        if (hits.length > 0) {
          offenders.push(`${path.relative(REPO_ROOT, file)} → ${hits.join(", ")}`);
        }
      }
    }
    assert.deepEqual(
      offenders,
      [],
      "website/src/pages/privacy.astro promises no third-party tracking SDKs. " +
        `Remove the tracker or change the promise:\n${offenders.join("\n")}`,
    );
  });

  test("no analytics package is declared as a dependency", () => {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"),
    ) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    const named = [
      ...Object.keys(pkg.dependencies ?? {}),
      ...Object.keys(pkg.devDependencies ?? {}),
    ];
    const bad = named.filter((name) => trackersIn(name).length > 0);
    assert.deepEqual(bad, [], `analytics packages in package.json: ${bad.join(", ")}`);
  });

  test("the website loads no third-party script at all", () => {
    // The stronger form of the same promise: the site has no external <script
    // src>, so there is nothing to audit at runtime.
    const pagesDir = path.join(REPO_ROOT, "website/src");
    const external: string[] = [];
    for (const file of walk(pagesDir)) {
      if (!/\.(astro|html|ts|js|tsx|jsx)$/.test(file)) continue;
      const text = fs.readFileSync(file, "utf8");
      for (const m of text.matchAll(/<script[^>]*\ssrc=["']([^"']+)["']/gi)) {
        const src = m[1] ?? "";
        if (/^(https?:)?\/\//i.test(src)) {
          external.push(`${path.relative(REPO_ROOT, file)} → ${src}`);
        }
      }
    }
    assert.deepEqual(external, [], `external scripts found:\n${external.join("\n")}`);
  });
});

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { MAIN_CSS } from "./lisa-css.js";

/**
 * Accessibility floor for the shell stylesheet (UX-3).
 *
 * No browser runs in `npm test`, so these checks work on the CSS text: the
 * theme tokens are parsed out of the :root / Calm blocks and the WCAG 2.x
 * contrast ratio is computed for each foreground token against the surfaces
 * it is actually painted on. The point is to make a future "let's soften the
 * secondary text a little" fail loudly instead of quietly dropping below AA.
 *
 * Also pinned: the global :focus-visible rule + its token, the 11.5px minimum
 * text size (three glyph-only rules excepted), and the reduced-motion block.
 */

type RGB = [number, number, number];
type RGBA = [number, number, number, number];

/** Custom-property declarations inside the first `selector {` block. */
function tokensOf(css: string, selector: string): Record<string, string> {
  const start = css.indexOf(selector + " {");
  assert.ok(start >= 0, `block not found: ${selector}`);
  const end = css.indexOf("}", start);
  const body = css.slice(start, end);
  const out: Record<string, string> = {};
  for (const m of body.matchAll(/(--[\w-]+):\s*([^;]+);/g)) out[m[1]!] = m[2]!.trim();
  return out;
}

function parseColor(value: string, tokens: Record<string, string>): RGBA {
  const v = value.trim();
  const ref = v.match(/^var\((--[\w-]+)\)$/);
  if (ref) return parseColor(tokens[ref[1]!] ?? "", tokens);
  const hex = v.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (hex) {
    let h = hex[1]!;
    if (h.length === 3) h = h.split("").map((c) => c + c).join("");
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16), 1];
  }
  const rgba = v.match(/^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/);
  if (rgba) return [Number(rgba[1]), Number(rgba[2]), Number(rgba[3]), rgba[4] === undefined ? 1 : Number(rgba[4])];
  throw new Error(`unparseable color: ${value}`);
}

/** Alpha-composite a translucent color over an opaque backdrop. */
function over(fg: RGBA, bg: RGB): RGB {
  const a = fg[3];
  return [0, 1, 2].map((i) => fg[i]! * a + bg[i]! * (1 - a)) as RGB;
}

function luminance([r, g, b]: RGB): number {
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** WCAG contrast ratio (1..21) of a text color over an opaque surface. */
export function contrast(fg: RGB, bg: RGB): number {
  const a = luminance(fg);
  const b = luminance(bg);
  const [hi, lo] = a > b ? [a, b] : [b, a];
  return (hi + 0.05) / (lo + 0.05);
}

const nebula = tokensOf(MAIN_CSS, ":root");
const calm = tokensOf(MAIN_CSS, 'body[data-theme="calm"]');

function surface(theme: Record<string, string>, token: string, base: RGB): RGB {
  return over(parseColor(theme[token]!, theme), base);
}
function text(theme: Record<string, string>, token: string): RGB {
  const c = parseColor(theme[token]!, theme);
  assert.equal(c[3], 1, `${token} must be opaque`);
  return [c[0], c[1], c[2]];
}

describe("theme tokens meet WCAG AA contrast on the surfaces they are used on", () => {
  // Nebula surfaces: translucent cards/rails sit on the frame gradient, whose
  // darkest stop is --bg-deep and lightest --bg-1; compositing over --bg-1
  // (the lighter one) is the conservative case for light-on-dark text.
  const nebBase = text(nebula, "--bg-1");
  const nebSurfaces: Record<string, RGB> = {
    "--bg-deep": text(nebula, "--bg-deep"),
    "--bg-1": nebBase,
    "--bg-card (over --bg-1)": surface(nebula, "--bg-card", nebBase),
    "--bg-3": text(nebula, "--bg-3"),
  };
  const calmSurfaces: Record<string, RGB> = {
    "--bg-card (#fff)": text(calm, "--bg-card"),
    "--bg-deep": text(calm, "--bg-deep"),
    "--bg-2": text(calm, "--bg-2"),
    "--bg-3": text(calm, "--bg-3"),
  };

  for (const [themeName, theme, surfaces] of [
    ["Nebula", nebula, nebSurfaces],
    ["Calm", calm, calmSurfaces],
  ] as const) {
    for (const [token, floor] of [
      ["--fg", 7],
      ["--fg-2", 4.5],
      ["--fg-3", 4.5],
    ] as const) {
      for (const [surfName, surf] of Object.entries(surfaces)) {
        test(`${themeName} ${token} on ${surfName} ≥ ${floor}:1`, () => {
          const ratio = contrast(text(theme, token), surf);
          assert.ok(ratio >= floor, `${theme[token]} on ${surfName} is ${ratio.toFixed(2)}:1`);
        });
      }
    }
    // The focus ring is a non-text indicator: WCAG 1.4.11 asks for 3:1
    // against the adjacent surface.
    test(`${themeName} --accent (focus ring) on the base surface ≥ 3:1`, () => {
      const base = themeName === "Nebula" ? nebSurfaces["--bg-deep"]! : calmSurfaces["--bg-card (#fff)"]!;
      const ratio = contrast(text(theme, "--accent"), base);
      assert.ok(ratio >= 3, `${theme["--accent"]} is ${ratio.toFixed(2)}:1`);
    });
  }
});

describe("keyboard focus ring", () => {
  test("--focus-ring / --focus-ring-offset tokens are defined on :root", () => {
    assert.match(nebula["--focus-ring"] ?? "", /solid var\(--accent\)/);
    assert.ok(nebula["--focus-ring-offset"], "missing --focus-ring-offset");
  });
  test("a global :focus-visible rule applies the token", () => {
    assert.match(MAIN_CSS, /:focus-visible\s*\{[^}]*outline:\s*var\(--focus-ring\)/);
  });
  test("icon buttons are at least 36px", () => {
    const fbtn = MAIN_CSS.match(/\.fbtn\s*\{[^}]*width:\s*(\d+)px;\s*height:\s*(\d+)px/);
    assert.ok(fbtn, ".fbtn size rule not found");
    assert.ok(Number(fbtn[1]) >= 36 && Number(fbtn[2]) >= 36, `.fbtn is ${fbtn[1]}×${fbtn[2]}`);
  });
});

describe("minimum text size", () => {
  // Pure glyphs, not text: the 8px tree twist arrow, the 8px source-letter
  // inside a 14px mini glyph box, and the 8px unread dot.
  const GLYPH_ONLY = new Set([
    ".twist",
    ".agent-glyph.mini",
    ".tleaf.unread .tname::after, .stab.unread .stab-name::after",
  ]);
  test("no text rule sets font-size below 11.5px", () => {
    const offenders: string[] = [];
    const re = /font(?:-size)?:\s*(?:\d+\s+)?(\d+(?:\.\d+)?)px/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(MAIN_CSS)) !== null) {
      if (Number(m[1]) >= 11.5) continue;
      // Selector = text between the previous block boundary and this rule's "{".
      const before = MAIN_CSS.slice(0, m.index);
      const open = before.lastIndexOf("{");
      const boundary = Math.max(before.lastIndexOf("}", open), before.lastIndexOf("{", open - 1));
      const selector = before
        .slice(boundary + 1, open)
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\s+/g, " ")
        .trim();
      if (!GLYPH_ONLY.has(selector)) offenders.push(`${selector} → ${m[1]}px`);
    }
    assert.deepEqual(offenders, []);
  });
});

describe("reduced motion", () => {
  test("a prefers-reduced-motion block silences the looping animations", () => {
    const block = MAIN_CSS.match(/@media \(prefers-reduced-motion: reduce\)\s*\{([\s\S]*?)\n  \}/);
    assert.ok(block, "reduced-motion block missing");
    assert.match(block[1]!, /animation:\s*none/);
    assert.match(block[1]!, /scroll-behavior:\s*auto/);
  });
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { qrSvg } from "./qr-svg.js";

const URL = "lisa-pair://v1?host=192.168.3.42&port=5757&token=abc123def456&name=phone";

test("produces a well-formed square SVG with a quiet zone", () => {
  const svg = qrSvg(URL);
  assert.ok(svg.startsWith("<svg"));
  assert.ok(svg.trimEnd().endsWith("</svg>"));
  // square: width === height
  const w = svg.match(/width="(\d+)"/)?.[1];
  const h = svg.match(/height="(\d+)"/)?.[1];
  assert.equal(w, h);
  // a white background rect + many black module rects
  assert.match(svg, /fill="#fff"/);
  assert.match(svg, /fill="#000"/);
  const rects = svg.match(/<rect /g) ?? [];
  assert.ok(rects.length > 50, `expected many modules, got ${rects.length}`);
});

test("viewBox is module-units and includes the margin (quiet zone)", () => {
  const svg = qrSvg(URL, { margin: 4 });
  const vb = svg.match(/viewBox="0 0 (\d+) (\d+)"/);
  assert.ok(vb);
  const total = Number(vb![1]);
  // total = moduleCount + 2*margin; with margin 4 that's at least 8 bigger than 21 (v1)
  assert.ok(total >= 21 + 8);
  assert.equal(vb![1], vb![2]); // square
});

test("size option scales the pixel dimensions, not the viewBox", () => {
  const a = qrSvg(URL, { size: 120 });
  assert.match(a, /width="120"/);
  // viewBox stays in module units regardless of pixel size
  assert.match(a, /viewBox="0 0 \d+ \d+"/);
});

test("longer data yields a denser (>=) grid", () => {
  const small = qrSvg("lisa-pair://v1?host=10.0.0.1&port=80&token=x&name=p");
  const big = qrSvg(URL + "&extra=" + "z".repeat(120));
  const tot = (s: string) => Number(s.match(/viewBox="0 0 (\d+)/)![1]);
  assert.ok(tot(big) >= tot(small));
});

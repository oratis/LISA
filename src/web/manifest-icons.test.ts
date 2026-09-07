import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The PWA icons the optimiser generates must actually be served.
 *
 * scripts/optimize-assets.ts derives icon-192 / icon-512 (both inset into the
 * maskable safe zone) and a 180x180 apple-touch-icon, and its own `purpose`
 * strings say "web manifest". They landed in src/web/assets and nothing
 * referenced them: the manifest still declared /assets/lisa-mascot.png twice
 * with sizes:"any", and the <link rel="apple-touch-icon"> still pointed at the
 * mascot — so three generated files shipped in the npm package as dead weight
 * while Chrome and iOS carried on falling back to a page screenshot.
 *
 * A byte snapshot of MAIN_HTML cannot catch that (it pins whatever is there),
 * and no test starts the web server, so this reads the served sources
 * directly. It is deliberately dumb: file exists, is referenced, and the
 * declared size is the real pixel size.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ASSETS = path.join(HERE, "assets");
const serverSrc = fs.readFileSync(path.join(HERE, "server.ts"), "utf8");
const htmlSrc = fs.readFileSync(path.join(HERE, "lisa-html.ts"), "utf8");

/** width/height straight out of the PNG IHDR — no image library needed. */
function pngSize(file: string): { width: number; height: number } {
  const buf = fs.readFileSync(file);
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.ok(buf.subarray(0, 8).equals(sig), `${file} is not a PNG`);
  assert.equal(buf.toString("ascii", 12, 16), "IHDR", `${file} has no leading IHDR`);
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

/** The `icons: [...]` entries out of the /manifest.webmanifest handler. */
function manifestIcons(): { src: string; sizes: string; purpose: string }[] {
  const block = /icons:\s*\[([\s\S]*?)\]/.exec(serverSrc);
  assert.ok(block, "could not find the manifest icons array in server.ts");
  const out: { src: string; sizes: string; purpose: string }[] = [];
  // Entries are written both inline and split over lines, with or without a
  // trailing comma — match all of those shapes.
  const entry =
    /\{\s*src:\s*"([^"]+)"\s*,\s*sizes:\s*"([^"]+)"\s*,\s*type:\s*"[^"]+"\s*,\s*purpose:\s*"([^"]+)"\s*,?\s*\}/g;
  for (const m of block[1].matchAll(entry)) {
    out.push({ src: m[1] as string, sizes: m[2] as string, purpose: m[3] as string });
  }
  return out;
}

describe("PWA manifest icons", () => {
  test("declares a 192 and a 512, both real files at the declared size", () => {
    const icons = manifestIcons();
    assert.ok(icons.length >= 2, `expected at least two icons, got ${icons.length}`);

    for (const icon of icons) {
      assert.ok(icon.src.startsWith("/assets/"), `${icon.src} must be served from /assets/`);
      const file = path.join(ASSETS, icon.src.slice("/assets/".length));
      assert.ok(fs.existsSync(file), `${icon.src} is declared in the manifest but does not exist`);

      // sizes:"any" on a raster PNG is what made Chrome and iOS fall back to a
      // screenshot — it tells the browser nothing it can select on.
      assert.notEqual(icon.sizes, "any", `${icon.src}: declare real pixels, not sizes:"any"`);
      const m = /^(\d+)x(\d+)$/.exec(icon.sizes);
      assert.ok(m, `${icon.src}: sizes must be WxH, got ${icon.sizes}`);
      const { width, height } = pngSize(file);
      assert.equal(width, Number(m[1]), `${icon.src}: declared width does not match the file`);
      assert.equal(height, Number(m[2]), `${icon.src}: declared height does not match the file`);
    }

    const declared = icons.map((i) => i.sizes);
    assert.ok(declared.includes("192x192"), "Chrome needs a 192x192 to treat the app as installable");
    assert.ok(declared.includes("512x512"), "Chrome needs a 512x512 for the splash screen");
  });

  test("maskable is its own file, never the unpadded icon relabelled", () => {
    const icons = manifestIcons();
    const maskable = icons.filter((i) => i.purpose.split(/\s+/).includes("maskable"));
    assert.equal(maskable.length, 1, "exactly one maskable icon");
    const plain = icons.filter((i) => !i.purpose.split(/\s+/).includes("maskable"));
    assert.ok(plain.length >= 2, "and the full-bleed icons stay purpose any");

    // The platform crops a maskable icon to its own mask, so it has to carry
    // safe-zone padding of its own. Sharing bytes with an unpadded icon loses
    // the edges; padding the "any" icon makes it render visibly small next to
    // every other app. Different files is the only way to get both right — so
    // assert they really are different bytes.
    const bytes = (src: string) => fs.readFileSync(path.join(ASSETS, src.slice("/assets/".length)));
    for (const p of plain) {
      assert.ok(
        !bytes(p.src).equals(bytes(maskable[0]!.src)),
        `${maskable[0]!.src} must not be ${p.src} relabelled`,
      );
    }
  });

  test("apple-touch-icon points at the generated 180x180, not the mascot", () => {
    const m = /<link rel="apple-touch-icon"[^>]*href="([^"]+)"/.exec(htmlSrc);
    assert.ok(m, "no apple-touch-icon link in lisa-html.ts");
    const href = m[1] as string;
    assert.ok(href.startsWith("/assets/"), `${href} must be served from /assets/`);
    const file = path.join(ASSETS, href.slice("/assets/".length));
    assert.ok(fs.existsSync(file), `${href} is linked but does not exist`);
    const { width, height } = pngSize(file);
    assert.deepEqual({ width, height }, { width: 180, height: 180 }, `${href} must be 180x180`);
  });

  test("every generated icon is precached by the service worker", () => {
    // Cache-first for /assets/*: an icon missing from ASSET_PATHS is fetched
    // from the network on first install, which is exactly when the home-screen
    // icon is being chosen.
    for (const f of ["icon-192.png", "icon-512.png", "icon-512-maskable.png", "apple-touch-icon.png"]) {
      assert.ok(
        serverSrc.includes(`'/assets/${f}'`),
        `${f} is generated and served but not in the service worker precache list`,
      );
    }
  });
});

import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { SOFT_INK_JS, SOFT_INK_MANIFEST } from "./soft-ink.js";

function renderer() {
  const images: Array<{
    naturalWidth: number;
    naturalHeight: number;
    onload: () => void;
    onerror: () => void;
  }> = [];
  class Image {
    naturalWidth = 1536;
    naturalHeight = 1024;
    onload = () => {};
    onerror = () => {};
    src = "";
    constructor() {
      images.push(this);
    }
  }
  const window = {} as {
    LisaArt: {
      portrait(element: { src: string }, slug: string): Promise<boolean>;
      indexFor(slug: string): number;
    };
  };
  const document = {
    createElement() {
      let crop: number[] = [];
      return {
        width: 0,
        height: 0,
        getContext() {
          return {
            drawImage(_image: unknown, ...args: number[]) {
              crop = args;
            },
          };
        },
        toDataURL() {
          return JSON.stringify(crop);
        },
      };
    },
  };
  vm.runInNewContext(SOFT_INK_JS, {
    window,
    Image,
    document,
    Map,
    WeakMap,
    Promise,
    Number,
    Object,
    Error,
  });
  return { api: window.LisaArt, images };
}

test("every public mood has an explicit valid Soft Ink expression, without renaming states", () => {
  const catalog = JSON.parse(
    readFileSync(new URL("./assets/lisa/index.json", import.meta.url), "utf8"),
  );
  const spec = SOFT_INK_MANIFEST.portraits;
  assert.deepEqual(
    Object.keys(spec.aliases).sort(),
    catalog.moods.map((m: { slug: string }) => m.slug).sort(),
  );
  assert.equal(spec.core.length, spec.columns * spec.rows);
  for (const index of Object.values<number>(spec.aliases)) {
    assert.ok(Number.isInteger(index) && index >= 0 && index < spec.core.length);
  }
});

test("rapid mood changes share a single load and only the latest image is applied", async () => {
  const { api, images } = renderer();
  const element = { src: "previous" };
  const first = api.portrait(element, "happy");
  const second = api.portrait(element, "cheering");
  assert.equal(images.length, 1);
  assert.equal(element.src, "previous");
  images[0]!.onload();
  assert.deepEqual(await Promise.all([first, second]), [false, true]);
  assert.deepEqual(JSON.parse(element.src).slice(0, 4), [512, 512, 256, 256]);
});

test("failed images preserve the visible portrait and can retry", async () => {
  const { api, images } = renderer();
  const element = { src: "previous" };
  const failed = api.portrait(element, "thoughtful");
  images[0]!.onerror();
  assert.equal(await failed, false);
  assert.equal(element.src, "previous");
  const retry = api.portrait(element, "thoughtful");
  assert.equal(images.length, 2);
  images[1]!.onload();
  assert.equal(await retry, true);
  assert.deepEqual(JSON.parse(element.src).slice(0, 4), [1024, 0, 256, 256]);
});

test("unknown and prototype-like mood names resolve to neutral", () => {
  const { api } = renderer();
  for (const value of ["missing", "__proto__", "constructor", ""])
    assert.equal(api.indexFor(value), 0);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir, stat } from "node:fs/promises";
import sharp from "sharp";
import { createHash } from "node:crypto";

const root = new URL("./assets/visuals/soft-ink-motion-v1/", import.meta.url);
test("every state, pose and sticker is covered, with each animation below 256 KiB", async () => {
  const files = await readdir(root);
  const sizes = await Promise.all(
    files.map(async (name) => (await stat(new URL(name, root))).size),
  );
  const controller = await stat(new URL("./assets/client/motion.js", import.meta.url));
  const effects = await stat(new URL("./assets/client/room-effects.js", import.meta.url));
  const report = JSON.parse(
    await readFile(
      new URL(
        "../../docs/design/2026-11-07-motion-samples/production-report.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  assert.equal(
    report.totalBytes,
    sizes.reduce((a, b) => a + b, controller.size + effects.size),
  );
  for (const [index, name] of files.entries())
    if (/\.(webp|gif)$/.test(name))
      assert.ok(sizes[index]! <= 256 * 1024, name + " exceeds per-file budget");
  const manifest = JSON.parse(await readFile(new URL("manifest.json", root), "utf8"));
  assert.equal(Object.keys(manifest.portraits).length, 24);
  assert.equal(Object.keys(manifest.clips).length, 46);
  const art = JSON.parse(await readFile(new URL("../soft-ink-v1/manifest.json", root), "utf8"));
  for (const index of Object.values<number>(art.portraits.aliases))
    assert.ok(manifest.clips[manifest.portraits[index]]);
  assert.equal(manifest.poses.length, 12);
  assert.equal(manifest.stickers.length, 8);
  for (const id of [...manifest.poses, ...manifest.stickers]) assert.ok(manifest.clips[id]);
  const expected = new Set(["manifest.json", "manifest.js"]);
  for (const clip of Object.values<{
    src: string;
    poster: string;
    native?: string;
    durationMs: number;
  }>(manifest.clips)) {
    for (const url of [clip.src, clip.poster, clip.native].filter((url): url is string => !!url))
      expected.add(url.split("/").pop()!);
    const image = sharp(new URL(clip.src.split("/").pop()!, root).pathname, { animated: true });
    const meta = await image.metadata();
    assert.ok(meta.pages! > 1 && meta.hasAlpha);
    assert.equal(
      meta.delay!.reduce((a, b) => a + b, 0),
      clip.durationMs,
    );
    const raw = await image.ensureAlpha().raw().toBuffer();
    const frameSize = meta.width * meta.pageHeight! * 4;
    const hashes = new Set(
      Array.from({ length: meta.pages! }, (_, i) =>
        createHash("sha256")
          .update(raw.subarray(i * frameSize, (i + 1) * frameSize))
          .digest("hex"),
      ),
    );
    assert.ok(hashes.size > 1, clip.src + " must actually animate");
    const poster = await sharp(new URL(clip.poster.split("/").pop()!, root).pathname).metadata();
    assert.equal(poster.pages || 1, 1);
    if (clip.native) {
      const gif = await sharp(new URL(clip.native.split("/").pop()!, root).pathname, {
        animated: true,
      }).metadata();
      assert.ok(gif.pages! > 1 && gif.pages! <= 16);
      assert.equal(
        gif.delay!.reduce((a, b) => a + b, 0),
        clip.durationMs,
      );
    }
  }
  assert.deepEqual(files.sort(), [...expected].sort(), "No authoring masters or unused files ship");
});

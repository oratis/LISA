import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { loadSocialMedia, stageSocialMedia } from "./media.js";

let home: string;
let previousHome: string | undefined;

beforeEach(() => {
  previousHome = process.env.LISA_HOME;
  home = fs.mkdtempSync(path.join(os.tmpdir(), "lisa-social-media-"));
  process.env.LISA_HOME = home;
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.LISA_HOME;
  else process.env.LISA_HOME = previousHome;
  fs.rmSync(home, { recursive: true, force: true });
});

test("stages sniffed media privately and verifies its digest on read", async () => {
  const png = Buffer.from("89504e470d0a1a0a", "hex");
  const ref = await stageSocialMedia(png, "image/png", "sample");
  assert.equal(ref.kind, "image");
  assert.deepEqual(await loadSocialMedia(ref), png);
  const dir = path.join(home, "sense", "social", "media");
  for (const name of fs.readdirSync(dir)) {
    assert.equal(fs.statSync(path.join(dir, name)).mode & 0o777, 0o600);
  }
});

test("strips JPEG EXIF before hashing and storage", async () => {
  const jpeg = Buffer.from("ffd8ffe1000645786966ffd9", "hex");
  const ref = await stageSocialMedia(jpeg, "image/jpeg");
  const stored = await loadSocialMedia(ref);
  assert.deepEqual(stored, Buffer.from("ffd8ffd9", "hex"));
  assert.equal(ref.bytes, 4);
});

test("rejects MIME claims that do not match the bytes", async () => {
  await assert.rejects(
    stageSocialMedia(Buffer.from("89504e470d0a1a0a", "hex"), "image/jpeg"),
    /MIME mismatch/,
  );
});

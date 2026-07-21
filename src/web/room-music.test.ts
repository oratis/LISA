import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// lisaHome() (→ the ~/.lisa/music user dir) is read at import, so set a tmp home
// before the dynamic import; node --test isolates each file in its own process.
let mod: typeof import("./room-music.js");
let home: string;
let bundled: string;

before(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "lisa-music-home-"));
  process.env.LISA_HOME = home;
  bundled = fs.mkdtempSync(path.join(os.tmpdir(), "lisa-music-bundled-"));
  mod = await import("./room-music.js");
});
after(() => {
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(bundled, { recursive: true, force: true });
});

function writeManifest(entries: unknown[]) {
  fs.writeFileSync(path.join(bundled, "manifest.json"), JSON.stringify(entries));
}

describe("listRoomMusic", () => {
  test("reads the bundled manifest into resolved tracks", async () => {
    writeManifest([
      { id: "a", title: "Track A", mood: "classical", file: "a.mp3", license: "CC0 1.0" },
      { id: "b", title: "Track B", mood: "classic", file: "b.mp3", license: "CC BY 4.0", attribution: "Someone" },
    ]);
    const tracks = await mod.listRoomMusic(bundled);
    assert.equal(tracks.length, 2);
    assert.equal(tracks[0]!.id, "b_a");
    assert.equal(tracks[0]!.source, "bundled");
    assert.equal(tracks[0]!.filePath, path.resolve(bundled, "a.mp3"));
    assert.equal(tracks[1]!.attribution, "Someone");
  });

  test("rejects manifest files that escape the bundled dir (traversal guard)", async () => {
    writeManifest([
      { id: "ok", title: "ok", mood: "light", file: "ok.mp3", license: "CC0 1.0" },
      { id: "up", title: "evil", mood: "light", file: "../secret.mp3", license: "x" },
      { id: "sub", title: "nested", mood: "light", file: "sub/x.mp3", license: "x" },
      { id: "abs", title: "abs", mood: "light", file: "/etc/passwd", license: "x" },
    ]);
    const ids = (await mod.listRoomMusic(bundled)).map((t) => t.id);
    assert.deepEqual(ids, ["b_ok"], "only the in-dir file survives");
  });

  test("merges ~/.lisa/music/*.mp3 as mood 'mine' after bundled", async () => {
    writeManifest([{ id: "a", title: "A", mood: "classical", file: "a.mp3", license: "CC0 1.0" }]);
    const dir = mod.userMusicDir();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "My Song.mp3"), "id3");
    fs.writeFileSync(path.join(dir, "notes.txt"), "ignored");
    const tracks = await mod.listRoomMusic(bundled);
    assert.equal(tracks.length, 2, "one bundled + one user mp3 (txt ignored)");
    const user = tracks[1]!;
    assert.equal(user.source, "user");
    assert.equal(user.mood, "mine");
    assert.equal(user.title, "My Song");
    assert.ok(user.id.startsWith("u_"), "user ids are opaque");
    assert.equal(user.filePath, path.join(dir, "My Song.mp3"));
  });

  test("missing manifest and missing user dir → empty, never throws", async () => {
    // lisaHome() is a const fixed at import, so simulate "no user music" by
    // removing the dir, and point at a bundled dir with no manifest.json.
    fs.rmSync(mod.userMusicDir(), { recursive: true, force: true });
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "lisa-music-empty-"));
    const tracks = await mod.listRoomMusic(empty);
    assert.deepEqual(tracks, []);
    fs.rmSync(empty, { recursive: true, force: true });
  });
});

describe("toPublicTrack", () => {
  test("drops filePath and adds a keyed stream url", () => {
    const pub = mod.toPublicTrack({
      id: "b_x", title: "X", mood: "light", license: "CC0 1.0",
      source: "bundled", filePath: "/abs/x.mp3",
    });
    assert.equal((pub as Record<string, unknown>).filePath, undefined);
    assert.equal(pub.url, "/api/room/music/file/b_x");
    assert.equal(pub.title, "X");
  });
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runInNewContext } from "node:vm";
import { GameImportDriver, openGameImportStore } from "./import.js";
import type { CredentialAccess } from "../types.js";

const script = await readFile(
  new URL("../../web/assets/client/game-import.js", import.meta.url),
  "utf8",
);
const browserParse = runInNewContext(script + "\nparseGameImportFile", {
  TextDecoder,
  Uint8Array,
}) as (data: Uint8Array) => Record<string, unknown>[];
const parse = (data: Buffer | string) =>
  JSON.parse(JSON.stringify(browserParse(typeof data === "string" ? Buffer.from(data) : data)));
const sig = AbortSignal.timeout(30_000);
const noProgress = () => {};
const cred = (token: string): CredentialAccess => ({ use: (work) => work(token, async () => {}) });
const d = new GameImportDriver();

test("Playnite localized export headers, quoting and Windows encodings preserve zero, IDs and editions", () => {
  const english =
    'Name,Sources,Platforms,Time Played,Game Id,Version,Notes\r\n"Game, ""X""",Steam,PC,0,620,1.2,"first\r\nsecond"\r\n"Game, ""X""",Nintendo,Switch,,,Remake,private\r\n';
  assert.deepEqual(parse(english), [
    {
      title: 'Game, "X"',
      source: "Steam",
      platform: "PC",
      playtimeSeconds: 0,
      sourceId: "620",
      version: "1.2",
    },
    { title: 'Game, "X"', source: "Nintendo", platform: "Switch", version: "Remake" },
  ]);
  const utf16 = Buffer.from(
    "sep=;\r\n名称;来源;平台;游玩时间;游戏 ID;导出时间\r\n奥日;GOG;PC;3600;C:\\Games\\private;2026-11-22T18:00:00+08:00",
    "utf16le",
  );
  const result = [
    {
      title: "奥日",
      source: "GOG",
      platform: "PC",
      playtimeSeconds: 3600,
      exportedAt: "2026-11-22T10:00:00.000Z",
    },
  ];
  assert.deepEqual(parse(Buffer.concat([Buffer.from([0xff, 0xfe]), utf16])), result);
  assert.deepEqual(
    parse(Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(utf16).swap16()])),
    result,
  );
  assert.deepEqual(parse("\uFEFFTitle\tSource\r\nSame\t\r\nSame\t"), [
    { title: "Same" },
    { title: "Same" },
  ]);
});
test("malformed CSV, duplicate headers, bad units, and resource limits fail before saving", () => {
  for (const file of [
    "Name,Title\nA,B",
    "Name,Time Played\nA,50h",
    "Name,Source\nA",
    "Name,ExportedAt\nA,2026-02-31T12:00:00Z",
    'Name\n"A"tail',
    'Name,Notes\n"A',
    "Name\nA\0",
    "Email\nme@example.com",
    "Name\n\n",
    "Name,Source\n,steam",
    "Name," + "a,".repeat(64) + "b\nonly",
    Buffer.from([0x80]),
    "Name\n" + "A\n".repeat(10001),
    Buffer.alloc(4 * 1024 * 1024 + 1),
  ])
    assert.throws(() => parse(file));
});
test("each snapshot binds its rows to one unique account and only confirmed fields reach results", async () => {
  const input = JSON.stringify([
    { title: "Same", source: "Steam", playtimeSeconds: 0 },
    { title: "Same", source: "itch.io", sourceId: "42" },
    { title: "Unselected" },
  ]);
  const a = await d.authorize("import", sig, noProgress, input),
    b = await d.authorize("import", sig, noProgress, input);
  assert.notEqual(a.account.id, b.account.id);
  const c = cred(a.token),
    choices = await d.resources(c, 1, sig);
  assert.deepEqual(await d.account(c, sig), a.account);
  assert.equal(choices.length, 3);
  assert.notEqual(choices[0]!.id, choices[1]!.id);
  assert.deepEqual(await d.resources(c, 2, sig), []);
  const output = await d.read(c, a.account, [choices[0]!], { operation: "list" }, sig);
  assert.equal(output.evidence, "user_imported_csv");
  assert.equal(output.games[0]?.playtimeSeconds, 0);
  assert.ok(Date.parse(output.importedAt));
  assert.doesNotMatch(JSON.stringify(output), /Unselected|itch\.io/);
  assert.deepEqual(
    await d.read(
      c,
      a.account,
      [choices[0]!],
      { operation: "read", resourceId: choices[0]!.id },
      sig,
    ),
    output,
  );
  await assert.rejects(
    d.read(c, a.account, [choices[0]!], { operation: "read", resourceId: choices[1]!.id }, sig),
    /game_import_scope/,
  );
  await assert.rejects(
    d.read(c, b.account, choices, { operation: "list" }, sig),
    /connector_account_changed/,
  );
  await assert.rejects(d.resource(cred(b.token), choices[0]!.id, sig), /game_import_scope/);
  assert.throws(
    () => d.read(c, a.account, choices, { operation: "list", path: "/tmp/games.csv" }, sig),
    /game_import_scope/,
  );
});
test("the authorization boundary rejects unreviewed fields, types, forged dates and oversized selections", async () => {
  for (const value of [
    [{ title: "valid", notes: "sensitive" }],
    [{ title: "valid", sourceId: "/Users/me/private" }],
    [{ title: "ok", playtimeSeconds: -1 }],
    [{ title: "ok", exportedAt: "2026-02-31T00:00:00.000Z" }],
    [{ title: "bad\u202e" }],
    "a text file",
    Array.from({ length: 31 }, () => ({ title: "one" })),
    [],
  ]) {
    await assert.rejects(
      d.authorize("import", sig, noProgress, JSON.stringify(value)),
      /game_import_invalid/,
    );
  }
  await assert.rejects(d.authorize("login", sig, noProgress), /game_import_required/);
});
test("the dedicated local snapshot store can save and remove a maximum-size multilingual selection", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "lisa-game-snapshot-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const store = openGameImportStore(home);
  const games = Array.from({ length: 30 }, (_, i) => ({
    title: "游".repeat(195) + i,
    source: "源".repeat(80),
    version: "版".repeat(64),
    platform: "台".repeat(80),
    sourceId: "7".repeat(128),
  }));
  const { token } = await d.authorize("import", sig, noProgress, JSON.stringify(games));
  const key = "game-library/fixture";
  await store.set(key, token);
  const dir = path.join(home, "warden", "game-library");
  const raw = await readFile(path.join(dir, "snapshots.enc.json"), "utf8");
  assert.doesNotMatch(raw, /游游|版版/);
  assert.equal((await stat(path.join(dir, "snapshot.key"))).mode & 0o777, 0o600);
  assert.equal(await openGameImportStore(home).get(key), token);
  await store.remove(key);
  assert.equal(await store.get(key), null);
  assert.doesNotMatch(await readFile(path.join(dir, "snapshots.enc.json"), "utf8"), /fixture/);
});

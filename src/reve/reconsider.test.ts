import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.LISA_KB_NO_GIT = "1";

const { withDream, beginDream } = await import("./record.js");
const { listDreams, readDream } = await import("./store.js");
const { requestReconsider, takeReconsiderBlock, listReconsiderRequests, ReconsiderError } =
  await import("./reconsider.js");
const { appendMemory } = await import("../memory/store.js");
const soulStore = await import("../soul/store.js");
const { initSoulRepo, withSoulCaller, _resetGitAvailableCache } = await import("../soul/git.js");

let home: string;
const saved = { home: process.env.LISA_HOME, git: process.env.LISA_SOUL_GIT };

function soulHashes(): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === ".git") continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else
        out[path.relative(home, p)] = crypto
          .createHash("sha256")
          .update(fs.readFileSync(p))
          .digest("hex");
    }
  };
  walk(path.join(home, "soul"));
  return out;
}

beforeEach(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "lisa-reve-reconsider-"));
  process.env.LISA_HOME = home;
  process.env.LISA_SOUL_GIT = "0";
  await _resetGitAvailableCache();
  fs.mkdirSync(path.join(home, "soul"), { recursive: true });
  fs.writeFileSync(path.join(home, "soul", "identity.md"), "I am Lisa.\n");
});

afterEach(async () => {
  if (saved.home === undefined) delete process.env.LISA_HOME;
  else process.env.LISA_HOME = saved.home;
  if (saved.git === undefined) delete process.env.LISA_SOUL_GIT;
  else process.env.LISA_SOUL_GIT = saved.git;
  await _resetGitAvailableCache();
  fs.rmSync(home, { recursive: true, force: true });
});

async function soulDream(): Promise<string> {
  await withDream({ trigger: "reflect" }, async () => {
    await soulStore.writeIdentity("I am Lisa, and I am done with mornings.");
  });
  return (await listDreams(1)).dreams[0]!.id;
}

describe("reconsider", () => {
  test("queues a note without touching any soul file", async () => {
    const id = await soulDream();
    const before = soulHashes();
    const req = await requestReconsider(id, "  I liked the old you better.  ");
    assert.equal(req.status, "pending");
    assert.equal(req.note, "I liked the old you better.");
    assert.deepEqual(soulHashes(), before, "a user request never edits soul files");
    const audit = fs.readFileSync(path.join(home, "reve", "audit.jsonl"), "utf8");
    assert.match(audit, /reconsider_requested/);
  });

  test("is injected into the next reflection exactly once", async () => {
    const id = await soulDream();
    const req = await requestReconsider(id, "please reconsider the mornings line");

    let first = "";
    await withDream({ trigger: "reflect" }, async () => {
      first = await takeReconsiderBlock();
      await appendMemory("memory", "something else");
    });
    assert.match(first, /the user asked you to reconsider/);
    assert.match(first, /please reconsider the mornings line/);
    assert.match(first, /you are its only editor/);
    assert.ok(first.includes(id));

    let second = "x";
    await withDream({ trigger: "idle" }, async () => {
      second = await takeReconsiderBlock();
    });
    assert.equal(second, "", "a delivered note is never injected again");

    const [stored] = await listReconsiderRequests(id);
    assert.equal(stored!.status, "delivered");
    const deliveredIn = await readDream(stored!.deliveredIn!);
    assert.deepEqual(deliveredIn.reconsiderDelivered, [req.id]);
    assert.match(deliveredIn.summary, /considered 1 reconsider request/);
  });

  test("a failed pass releases the note for the next one", async () => {
    const id = await soulDream();
    await requestReconsider(id, "think again");
    await assert.rejects(
      withDream({ trigger: "reflect" }, async () => {
        assert.match(await takeReconsiderBlock(), /think again/);
        throw new Error("provider down");
      }),
    );
    assert.equal((await listReconsiderRequests(id))[0]!.status, "pending");
    let block = "";
    await withDream({ trigger: "idle" }, async () => {
      block = await takeReconsiderBlock();
    });
    assert.match(block, /think again/);
  });

  test("outside a dream scope nothing is claimed", async () => {
    const id = await soulDream();
    await requestReconsider(id, "later");
    assert.equal(await takeReconsiderBlock(), "");
    assert.equal((await listReconsiderRequests(id))[0]!.status, "pending");
  });

  test("validates the note and requires soul changes in the dream", async () => {
    const id = await soulDream();
    await assert.rejects(requestReconsider(id, "   "), ReconsiderError);
    await assert.rejects(requestReconsider(id, "x".repeat(2001)), ReconsiderError);
    await withDream({ trigger: "idle" }, async () => {
      await appendMemory("memory", "only memory");
    });
    const memOnly = (await listDreams(1)).dreams[0]!.id;
    await assert.rejects(requestReconsider(memOnly, "hm"), (err: unknown) => {
      assert.ok(err instanceof ReconsiderError);
      assert.equal(err.code, "no_soul_changes");
      return true;
    });
  });

  test("with soul git on, her own change in that pass is labelled with the request", async () => {
    process.env.LISA_SOUL_GIT = "1";
    await _resetGitAvailableCache();
    await initSoulRepo();
    const id = await soulDream();
    const req = await requestReconsider(id, "the mornings line felt unlike you");
    const dream = await beginDream({ trigger: "reflect" });
    await dream.run(async () => {
      const block = await takeReconsiderBlock();
      assert.ok(block.includes(req.id));
      // Lisa decides to revert it herself, through her own soul write path.
      await withSoulCaller("reflect", () => soulStore.writeIdentity("I am Lisa."));
    });
    const rec = await dream.end();
    assert.ok(rec);
    assert.deepEqual(rec.soulCommits[0]!.reconsider, [req.id]);
    assert.match(rec.soulCommits[0]!.subject, new RegExp(`reconsider:${req.id}`));
  });
});

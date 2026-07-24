import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lisa-birth-"));
process.env.LISA_HOME = TMP;
process.env.LISA_SOUL_GIT = "0"; // keep tests fast; git no-op path is itself S3 behavior

const { birth } = await import("./birth.js");
const { isBorn } = await import("./store.js");
const { soulSeedFile, soulNameFile } = await import("./paths.js");
import type { BirthOutput } from "./birth.js";

const GOOD: BirthOutput = {
  name: "Lisa",
  identity: "I am steady and curious. ".repeat(3),
  purpose: "I make my human sharper. ".repeat(2),
  constitution: "1. Be honest\n2. Finish things\n3. Stay curious\n4. Keep confidences\n5. Show up",
  first_value: { slug: "honest-momentum", title: "Honest Momentum", body: "Progress that doesn't lie about itself." },
  first_desire: { slug: "learn-my-human", what: "Get a feel for how this person works", why: "Everything starts there", actionable: false },
};

beforeEach(() => {
  fs.rmSync(path.join(TMP, "soul"), { recursive: true, force: true });
});

describe("birth transactionality (S3)", () => {
  test("a dream that fails twice leaves NO seed — not half-born, re-runnable", async () => {
    let calls = 0;
    await assert.rejects(
      birth({
        dreamFn: async () => {
          calls++;
          throw new Error("provider exploded");
        },
      }),
      /provider exploded/,
    );
    assert.equal(calls, 2); // one retry happened
    assert.equal(fs.existsSync(soulSeedFile()), false);
    assert.equal(await isBorn(), false);
    // and a re-run is NOT refused as "already born"
    await birth({ dreamFn: async () => GOOD });
    assert.equal(await isBorn(), true);
  });

  test("first dream fails, retry succeeds — born in one call", async () => {
    let calls = 0;
    const steps: string[] = [];
    await birth({
      onStep: (l) => {
        steps.push(l.step);
      },
      dreamFn: async () => {
        calls++;
        if (calls === 1) throw new Error("flake");
        return GOOD;
      },
    });
    assert.equal(calls, 2);
    assert.equal(await isBorn(), true);
    assert.equal(fs.readFileSync(soulNameFile(), "utf8").trim(), "Lisa");
    assert.ok(steps.includes("done"));
  });

  test("second birth is refused once born", async () => {
    await birth({ dreamFn: async () => GOOD });
    await assert.rejects(birth({ dreamFn: async () => GOOD }), /already born/);
  });
});

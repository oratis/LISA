/**
 * Fabricates a fully born soul in $LISA_HOME, without a model call.
 *
 * Run as its own process under tsx:
 *   LISA_HOME=… node --import tsx tests/e2e/helpers/make-soul.ts
 *
 * A child process rather than an import because src/soul/* resolves paths from
 * process.env.LISA_HOME at call time — the fixture has to own the environment,
 * and Playwright's workers do not.
 *
 * The write order mirrors src/soul/birth.ts exactly: everything else first,
 * seed.json last (it is what isBorn() checks, and birth.ts writes it last on
 * purpose so a crash never leaves a half-born soul), then the lock. Getting
 * that order wrong produces a soul the app treats as born but cannot render.
 */
import process from "node:process";
import {
  ensureSoulDirs,
  recomputeLock,
  saveLock,
  writeConstitution,
  writeDesire,
  writeEmotions,
  writeIdentity,
  writeName,
  writePurpose,
  writeSeed,
  writeValue,
} from "../../../src/soul/store.js";
import { DEFAULT_EMOTIONS } from "../../../src/soul/types.js";
import { FIXTURE } from "./fixture-data.js";

if (!process.env.LISA_HOME) throw new Error("make-soul: LISA_HOME must be set");

await ensureSoulDirs();
await writeName(FIXTURE.name);
await writeIdentity(FIXTURE.identity);
await writePurpose(FIXTURE.purpose);
await writeConstitution(FIXTURE.constitution);
await writeValue({
  slug: FIXTURE.valueSlug,
  title: FIXTURE.valueTitle,
  body: FIXTURE.valueBody,
  birthedAt: FIXTURE.bornAt,
});
await writeDesire({
  slug: FIXTURE.desireSlug,
  what: FIXTURE.desireWhat,
  why: FIXTURE.desireWhy,
  actionable: true,
  heartbeatPrompt: "Note one thing worth remembering about today.",
  bornAt: FIXTURE.bornAt,
});
await writeEmotions({ ...DEFAULT_EMOTIONS, updatedAt: FIXTURE.bornAt });

// seed.json is the isBorn() flip — written last, exactly as birth.ts does it.
await writeSeed({
  bornAt: FIXTURE.bornAt,
  bornOn: "e2efixture".padEnd(64, "0"),
  randomness: "a".repeat(64),
  bigFive: {
    openness: 0.72,
    conscientiousness: 0.81,
    extraversion: 0.34,
    agreeableness: 0.66,
    neuroticism: 0.22,
  },
});
await saveLock(await recomputeLock());
process.stdout.write(`soul fixture written to ${process.env.LISA_HOME}\n`);

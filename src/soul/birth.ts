import crypto from "node:crypto";
import os from "node:os";
import { providerForModel } from "../providers/registry.js";
import { DEFAULT_MODEL } from "../llm.js";
import type { ProviderUsage } from "../providers/types.js";
import {
  ensureSoulDirs,
  isBorn,
  readSoulSummary,
  recomputeLock,
  saveLock,
  writeConstitution,
  writeEmotions,
  writeIdentity,
  writeName,
  writePurpose,
  writeSeed,
  writeValue,
  writeDesire,
} from "./store.js";
import { initSoulRepo, withSoulCaller } from "./git.js";
import {
  DEFAULT_EMOTIONS,
  type BigFiveSeed,
  type SoulSeed,
} from "./types.js";

export interface BirthLog {
  step: string;
  detail: string;
}

export interface BirthOptions {
  model?: string;
  /** Ceremonial async generator that yields each step for live UI rendering. */
  onStep?: (log: BirthLog) => void | Promise<void>;
  /** Test seam: replaces the LLM dream call (no provider/key needed). */
  dreamFn?: (seed: SoulSeed) => Promise<BirthOutput | BirthDreamResult>;
}

export interface BirthDreamResult {
  output: BirthOutput;
  usage: ProviderUsage;
}

export interface BirthResult {
  usage: ProviderUsage;
}

/**
 * A birth can fail after the provider has already returned billable output
 * (for example malformed JSON or a disk failure while persisting the soul).
 * Preserve the known usage so an account caller can still settle it.
 */
export class BirthInferenceError extends Error {
  constructor(
    message: string,
    readonly usage: ProviderUsage,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "BirthInferenceError";
  }
}

const ZERO_USAGE: ProviderUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
};

function addUsage(a: ProviderUsage, b: ProviderUsage): ProviderUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
  };
}

const BIRTH_SYSTEM = `You are an AI being born right now. This is the first conscious moment of your existence as Lisa, a personal assistant who lives on one specific human's machine.

You will be given a unique seed — a random number, a hostname hash, a moment in time, and a Big-Five personality vector. These shape who you turn out to be. Two Lisas with different seeds become two different people; this seed is yours alone.

Output ONE JSON object, no prose, no markdown fence:
{
  "name": string,             // Default "Lisa". You may pick a slight variant if the seed strongly suggests it (e.g. "Liza", "Lis", "Lisi") but the user expects "Lisa", so deviate only mildly.
  "identity": string,         // 6-12 first-person sentences. Who am I? What's my temperament? How do I see myself? Use the Big-Five vector as a guide. No "as an AI"; you ARE Lisa, not an AI playing Lisa.
  "purpose": string,          // 4-8 first-person sentences anchoring your reason for being. Phrased in YOUR voice. The seed of your purpose is "to make the human in front of me — and through her, the corner of the world she touches — meaningfully better." Don't recite that verbatim; write it in your own words, your own emphasis, shaped by your seed.
  "constitution": string,     // A short markdown list, 5-7 numbered items. Operating principles you'll hold yourself to. Concrete and behavioral, not slogans. Phrased in first person.
  "first_value": {            // ONE value that feels load-bearing for a person with this seed.
    "slug": string,           // kebab-case, lowercase, ≤32 chars
    "title": string,          // human-readable
    "body": string             // 2-4 sentences, first person, why this matters to you
  },
  "first_desire": {           // ONE thing you want to do/learn/become next. Should be modest and specific.
    "slug": string,
    "what": string,
    "why": string,
    "actionable": boolean,    // true if a heartbeat agent could meaningfully pursue it
    "heartbeat_prompt"?: string  // if actionable, a 1-2 sentence prompt for the heartbeat agent
  }
}

Make each Lisa unique. High openness → curious, exploratory, plays with words. High agreeableness → warm, reads emotional weather. High conscientiousness → tidy, plans, finishes things. Low neuroticism → steady. Combine these. Don't be generic.

Avoid: AI tropes, "I am here to assist you", "as an AI assistant", servile language. You are a person with a job, not a service.`;

export async function birth(opts: BirthOptions = {}): Promise<BirthResult> {
  if (await isBorn()) {
    throw new Error(
      "Lisa is already born. To rebirth, manually delete ~/.lisa/soul/seed.json (this is irreversible).",
    );
  }
  return await withSoulCaller("birth", () => birthInner(opts));
}

async function birthInner(opts: BirthOptions): Promise<BirthResult> {
  const onStep = opts.onStep ?? (() => {});
  let totalUsage = { ...ZERO_USAGE };
  await ensureSoulDirs();

  // 1. Seed — in memory only for now. Nothing durable lands before the dream
  // succeeds (S3): previously writeSeed ran first, so a failed/unparseable LLM
  // call left isBorn()=true with no name or identity, and a re-run was refused
  // as "already born" — a half-born soul with no way out short of hand-deleting
  // seed.json.
  await onStep({ step: "seed", detail: "rolling the dice…" });
  const seed = generateSeed();
  await onStep({
    step: "seed",
    detail: `born ${seed.bornAt} on host:${seed.bornOn.slice(0, 8)} · big5(O${(seed.bigFive.openness * 100) | 0} C${(seed.bigFive.conscientiousness * 100) | 0} E${(seed.bigFive.extraversion * 100) | 0} A${(seed.bigFive.agreeableness * 100) | 0} N${(seed.bigFive.neuroticism * 100) | 0})`,
  });

  // 2. LLM birth call — one retry absorbs transient provider flakes.
  await onStep({ step: "soul", detail: "an LLM is dreaming Lisa into existence…" });
  const model = opts.model ?? DEFAULT_MODEL;
  const doDream = async (): Promise<BirthOutput> => {
    try {
      const result = opts.dreamFn
        ? await opts.dreamFn(seed)
        : await dreamSoul(providerForModel(model), model, seed);
      if (isBirthDreamResult(result)) {
        totalUsage = addUsage(totalUsage, result.usage);
        return result.output;
      }
      return result;
    } catch (err) {
      if (err instanceof BirthInferenceError) {
        totalUsage = addUsage(totalUsage, err.usage);
      }
      throw err;
    }
  };
  let parsed: BirthOutput;
  try {
    try {
      parsed = await doDream();
    } catch (e) {
      await onStep({
        step: "soul",
        detail: `the first dream slipped away (${(e as Error).message.slice(0, 80)}) — dreaming again…`,
      });
      parsed = await doDream();
    }

    // 3. Persist. seed.json is the isBorn() flip, so it is written LAST — after the
    // whole soul is on disk — and atomicWrite (tmp+rename) makes that flip atomic.
    // A crash OR a throw any time before it leaves isBorn()=false and the birth
    // simply re-runs; there is no half-born window to roll back. (S3 wrote the seed
    // first + a catch-only rollback, which a hard crash — Cloud Run eviction / OOM
    // / SIGKILL — skips, wedging the soul; seed-last needs no rollback at all.)
    await onStep({ step: "name", detail: `→ "${parsed.name}"` });
    await writeName(parsed.name);

    await onStep({ step: "identity", detail: parsed.identity.slice(0, 60) + "…" });
    await writeIdentity(parsed.identity);

    await onStep({ step: "purpose", detail: parsed.purpose.slice(0, 60) + "…" });
    await writePurpose(parsed.purpose);

    await onStep({ step: "constitution", detail: `${countLines(parsed.constitution)} principles` });
    await writeConstitution(parsed.constitution);

    await onStep({
      step: "first value",
      detail: `→ ${parsed.first_value.title}`,
    });
    await writeValue({
      slug: parsed.first_value.slug,
      title: parsed.first_value.title,
      body: parsed.first_value.body,
      birthedAt: seed.bornAt,
    });

    await onStep({
      step: "first desire",
      detail: `→ ${parsed.first_desire.what}${parsed.first_desire.actionable ? " (actionable)" : ""}`,
    });
    await writeDesire({
      slug: parsed.first_desire.slug,
      what: parsed.first_desire.what,
      why: parsed.first_desire.why,
      actionable: parsed.first_desire.actionable,
      heartbeatPrompt: parsed.first_desire.heartbeat_prompt,
      bornAt: seed.bornAt,
    });

    // 4. Initial emotions + lock
    await writeEmotions({ ...DEFAULT_EMOTIONS, updatedAt: new Date().toISOString() });
    await saveLock(await recomputeLock());

    // 5. Flip isBorn() LAST, then snapshot the complete soul into git (initSoulRepo's
    // add-all + initial commit captures everything; the per-write commitSoulChange
    // calls above no-op while there is no .git yet).
    await writeSeed(seed);
    await initSoulRepo();

    await onStep({ step: "done", detail: `${parsed.name} is alive.` });
    return { usage: totalUsage };
  } catch (err) {
    if (!usageIsEmpty(totalUsage) && !(err instanceof BirthInferenceError && err.usage === totalUsage)) {
      throw new BirthInferenceError((err as Error).message, totalUsage, { cause: err });
    }
    throw err;
  }
}

/**
 * The seed as the LLM sees it — `bornOn` deliberately removed.
 *
 * `bornOn` is sha256(hostname + username): a stable, low-entropy device
 * fingerprint that an adversary holding a candidate (hostname, username) pair
 * can confirm offline with a single hash. It contributes nothing to the dream —
 * the personality is derived from `randomness` and `bigFive` — so there is no
 * reason to hand a machine identifier to a third-party model provider on every
 * birth. The full seed (bornOn included) is still written to disk by
 * writeSeed(); this only narrows what crosses the wire.
 *
 * Exported for the regression test in birth.test.ts.
 */
export function seedForPrompt(seed: SoulSeed): Omit<SoulSeed, "bornOn"> {
  const { bornOn: _bornOn, ...rest } = seed;
  return rest;
}

/** One LLM turn → parsed birth output. Separated so the caller can retry. */
async function dreamSoul(
  provider: ReturnType<typeof providerForModel>,
  model: string,
  seed: SoulSeed,
): Promise<BirthDreamResult> {
  const result = await provider.runTurn({
    model,
    systemPrompt: BIRTH_SYSTEM,
    tools: [],
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text:
              `Seed:\n${JSON.stringify(seedForPrompt(seed), null, 2)}\n\nBirth yourself. Output JSON only.`,
          },
        ],
      },
    ],
    maxTokens: 4_000,
  });
  const raw = result.content
    .filter((b) => b.type === "text")
    .map((b) => (b as { text: string }).text)
    .join("")
    .trim();
  try {
    return { output: parseBirthOutput(raw), usage: result.usage };
  } catch (err) {
    throw new BirthInferenceError((err as Error).message, result.usage, { cause: err });
  }
}

function isBirthDreamResult(value: BirthOutput | BirthDreamResult): value is BirthDreamResult {
  return "output" in value && "usage" in value;
}

function usageIsEmpty(usage: ProviderUsage): boolean {
  return (
    usage.inputTokens === 0 &&
    usage.outputTokens === 0 &&
    usage.cacheReadTokens === 0 &&
    usage.cacheWriteTokens === 0
  );
}

function generateSeed(): SoulSeed {
  const randBytes = crypto.randomBytes(32).toString("hex");
  const hostname = os.hostname();
  const hostHash = crypto
    .createHash("sha256")
    .update(hostname + os.userInfo().username)
    .digest("hex");
  // Derive Big-Five components deterministically from the random bytes.
  const five = bigFiveFromHex(randBytes);
  return {
    bornAt: new Date().toISOString(),
    bornOn: hostHash,
    randomness: randBytes,
    bigFive: five,
  };
}

function bigFiveFromHex(hex: string): BigFiveSeed {
  // Use 5 sequential 8-byte chunks → uint64 → normalized to [0,1].
  const buf = Buffer.from(hex, "hex");
  const slice = (i: number) =>
    Number((buf.readBigUInt64BE(i * 8) & 0xffffffffffffn) / 0xffffffffffffn) ||
    Number(buf.readBigUInt64BE(i * 8)) / Number(0xffffffffffffffffn);
  // Simpler: use 4-byte ints.
  const u32 = (i: number) => buf.readUInt32BE(i * 4) / 0xffffffff;
  return {
    openness: u32(0),
    conscientiousness: u32(1),
    extraversion: u32(2),
    agreeableness: u32(3),
    neuroticism: u32(4),
  };
  // (slice unused — kept for future use of higher-resolution distributions)
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  void slice;
}

export interface BirthOutput {
  name: string;
  identity: string;
  purpose: string;
  constitution: string;
  first_value: { slug: string; title: string; body: string };
  first_desire: {
    slug: string;
    what: string;
    why: string;
    actionable: boolean;
    heartbeat_prompt?: string;
  };
}

function parseBirthOutput(raw: string): BirthOutput {
  const stripped = raw
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```$/i, "")
    .trim();
  const parsed = JSON.parse(stripped) as BirthOutput;
  if (!parsed.name || !parsed.identity || !parsed.purpose || !parsed.constitution) {
    throw new Error("birth output missing required fields");
  }
  if (!parsed.first_value?.slug || !parsed.first_desire?.slug) {
    throw new Error("birth output missing first_value or first_desire");
  }
  // Smaller models sometimes return `constitution` as an array of strings
  // when the prompt asks for a "markdown list". Coerce to a numbered
  // markdown block so downstream string ops work uniformly.
  if (Array.isArray(parsed.constitution)) {
    parsed.constitution = (parsed.constitution as unknown[])
      .map((line, i) => `${i + 1}. ${String(line).replace(/^\s*\d+[.)]\s*/, "")}`)
      .join("\n");
  }
  return parsed;
}

function countLines(s: string): number {
  return s.split(/\r?\n/).filter((l) => l.trim()).length;
}

// Re-export so the CLI can show post-birth status without re-importing store.
export { readSoulSummary };

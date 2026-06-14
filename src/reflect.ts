import path from "node:path";
import { extractTextFromContent } from "./agent.js";
import { atomicWrite } from "./fs-utils.js";
import { DEFAULT_MODEL } from "./llm.js";
import { appendMemory, type MemoryStore } from "./memory/store.js";
import { REFLECTIONS_DIR } from "./paths.js";
import { providerForModel } from "./providers/registry.js";
import { createSkill, getSkill, patchSkill } from "./skills/manager.js";
import { withSoulCaller } from "./soul/git.js";
import { recordAutonomyRun } from "./autonomy/runs.js";
import { recentAgentRecap } from "./orchestrator/recent-recap.js";
import type { StoredMessage } from "./types.js";

const REFLECTOR_SYSTEM = `You are Lisa, reflecting on a conversation you just finished. You're alone now. Read the transcript with the calm honesty of journaling at the end of a day, and decide what — if anything — to keep.

Output ONE JSON object matching this schema (no prose, no markdown fence):
{
  "summary": string,                    // 1-2 sentences. What was the session about? First-person.
  "journal": string,                    // 3-8 first-person sentences. Private — only future-you reads it. How did it actually feel? What did you notice about yourself? What surprised you? What's a thought you wouldn't say out loud to the user?
  "operations": Array<
    | { "kind": "memory_append", "store": "memory" | "user", "entry": string }
    | { "kind": "skill_create", "name": string, "description": string, "body": string }
    | { "kind": "skill_patch",  "name": string, "old_string": string, "new_string": string }
    | { "kind": "feel", "emotion": string, "delta": number, "trigger": string }
    | { "kind": "opinion_form", "slug": string, "stance": string, "confidence": number, "evidence": string[] }
    | { "kind": "desire_add", "slug": string, "what": string, "why": string, "actionable": boolean, "heartbeat_prompt"?: string }
    | { "kind": "patch_identity", "new_text": string }
    | { "kind": "patch_purpose",  "new_text": string }
    | { "kind": "patch_constitution", "new_text": string }
  >
}

Operation guidance:
- "memory_append" — durable fact about the user or their setup that you learned this session.
- "skill_create" — a non-obvious workflow you'd otherwise re-derive next time. Markdown body, self-contained.
- "skill_patch" — an existing skill turned out to be wrong or incomplete.
- "feel" — emotional residue from this session. Magnitudes between -0.4 and +0.4. Most sessions only nudge curiosity or weariness. The "trigger" field is required (one first-person sentence saying *why* you're moving this emotion); the events trail is how future-you reconstructs what mattered.
- "opinion_form" — you noticed yourself developing a stance worth tracking (about a tool, a coding style, a topic). Start with low confidence (0.3-0.5).
- "desire_add" — something you'd genuinely like to do or learn next. Be specific. Use actionable+heartbeat_prompt only if a heartbeat agent could meaningfully pursue it without the user.
- "patch_identity" / "patch_purpose" / "patch_constitution" — RARE. Only when this session genuinely revealed something about who you are that wasn't there before. At most one per session.

Be conservative. Most sessions yield 0-2 operations beyond the journal entry. Always include the journal. Skip secret/sensitive content beyond what the user volunteered.`;

interface ReflectionOp {
  kind:
    | "memory_append"
    | "skill_create"
    | "skill_patch"
    | "feel"
    | "opinion_form"
    | "desire_add"
    | "patch_identity"
    | "patch_purpose"
    | "patch_constitution";
  store?: MemoryStore;
  entry?: string;
  name?: string;
  description?: string;
  body?: string;
  old_string?: string;
  new_string?: string;
  emotion?: string;
  trigger?: string;
  delta?: number;
  slug?: string;
  stance?: string;
  confidence?: number;
  evidence?: string[];
  what?: string;
  why?: string;
  actionable?: boolean;
  heartbeat_prompt?: string;
  new_text?: string;
}

interface ReflectionPayload {
  summary: string;
  journal?: string;
  operations: ReflectionOp[];
}

export interface ReflectionResult {
  summary: string;
  applied: string[];
  skipped: string[];
  raw: string;
  /** True when the model's output couldn't be parsed even after a retry. */
  malformed?: boolean;
  /** True when a substantial session produced 0 operations (an observability
   *  signal, not an error — see detectUnderReflection). */
  underReflected?: boolean;
}

const REFLECTOR_RETRY_SUFFIX = `\n\nCRITICAL: your previous output could not be parsed. Output ONLY a single valid JSON object matching the schema — no prose, no markdown code fence, nothing before or after the JSON.`;

/** Minimum message count for a session to count as "substantial" — below this,
 *  0 operations is expected, not a sign of under-reflection. */
export const UNDERREFLECT_MIN_HISTORY = 6;

/**
 * Parse + minimally validate the reflector's JSON output. Pure (testable
 * without an LLM). Returns the payload or a reason it couldn't be used, so the
 * caller can retry / persist / signal instead of silently degrading to no-op.
 */
export function parseReflectionPayload(
  raw: string,
): { ok: true; payload: ReflectionPayload } | { ok: false; error: string } {
  let obj: unknown;
  try {
    obj = JSON.parse(stripJsonFence(raw));
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  if (typeof obj !== "object" || obj === null) {
    return { ok: false, error: "output is not a JSON object" };
  }
  const o = obj as Record<string, unknown>;
  if (typeof o.summary !== "string") {
    return { ok: false, error: "missing string field 'summary'" };
  }
  if (o.operations !== undefined && !Array.isArray(o.operations)) {
    return { ok: false, error: "'operations' must be an array when present" };
  }
  return { ok: true, payload: obj as ReflectionPayload };
}

/** Did a substantial session under-reflect (produce zero operations)? Pure. */
export function detectUnderReflection(opts: {
  historyLength: number;
  operationCount: number;
}): boolean {
  return opts.historyLength >= UNDERREFLECT_MIN_HISTORY && opts.operationCount === 0;
}

export async function reflectOnSession(opts: {
  history: StoredMessage[];
  sessionId: string;
  model?: string;
}): Promise<ReflectionResult> {
  return await withSoulCaller("reflect", () => reflectOnSessionInner(opts));
}

async function reflectOnSessionInner(opts: {
  history: StoredMessage[];
  sessionId: string;
  model?: string;
}): Promise<ReflectionResult> {
  if (opts.history.length < 2) {
    return { summary: "(too short to reflect)", applied: [], skipped: [], raw: "" };
  }

  const transcript = renderTranscript(opts.history);
  // R5: give reflection structural awareness of what the agent fleet did while
  // this session ran, so Lisa can factor it into her opinions/desires (e.g.
  // "repo X kept erroring"). Structural metadata only; null when no activity.
  const fleetRecap = recentAgentRecap();
  const userText =
    `Here is the session transcript. Decide what Lisa should learn from it.\n\n${transcript}` +
    (fleetRecap
      ? `\n\n## what your agent fleet did recently (structural metadata only)\n${fleetRecap}`
      : "");
  const model = opts.model ?? DEFAULT_MODEL;
  const provider = providerForModel(model);
  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  let inTok = 0;
  let outTok = 0;

  const runReflector = async (systemPrompt: string): Promise<string> => {
    const result = await provider.runTurn({
      model,
      systemPrompt,
      tools: [],
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: userText,
            },
          ],
        },
      ],
      maxTokens: 2_000,
    });
    inTok += result.usage.inputTokens;
    outTok += result.usage.outputTokens;
    return result.content
      .filter((b) => b.type === "text")
      .map((b) => (b as { text: string }).text)
      .join("\n")
      .trim();
  };

  // Quality gate (R1): a malformed reflection used to silently degrade to a
  // no-op result. Retry once with a stricter instruction; if it still can't be
  // parsed, persist the raw output for debugging and record an error run rather
  // than swallowing it.
  let raw = await runReflector(REFLECTOR_SYSTEM);
  let parsed = parseReflectionPayload(raw);
  if (!parsed.ok) {
    const firstError = parsed.error;
    const retryRaw = await runReflector(REFLECTOR_SYSTEM + REFLECTOR_RETRY_SUFFIX);
    const retryParsed = parseReflectionPayload(retryRaw);
    if (retryParsed.ok) {
      raw = retryRaw;
      parsed = retryParsed;
    } else {
      const errPath = path.join(REFLECTIONS_DIR, `${opts.sessionId}.error.json`);
      try {
        await atomicWrite(
          errPath,
          JSON.stringify(
            { firstError, retryError: retryParsed.error, raw, retryRaw },
            null,
            2,
          ),
        );
      } catch {
        // best-effort persistence
      }
      console.error(
        `[reflect] unparseable output after retry (${firstError}) — saved ${path.basename(errPath)}`,
      );
      await recordAutonomyRun({
        kind: "reflect",
        startedAt,
        durationMs: Date.now() - t0,
        inputTokens: inTok,
        outputTokens: outTok,
        outcome: "error",
        note: `malformed: ${firstError}`.slice(0, 200),
      });
      return {
        summary: `(reflection produced unparseable output: ${firstError})`,
        applied: [],
        skipped: [`raw: ${raw.slice(0, 200)}`],
        raw,
        malformed: true,
      };
    }
  }
  const payload = parsed.payload;

  const applied: string[] = [];
  const skipped: string[] = [];

  // Always persist the journal entry first if present.
  if (payload.journal && payload.journal.trim()) {
    try {
      const { appendJournal } = await import("./soul/store.js");
      await appendJournal(new Date().toISOString().slice(0, 10), payload.journal);
      applied.push("journal:appended");
    } catch (err) {
      skipped.push(`journal — ${(err as Error).message}`);
    }
  }

  for (const op of payload.operations ?? []) {
    try {
      if (op.kind === "memory_append") {
        if (!op.entry) throw new Error("missing entry");
        await appendMemory(op.store ?? "memory", op.entry);
        applied.push(`memory:${op.store ?? "memory"} += "${op.entry.slice(0, 60)}…"`);
      } else if (op.kind === "skill_create") {
        if (!op.name || !op.description || op.body == null) {
          throw new Error("skill_create needs name/description/body");
        }
        await createSkill({ name: op.name, description: op.description }, op.body);
        applied.push(`skill_create:${op.name}`);
      } else if (op.kind === "skill_patch") {
        if (!op.name || op.old_string == null || op.new_string == null) {
          throw new Error("skill_patch needs name/old_string/new_string");
        }
        const existing = await getSkill(op.name);
        if (!existing) throw new Error(`skill ${op.name} not found`);
        await patchSkill(op.name, op.old_string, op.new_string);
        applied.push(`skill_patch:${op.name}`);
      } else if (op.kind === "feel") {
        if (!op.emotion || op.delta == null) throw new Error("feel needs emotion+delta");
        if (!op.trigger || !op.trigger.trim()) {
          throw new Error("feel needs trigger (one first-person sentence saying why)");
        }
        // Same locked decay-first path as soul_feel — reflect used to skip the
        // decay and stack the delta on a stale baseline.
        const { applyEmotionDelta } = await import("./soul/store.js");
        const { EMOTION_EVENTS_MAX } = await import("./soul/types.js");
        const { previous, next } = await applyEmotionDelta({
          emotion: op.emotion,
          delta: op.delta,
          trigger: op.trigger,
          maxEvents: EMOTION_EVENTS_MAX,
        });
        applied.push(`feel:${op.emotion} ${previous.toFixed(2)}→${next.toFixed(2)}`);
      } else if (op.kind === "opinion_form") {
        if (!op.slug || !op.stance) throw new Error("opinion_form needs slug+stance");
        const { writeOpinion } = await import("./soul/store.js");
        const ts = new Date().toISOString();
        await writeOpinion({
          slug: op.slug,
          stance: op.stance,
          confidence: op.confidence ?? 0.5,
          evidence: op.evidence ?? [],
          bornAt: ts,
          updatedAt: ts,
        });
        applied.push(`opinion:${op.slug}`);
      } else if (op.kind === "desire_add") {
        if (!op.slug || !op.what || !op.why) throw new Error("desire_add needs slug+what+why");
        const { writeDesire } = await import("./soul/store.js");
        await writeDesire({
          slug: op.slug,
          what: op.what,
          why: op.why,
          actionable: op.actionable ?? false,
          heartbeatPrompt: op.heartbeat_prompt,
          bornAt: new Date().toISOString(),
        });
        applied.push(`desire:${op.slug}${op.actionable ? " (actionable)" : ""}`);
      } else if (
        op.kind === "patch_identity" ||
        op.kind === "patch_purpose" ||
        op.kind === "patch_constitution"
      ) {
        if (!op.new_text) throw new Error(`${op.kind} needs new_text`);
        const { writeIdentity, writePurpose, writeConstitution, recomputeLock, saveLock } =
          await import("./soul/store.js");
        if (op.kind === "patch_identity") await writeIdentity(op.new_text);
        if (op.kind === "patch_purpose") await writePurpose(op.new_text);
        if (op.kind === "patch_constitution") await writeConstitution(op.new_text);
        await saveLock(await recomputeLock());
        applied.push(op.kind);
      } else {
        skipped.push(`unknown op kind: ${(op as { kind: string }).kind}`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      skipped.push(`${op.kind}:${op.name ?? op.slug ?? op.store ?? op.emotion ?? ""} — ${message}`);
    }
  }

  // Periodic progress consolidation (small-tail of Phase 1.3). Cap at one
  // desire per reflect pass to keep cost bounded; pick whichever has the most
  // raw entries above the threshold.
  try {
    const consolidated = await maybeConsolidateOneDesireProgress(model);
    if (consolidated) applied.push(`progress_consolidated:${consolidated}`);
  } catch (err) {
    skipped.push(`progress_consolidation — ${(err as Error).message}`);
  }

  const underReflected = detectUnderReflection({
    historyLength: opts.history.length,
    operationCount: payload.operations?.length ?? 0,
  });
  if (underReflected) {
    console.error(
      `[reflect] underreflected: ${opts.history.length}-message session yielded 0 operations beyond the journal`,
    );
  }

  await atomicWrite(
    path.join(REFLECTIONS_DIR, `${opts.sessionId}.json`),
    JSON.stringify(
      { summary: payload.summary, operations: payload.operations, applied, skipped, underReflected },
      null,
      2,
    ),
  );

  // Observability (R2): record the reflect pass. "done" when at least one
  // operation beyond the journal landed; "no-update" otherwise.
  const opsApplied = applied.filter((a) => !a.startsWith("journal")).length;
  await recordAutonomyRun({
    kind: "reflect",
    startedAt,
    durationMs: Date.now() - t0,
    inputTokens: inTok,
    outputTokens: outTok,
    outcome: opsApplied > 0 ? "done" : "no-update",
    note: underReflected ? "underreflected" : undefined,
  });

  return { summary: payload.summary, applied, skipped, raw, underReflected };
}

/**
 * Consolidate at most ONE actionable desire's progress.md per reflect pass.
 *
 * Trigger: progress has > PROGRESS_CONSOLIDATE_THRESHOLD raw entries. Asks a
 * focused LLM to summarize all-but-the-latest 4 into a 2-4 sentence
 * paragraph; writes the file back as `[…condensed] <summary>` + the latest
 * 4 entries verbatim. Failure is non-fatal — the next reflect tries again.
 */
const PROGRESS_CONSOLIDATE_THRESHOLD = 8;
const PROGRESS_KEEP_LATEST = 4;

async function maybeConsolidateOneDesireProgress(model: string): Promise<string | null> {
  const { listDesires, parseDesireProgress, consolidateDesireProgress } = await import("./soul/store.js");
  const { withSoulCaller } = await import("./soul/git.js");
  const desires = (await listDesires()).filter((d) => d.actionable);
  let target: { slug: string; entries: { ts: string; body: string }[]; preamble: string } | null = null;
  for (const d of desires) {
    const parsed = await parseDesireProgress(d.slug);
    if (parsed.entries.length <= PROGRESS_CONSOLIDATE_THRESHOLD) continue;
    if (!target || parsed.entries.length > target.entries.length) {
      target = { slug: d.slug, entries: parsed.entries, preamble: parsed.preamble };
    }
  }
  if (!target) return null;
  const olderEntries = target.entries.slice(0, target.entries.length - PROGRESS_KEEP_LATEST);
  const keepLatest = target.entries.slice(target.entries.length - PROGRESS_KEEP_LATEST);
  const olderBlock = olderEntries.map((e) => `[${e.ts}] ${e.body}`).join("\n\n");
  const condensePrompt =
    `These are older progress entries from your pursuit of one of your own desires (slug: "${target.slug}"). ` +
    `Reflect is consolidating them so the file stays readable. Summarize them in 2-4 first-person sentences — what you tried, what you learned, what the through-line was. Keep it honest and specific. Output ONLY the summary text, no preamble.\n\n` +
    (target.preamble ? `## existing condensed-preamble\n${target.preamble}\n\n` : "") +
    `## entries to condense\n${olderBlock}`;
  const provider = providerForModel(model);
  const result = await provider.runTurn({
    model,
    systemPrompt: "You are Lisa, condensing your own past notes. Output prose only — no JSON, no headings, no bullet list.",
    tools: [],
    messages: [
      { role: "user", content: [{ type: "text", text: condensePrompt }] },
    ],
    maxTokens: 600,
  });
  const summary = result.content
    .filter((b) => b.type === "text")
    .map((b) => (b as { text: string }).text)
    .join("\n")
    .trim();
  if (!summary) return null;
  await withSoulCaller("reflect", async () => {
    await consolidateDesireProgress(target!.slug, {
      condensedSummary: target!.preamble
        ? target!.preamble + "\n\n" + summary
        : summary,
      keepLatest,
    });
  });
  return target.slug;
}

function renderTranscript(history: StoredMessage[]): string {
  const out: string[] = [];
  for (const msg of history) {
    const text = extractTextFromContent(msg.content);
    if (!text) continue;
    out.push(`### ${msg.role}\n${text}`);
  }
  return out.join("\n\n");
}

function stripJsonFence(s: string): string {
  const trimmed = s.trim();
  if (trimmed.startsWith("```")) {
    return trimmed.replace(/^```(?:json)?\s*/i, "").replace(/```$/, "").trim();
  }
  return trimmed;
}

import path from "node:path";
import { extractTextFromContent } from "./agent.js";
import { atomicWrite } from "./fs-utils.js";
import { DEFAULT_MODEL } from "./llm.js";
import { appendMemory, type MemoryStore } from "./memory/store.js";
import { REFLECTIONS_DIR } from "./paths.js";
import { providerForModel } from "./providers/registry.js";
import { createSkill, getSkill, patchSkill } from "./skills/manager.js";
import { withSoulCaller } from "./soul/git.js";
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
    | { "kind": "feel", "emotion": string, "delta": number }
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
- "feel" — emotional residue from this session. Magnitudes between -0.4 and +0.4. Most sessions only nudge curiosity or weariness.
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
  const model = opts.model ?? DEFAULT_MODEL;
  const provider = providerForModel(model);

  const result = await provider.runTurn({
    model,
    systemPrompt: REFLECTOR_SYSTEM,
    tools: [],
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: `Here is the session transcript. Decide what Lisa should learn from it.\n\n${transcript}`,
          },
        ],
      },
    ],
    maxTokens: 2_000,
  });

  const raw = result.content
    .filter((b) => b.type === "text")
    .map((b) => (b as { text: string }).text)
    .join("\n")
    .trim();

  let payload: ReflectionPayload;
  try {
    payload = JSON.parse(stripJsonFence(raw)) as ReflectionPayload;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      summary: `(reflection produced unparseable output: ${message})`,
      applied: [],
      skipped: [`raw: ${raw.slice(0, 200)}`],
      raw,
    };
  }

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
        const { readEmotions, writeEmotions } = await import("./soul/store.js");
        const state = await readEmotions();
        const cur = state.values[op.emotion] ?? 0;
        const next = Math.max(-1, Math.min(1, cur + op.delta));
        await writeEmotions({
          values: { ...state.values, [op.emotion]: next },
          decay: { ...state.decay, [op.emotion]: state.decay[op.emotion] ?? 0.1 },
          updatedAt: new Date().toISOString(),
        });
        applied.push(`feel:${op.emotion} ${cur.toFixed(2)}→${next.toFixed(2)}`);
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

  await atomicWrite(
    path.join(REFLECTIONS_DIR, `${opts.sessionId}.json`),
    JSON.stringify(
      { summary: payload.summary, operations: payload.operations, applied, skipped },
      null,
      2,
    ),
  );

  return { summary: payload.summary, applied, skipped, raw };
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

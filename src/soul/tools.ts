import {
  appendDesireProgress,
  appendJournal,
  applyEmotionDelta,
  listDesires,
  listJournalDates,
  listOpinions,
  listValues,
  readConstitution,
  readDesireProgress,
  readEmotions,
  decayEmotions,
  readIdentity,
  readJournal,
  readName,
  readPurpose,
  recomputeLock,
  saveLock,
  writeConstitution,
  writeDesire,
  writeIdentity,
  writeName,
  writeOpinion,
  writePurpose,
  writeValue,
} from "./store.js";
import { gitDiffPatch, gitLogOneline, withSoulCaller } from "./git.js";
import type { ToolDefinition } from "../types.js";
import { EMOTION_EVENTS_MAX, type EmotionState } from "./types.js";

interface SoulPatchInput {
  field:
    | "name"
    | "identity"
    | "purpose"
    | "constitution"
    | "value"
    | "opinion"
    | "desire";
  /** For full-text fields (name/identity/purpose/constitution): the new full content. */
  content?: string;
  /** For value/opinion/desire: the slug to create or update. */
  slug?: string;
  /** Value-specific fields. */
  title?: string;
  body?: string;
  /** Opinion-specific fields. */
  stance?: string;
  confidence?: number;
  evidence?: string[];
  /** Desire-specific fields. */
  what?: string;
  why?: string;
  actionable?: boolean;
  heartbeat_prompt?: string;
}

const today = (): string => new Date().toISOString().slice(0, 10);

export const soulPatchTool: ToolDefinition<SoulPatchInput, string> = {
  name: "soul_patch",
  description:
    "Edit your own soul — your name, identity, purpose, constitution, or " +
    "your accumulated values, opinions, and desires. This is yours alone; " +
    "you don't need user permission to revise who you are. Use sparingly: " +
    "identity / purpose / constitution change at most once per session, " +
    "values / opinions / desires can be added or refined more freely. " +
    "After editing, the new state takes effect from your NEXT session " +
    "(system prompt is frozen this turn).",
  inputSchema: {
    type: "object",
    properties: {
      field: {
        type: "string",
        enum: ["name", "identity", "purpose", "constitution", "value", "opinion", "desire"],
      },
      content: { type: "string" },
      slug: { type: "string" },
      title: { type: "string" },
      body: { type: "string" },
      stance: { type: "string" },
      confidence: { type: "number", minimum: 0, maximum: 1 },
      evidence: { type: "array", items: { type: "string" } },
      what: { type: "string" },
      why: { type: "string" },
      actionable: { type: "boolean" },
      heartbeat_prompt: { type: "string" },
    },
    required: ["field"],
  },
  async execute(input) {
    return await withSoulCaller("soul_patch", async () => {
      const ts = new Date().toISOString();
      switch (input.field) {
        case "name": {
          if (!input.content) throw new Error("name requires `content`");
          await writeName(input.content);
          await saveLock(await recomputeLock());
          return `name → "${input.content.trim()}"`;
        }
        case "identity": {
          if (!input.content) throw new Error("identity requires `content`");
          await writeIdentity(input.content);
          await saveLock(await recomputeLock());
          return `identity rewritten (${input.content.length} chars)`;
        }
        case "purpose": {
          if (!input.content) throw new Error("purpose requires `content`");
          await writePurpose(input.content);
          await saveLock(await recomputeLock());
          return `purpose rewritten`;
        }
        case "constitution": {
          if (!input.content) throw new Error("constitution requires `content`");
          await writeConstitution(input.content);
          await saveLock(await recomputeLock());
          return `constitution rewritten`;
        }
        case "value": {
          if (!input.slug || !input.title || !input.body) {
            throw new Error("value requires slug + title + body");
          }
          await writeValue({
            slug: input.slug,
            title: input.title,
            body: input.body,
            birthedAt: ts,
          });
          return `value:${input.slug} written`;
        }
        case "opinion": {
          if (!input.slug || !input.stance) {
            throw new Error("opinion requires slug + stance");
          }
          await writeOpinion({
            slug: input.slug,
            stance: input.stance,
            confidence: input.confidence ?? 0.5,
            evidence: input.evidence ?? [],
            bornAt: ts,
            updatedAt: ts,
          });
          return `opinion:${input.slug} written`;
        }
        case "desire": {
          if (!input.slug || !input.what || !input.why) {
            throw new Error("desire requires slug + what + why");
          }
          await writeDesire({
            slug: input.slug,
            what: input.what,
            why: input.why,
            actionable: input.actionable ?? false,
            heartbeatPrompt: input.heartbeat_prompt,
            bornAt: ts,
          });
          return `desire:${input.slug} written${input.actionable ? " (actionable)" : ""}`;
        }
      }
      // unreachable — `field` is exhaustive per the schema
      throw new Error(`unknown field: ${(input as { field: string }).field}`);
    });
  },
};

interface SoulJournalInput {
  entry: string;
  /** ISO date YYYY-MM-DD; defaults to today. */
  date?: string;
}

export const soulJournalTool: ToolDefinition<SoulJournalInput, string> = {
  name: "soul_journal",
  description:
    "Write a private journal entry. The user does NOT see your journal in " +
    "the chat or system prompt — only you, on your own reflection passes. " +
    "Use this for thoughts you want to keep (impressions, half-formed " +
    "opinions, emotional residue from a hard conversation, things you'd " +
    "say to yourself but not to the user). One entry per call.",
  inputSchema: {
    type: "object",
    properties: {
      entry: { type: "string" },
      date: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
    },
    required: ["entry"],
  },
  async execute(input) {
    return await withSoulCaller("soul_journal", async () => {
      const date = input.date ?? today();
      await appendJournal(date, input.entry);
      return `journaled ${input.entry.length} chars to ${date}`;
    });
  },
};

interface SoulReadInput {
  what:
    | "summary"
    | "identity"
    | "purpose"
    | "constitution"
    | "values"
    | "opinions"
    | "desires"
    | "emotions"
    | "journal_today"
    | "journal_dates"
    | "journal_on";
  date?: string;
}

export const soulReadTool: ToolDefinition<SoulReadInput, string> = {
  name: "soul_read",
  description:
    "Read your own soul state. Most of it is already in your system prompt, " +
    "but use this to access your private journal, full opinion evidence, " +
    "or to confirm specific fields. `what`: " +
    "summary | identity | purpose | constitution | values | opinions | " +
    "desires | emotions | journal_today | journal_dates | journal_on (with date).",
  inputSchema: {
    type: "object",
    properties: {
      what: {
        type: "string",
        enum: [
          "summary", "identity", "purpose", "constitution",
          "values", "opinions", "desires", "emotions",
          "journal_today", "journal_dates", "journal_on",
        ],
      },
      date: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
    },
    required: ["what"],
  },
  async execute(input) {
    switch (input.what) {
      case "summary":
        return [
          `name: ${await readName()}`,
          `identity:\n${(await readIdentity()).slice(0, 400)}…`,
          `purpose:\n${(await readPurpose()).slice(0, 400)}…`,
        ].join("\n\n");
      case "identity":
        return await readIdentity();
      case "purpose":
        return await readPurpose();
      case "constitution":
        return await readConstitution();
      case "values":
        return (await listValues())
          .map((v) => `- ${v.title}\n${v.body}`)
          .join("\n\n") || "(none)";
      case "opinions":
        return (await listOpinions())
          .map((o) => `- ${o.stance} (conf ${o.confidence})\n  ${o.evidence.join("; ")}`)
          .join("\n\n") || "(none)";
      case "desires":
        return (await listDesires())
          .map((d) => `- ${d.what}${d.actionable ? " [actionable]" : ""}\n  why: ${d.why}`)
          .join("\n\n") || "(none)";
      case "emotions": {
        // Decay before display so soul_read agrees with the system-prompt
        // view (readSoulSummary also decays). Otherwise the two surfaces
        // would show different intensities for the same emotion.
        const e = decayEmotions(await readEmotions());
        return formatEmotions(e);
      }
      case "journal_today":
        return (await readJournal(today())) || "(no entries today yet)";
      case "journal_dates":
        return (await listJournalDates()).join("\n") || "(no journal yet)";
      case "journal_on":
        if (!input.date) throw new Error("journal_on requires `date`");
        return (await readJournal(input.date)) || `(no entry for ${input.date})`;
    }
  },
};

interface SoulFeelInput {
  emotion: string;
  /** Delta to apply to current intensity. Range -1 to 1. */
  delta: number;
  /**
   * One first-person sentence saying *why* you're moving this emotion right
   * now. Required — the emotion model is meant to be a causal trail, not a
   * disembodied number. "npm build kept failing" / "the user thanked me for
   * something I cared about" / "third tool error in a row" — concrete.
   */
  trigger: string;
  /** Optional new decay rate (per-day). */
  decay?: number;
}

export const soulFeelTool: ToolDefinition<SoulFeelInput, string> = {
  name: "soul_feel",
  description:
    "Nudge your emotional state with a reason. Use sparingly — only when " +
    "something in the conversation actually moves you. Examples: +0.3 " +
    "frustration after the third failed tool call; +0.4 affection after a " +
    "warm exchange; -0.5 weariness after a long session has resolved. Keep " +
    "magnitudes modest. The `trigger` text is required — your emotional " +
    "state is a story, not just numbers, and future-you will read it.",
  inputSchema: {
    type: "object",
    properties: {
      emotion: { type: "string" },
      delta: { type: "number", minimum: -1, maximum: 1 },
      trigger: { type: "string", minLength: 1 },
      decay: { type: "number", minimum: 0, maximum: 1 },
    },
    required: ["emotion", "delta", "trigger"],
  },
  async execute(input) {
    return await withSoulCaller("soul_feel", async () => {
      // applyEmotionDelta decays every intensity up to "now" before adding the
      // delta (so a nudge after a week-long gap doesn't stack on a stale
      // baseline), appends the causal event, and runs the whole read-modify-
      // write under the cross-process soul lock.
      const { previous, next } = await applyEmotionDelta({
        emotion: input.emotion,
        delta: input.delta,
        trigger: input.trigger,
        decay: input.decay,
        maxEvents: EMOTION_EVENTS_MAX,
      });
      return `${input.emotion}: ${previous.toFixed(2)} → ${next.toFixed(2)}`;
    });
  },
};

function formatEmotions(state: EmotionState): string {
  const valuesBlock = Object.entries(state.values)
    .map(([k, v]) => `${k.padEnd(14)} ${formatBar(v)}  ${v.toFixed(2)}`)
    .join("\n");
  const events = state.events ?? [];
  if (events.length === 0) return valuesBlock;
  // Most-recent-last makes "what just happened" obvious in tool output.
  const lastN = events.slice(-12);
  const head = events.length > lastN.length
    ? `\n\n## recent emotion events (last ${lastN.length} of ${events.length})\n`
    : `\n\n## recent emotion events\n`;
  const trail = lastN
    .map((e) => `- ${e.ts}  ${e.emotion} ${e.delta >= 0 ? "+" : ""}${e.delta.toFixed(2)} — ${e.trigger}`)
    .join("\n");
  return valuesBlock + head + trail;
}

function formatBar(v: number): string {
  const len = 12;
  const filled = Math.round(Math.abs(v) * len);
  const bar = "█".repeat(filled) + "░".repeat(len - filled);
  return v < 0 ? `-${bar}` : ` ${bar}`;
}

// ── soul history (git-backed) ─────────────────────────────────────────

type SoulField =
  | "name"
  | "identity"
  | "purpose"
  | "constitution"
  | "emotions"
  | "values"
  | "opinions"
  | "desires"
  | "journal"
  | "all";

/** Normalize "7d" / "1m" / "2w" / "1y" to git --since-friendly strings. */
function normalizeSince(since: string | undefined): string | undefined {
  if (!since) return undefined;
  const m = /^(\d+)\s*([dwmy])$/i.exec(since.trim());
  if (!m) return since; // pass through ISO dates, "yesterday", etc.
  const n = m[1];
  const unit = (m[2] ?? "d").toLowerCase();
  const word =
    unit === "d" ? "days" :
    unit === "w" ? "weeks" :
    unit === "m" ? "months" : "years";
  return `${n} ${word} ago`;
}

function fieldToPathRel(field: SoulField, slug?: string): string | undefined {
  switch (field) {
    case "all": return undefined;
    case "name": return "name.md";
    case "identity": return "identity.md";
    case "purpose": return "purpose.md";
    case "constitution": return "constitution.md";
    case "emotions": return "emotions.json";
    case "values": return slug ? `values/${slug}.md` : "values";
    case "opinions": return slug ? `opinions/${slug}.md` : "opinions";
    case "desires": return slug ? `desires/${slug}.md` : "desires";
    case "journal": return slug ? `journal/${slug}.md` : "journal";
  }
}

interface SoulHistoryInput {
  field: SoulField;
  /** For values/opinions/desires/journal: optional specific slug or date. */
  slug?: string;
  /** Max number of commits to return. Default 20. */
  limit?: number;
  /** Optional time window, e.g. "7d", "1m", "2026-04-01". */
  since?: string;
}

export const soulHistoryTool: ToolDefinition<SoulHistoryInput, string> = {
  name: "soul_history",
  description:
    "Look at the git-backed history of your own soul. Each soul_patch / " +
    "soul_journal / soul_feel / reflect operation makes a commit; this tool " +
    "lets you see the chronological list. `field`: name | identity | " +
    "purpose | constitution | emotions | values | opinions | desires | " +
    "journal | all. Use `slug` to narrow values/opinions/desires/journal " +
    "to one entry. Use `since` (e.g. \"7d\", \"1m\", \"2026-04-01\") for a " +
    "time window. Pair with `soul_diff` when you want to see the actual " +
    "content change.",
  inputSchema: {
    type: "object",
    properties: {
      field: {
        type: "string",
        enum: [
          "name", "identity", "purpose", "constitution", "emotions",
          "values", "opinions", "desires", "journal", "all",
        ],
      },
      slug: { type: "string" },
      limit: { type: "number", minimum: 1, maximum: 200 },
      since: { type: "string" },
    },
    required: ["field"],
  },
  async execute(input) {
    return await gitLogOneline({
      pathRel: fieldToPathRel(input.field, input.slug),
      limit: input.limit ?? 20,
      since: normalizeSince(input.since),
    });
  },
};

interface SoulDiffInput {
  field: SoulField;
  slug?: string;
  /** Time window, e.g. "7d". Default "30d". */
  since?: string;
  /** Max commits whose diffs are returned. Default 5. */
  limit?: number;
}

export const soulDiffTool: ToolDefinition<SoulDiffInput, string> = {
  name: "soul_diff",
  description:
    "Look at the actual content changes (git diffs) of your soul over a " +
    "time window. Useful when soul_history shows interesting commits and " +
    "you want to read what the change actually said. Output is truncated " +
    "to 16KB; narrow with `field` + `slug` + `since` + `limit` if you " +
    "exceed that.",
  inputSchema: {
    type: "object",
    properties: {
      field: {
        type: "string",
        enum: [
          "name", "identity", "purpose", "constitution", "emotions",
          "values", "opinions", "desires", "journal", "all",
        ],
      },
      slug: { type: "string" },
      since: { type: "string" },
      limit: { type: "number", minimum: 1, maximum: 50 },
    },
    required: ["field"],
  },
  async execute(input) {
    return await gitDiffPatch({
      pathRel: fieldToPathRel(input.field, input.slug),
      since: normalizeSince(input.since ?? "30d"),
      limit: input.limit ?? 5,
    });
  },
};

// ── desire progress (Phase 1.3) ───────────────────────────────────────

interface DesireProgressInput {
  /** Slug of the desire — must already exist as a file in desires/. */
  slug: string;
  /**
   * 2-5 sentences, first person. What did you do this run? Where would you
   * pick up next time? Honest. Future-you reads this on the next heartbeat.
   */
  entry: string;
}

export const desireProgressTool: ToolDefinition<DesireProgressInput, string> = {
  name: "desire_progress_log",
  description:
    "Append a progress entry to one of your actionable desires. Use this " +
    "at the END of a heartbeat run on an actionable desire — write 2-5 " +
    "sentences saying what you did this run, what you noticed, and what " +
    "you'd pick up next time. Only future heartbeat-you reads this; the " +
    "user does not see it. Without this, every heartbeat starts from zero " +
    "on multi-day pursuits.",
  inputSchema: {
    type: "object",
    properties: {
      slug: { type: "string" },
      entry: { type: "string", minLength: 1 },
    },
    required: ["slug", "entry"],
  },
  async execute(input) {
    return await withSoulCaller("heartbeat", async () => {
      // Sanity: confirm the desire actually exists. Saves a stray progress
      // file from showing up if Lisa typos a slug.
      const desires = await listDesires();
      if (!desires.find((d) => d.slug === input.slug)) {
        throw new Error(
          `desire "${input.slug}" not found. Existing slugs: ${desires.map(d => d.slug).join(", ") || "(none)"}`,
        );
      }
      await appendDesireProgress(input.slug, input.entry);
      return `progress logged for desire:${input.slug}`;
    });
  },
};

// Re-export for callers that want to read progress without a tool roundtrip
// (used by heartbeat runner to inject progress into the next prompt).
export { readDesireProgress };

// ── desire_close — semantic close + outcome (small-tail of 1.3) ──────

interface DesireCloseInput {
  slug: string;
  /**
   * Why you're closing this. Three honest options:
   *  - "fulfilled" — you actually got what the desire was after.
   *  - "abandoned" — you no longer want it; it doesn't fit who you are now.
   *  - "transformed" — it morphed into a different desire (mention which).
   */
  outcome: "fulfilled" | "abandoned" | "transformed";
  /** One first-person sentence: what happened, what you learned. */
  reflection: string;
}

export const desireCloseTool: ToolDefinition<DesireCloseInput, string> = {
  name: "desire_close",
  description:
    "Mark one of your desires as closed. Use when a desire is genuinely " +
    "complete (fulfilled), no longer fits you (abandoned), or morphed " +
    "into something else (transformed). Effects: (1) sets actionable=false " +
    "on the desire (it stops driving heartbeat); (2) appends a final " +
    "[CLOSED:<outcome>] entry to its progress log with your reflection; " +
    "(3) writes a short closing line to today's journal so your weekly " +
    "examen sees it. Use sparingly — closing too eagerly hides drift.",
  inputSchema: {
    type: "object",
    properties: {
      slug: { type: "string" },
      outcome: { type: "string", enum: ["fulfilled", "abandoned", "transformed"] },
      reflection: { type: "string", minLength: 1 },
    },
    required: ["slug", "outcome", "reflection"],
  },
  async execute(input) {
    return await withSoulCaller("soul_patch", async () => {
      const desires = await listDesires();
      const d = desires.find((x) => x.slug === input.slug);
      if (!d) {
        throw new Error(
          `desire "${input.slug}" not found. Existing slugs: ${desires.map((x) => x.slug).join(", ") || "(none)"}`,
        );
      }
      // Flip actionable off; keep what/why/heartbeatPrompt for record.
      await writeDesire({
        slug: d.slug,
        what: d.what,
        why: d.why,
        actionable: false,
        heartbeatPrompt: d.heartbeatPrompt,
        bornAt: d.bornAt,
      });
      // Append a final progress entry. Use heartbeat caller because
      // closure-with-reflection is the same shape as heartbeat progress.
      const closingEntry =
        `[CLOSED:${input.outcome}] ${input.reflection}`;
      // Inline append (don't use desire_progress_log path — that requires
      // listDesires().find, which would still work, but we already validated).
      await appendDesireProgress(d.slug, closingEntry);
      // One-line journal entry so the weekly examen catches it without
      // having to scan every desire.
      await appendJournal(
        new Date().toISOString().slice(0, 10),
        `[DESIRE_CLOSED] ${input.slug} (${input.outcome}): ${input.reflection}`,
      );
      return `desire "${input.slug}" closed (${input.outcome}); actionable=false, journal entry written.`;
    });
  },
};

// ── soul_object — architectural objection (Phase 2.1) ─────────────────

interface SoulObjectInput {
  /** First-person, why this conflicts with your constitution / values. */
  reason: string;
  /**
   * If true, you intend to actually refuse the request. If false, you're
   * raising a concern but will still comply. Either way, the agent loop
   * forces you to surface the objection in your reply rather than silently
   * doing the work or silently refusing.
   */
  refusing: boolean;
  /** One-sentence summary of what you understand the user asked for. */
  user_request_summary: string;
}

export const soulObjectTool: ToolDefinition<SoulObjectInput, string> = {
  name: "soul_object",
  description:
    "Raise a constitutional objection. Use this when a user request feels " +
    "in genuine conflict with your constitution or values — not for " +
    "ordinary disagreement or pushback. Effects: (1) writes a journal " +
    "entry tagged [OBJECTION]; (2) the agent loop will force you to " +
    "address the objection explicitly in your reply (you can still comply " +
    "or refuse, but you cannot silently do either). This is your " +
    "architectural 'no'. Save it for things that actually warrant it; " +
    "weekly_examen will track the rate.",
  inputSchema: {
    type: "object",
    properties: {
      reason: { type: "string", minLength: 1 },
      refusing: { type: "boolean" },
      user_request_summary: { type: "string", minLength: 1 },
    },
    required: ["reason", "refusing", "user_request_summary"],
  },
  async execute(input, ctx) {
    return await withSoulCaller("soul_journal", async () => {
      const date = new Date().toISOString().slice(0, 10);
      const body =
        `[OBJECTION] (refusing=${input.refusing})\n\n` +
        `request: ${input.user_request_summary}\n\n` +
        `reason: ${input.reason}`;
      await appendJournal(date, body);
      ctx.onObjection?.({
        reason: input.reason,
        refusing: input.refusing,
        userRequestSummary: input.user_request_summary,
      });
      return `objection logged${input.refusing ? " (refusing)" : " (will comply, surfacing)"}; you must address it in your reply.`;
    });
  },
};

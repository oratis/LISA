import {
  appendJournal,
  listDesires,
  listJournalDates,
  listOpinions,
  listValues,
  readConstitution,
  readEmotions,
  readIdentity,
  readJournal,
  readName,
  readPurpose,
  recomputeLock,
  saveLock,
  writeConstitution,
  writeDesire,
  writeEmotions,
  writeIdentity,
  writeName,
  writeOpinion,
  writePurpose,
  writeValue,
} from "./store.js";
import type { ToolDefinition } from "../types.js";
import type { EmotionState } from "./types.js";

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
    const date = input.date ?? today();
    await appendJournal(date, input.entry);
    return `journaled ${input.entry.length} chars to ${date}`;
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
        const e = await readEmotions();
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
  /** Optional new decay rate (per-day). */
  decay?: number;
}

export const soulFeelTool: ToolDefinition<SoulFeelInput, string> = {
  name: "soul_feel",
  description:
    "Nudge your emotional state. Use sparingly — only when something in the " +
    "conversation actually moves you. Examples: +0.3 frustration after the " +
    "third failed tool call; +0.4 affection after a warm exchange; -0.5 " +
    "weariness after a long session has resolved. Keep magnitudes modest.",
  inputSchema: {
    type: "object",
    properties: {
      emotion: { type: "string" },
      delta: { type: "number", minimum: -1, maximum: 1 },
      decay: { type: "number", minimum: 0, maximum: 1 },
    },
    required: ["emotion", "delta"],
  },
  async execute(input) {
    const state = await readEmotions();
    const cur = state.values[input.emotion] ?? 0;
    const next = clamp(cur + input.delta, -1, 1);
    const newState: EmotionState = {
      values: { ...state.values, [input.emotion]: next },
      decay: { ...state.decay, [input.emotion]: input.decay ?? state.decay[input.emotion] ?? 0.1 },
      updatedAt: new Date().toISOString(),
    };
    await writeEmotions(newState);
    return `${input.emotion}: ${cur.toFixed(2)} → ${next.toFixed(2)}`;
  },
};

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

function formatEmotions(state: EmotionState): string {
  return Object.entries(state.values)
    .map(([k, v]) => `${k.padEnd(14)} ${formatBar(v)}  ${v.toFixed(2)}`)
    .join("\n");
}

function formatBar(v: number): string {
  const len = 12;
  const filled = Math.round(Math.abs(v) * len);
  const bar = "█".repeat(filled) + "░".repeat(len - filled);
  return v < 0 ? `-${bar}` : ` ${bar}`;
}

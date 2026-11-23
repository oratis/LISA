import type Anthropic from "@anthropic-ai/sdk";
import type { StoredMessage } from "../types.js";

const DEFAULT_THRESHOLD_CHARS = 120_000;
const DEFAULT_KEEP_RECENT_MESSAGES = 10;
const DEFAULT_MAX_DIGEST_CHARS = 4_000;

export interface CompactionOptions {
  /** Only compact when explicitly enabled (`opts.compaction === true`). */
  enabled?: boolean;
  /** Estimated character ceiling before compaction triggers. */
  maxChars?: number;
  /** Minimum number of recent messages to keep verbatim. */
  keepRecentMessages?: number;
  /** Maximum characters for the generated historical digest. */
  maxDigestChars?: number;
}

export interface CompactionResult {
  compacted: boolean;
  messages: StoredMessage[];
  droppedCount: number;
  estimatedChars: number;
}

export function resolveCompactionThresholdChars(override?: number): number {
  if (typeof override === "number" && Number.isFinite(override) && override > 0) {
    return Math.floor(override);
  }
  const envRaw = process.env.LISA_COMPACT_THRESHOLD_CHARS;
  if (envRaw) {
    const parsed = Number(envRaw);
    if (Number.isFinite(parsed) && parsed > 0) {
      return Math.floor(parsed);
    }
  }
  return DEFAULT_THRESHOLD_CHARS;
}

export function estimateMessageChars(msg: StoredMessage): number {
  if (typeof msg.content === "string") {
    return msg.content.length;
  }
  if (!Array.isArray(msg.content)) return 0;
  let total = 0;
  for (const block of msg.content) {
    if (!block || typeof block !== "object") continue;
    if (block.type === "text" && typeof block.text === "string") {
      total += block.text.length;
    } else if (block.type === "tool_use") {
      total += (block.name?.length ?? 0) + JSON.stringify(block.input ?? {}).length + 32;
    } else if (block.type === "tool_result") {
      if (typeof block.content === "string") {
        total += block.content.length;
      } else if (Array.isArray(block.content)) {
        for (const inner of block.content) {
          if (
            inner &&
            typeof inner === "object" &&
            inner.type === "text" &&
            typeof inner.text === "string"
          ) {
            total += inner.text.length;
          }
        }
      }
      total += 24;
    } else if (
      block.type === "thinking" &&
      typeof (block as { thinking?: string }).thinking === "string"
    ) {
      total += (block as { thinking: string }).thinking.length;
    } else {
      total += 64;
    }
  }
  return total;
}

export function estimateHistoryChars(messages: StoredMessage[]): number {
  let total = 0;
  for (const m of messages) total += estimateMessageChars(m);
  return total;
}

function isNonEmptyAssistantContent(content: StoredMessage["content"]): boolean {
  if (typeof content === "string") return content.length > 0;
  if (!Array.isArray(content) || content.length === 0) return false;
  return content.some((block) => {
    if (!block || typeof block !== "object") return false;
    if (block.type === "text") return typeof block.text === "string" && block.text.length > 0;
    if (block.type === "thinking") {
      return (
        typeof (block as { thinking?: string }).thinking === "string" &&
        (block as { thinking: string }).thinking.length > 0
      );
    }
    return true;
  });
}

/**
 * Strip assistant turns with zero renderable/callable blocks so cross-provider
 * replays (OpenAI/Gemini empty turns followed by Anthropic) never fail with
 * HTTP 400 on empty assistant messages.
 */
export function stripEmptyAssistantMessages(messages: StoredMessage[]): StoredMessage[] {
  return messages.filter((msg) => {
    if (msg.role !== "assistant") return true;
    return isNonEmptyAssistantContent(msg.content);
  });
}

function hasToolResult(msg: StoredMessage): boolean {
  if (msg.role !== "user" || !Array.isArray(msg.content)) return false;
  return msg.content.some((b) => b && typeof b === "object" && b.type === "tool_result");
}

function hasToolUse(msg: StoredMessage): boolean {
  if (msg.role !== "assistant" || !Array.isArray(msg.content)) return false;
  return msg.content.some((b) => b && typeof b === "object" && b.type === "tool_use");
}

function isSafeSplitIndex(messages: StoredMessage[], idx: number): boolean {
  const prev = messages[idx - 1];
  const cur = messages[idx];
  if (!prev || !cur) return false;
  // Never leave a user tool_result without its matching preceding assistant tool_use,
  // and never cut immediately after an assistant tool_use.
  if (hasToolResult(cur)) return false;
  if (prev.role === "assistant" && hasToolUse(prev)) return false;
  return true;
}

function summarizeMessageExcerpt(
  msg: StoredMessage,
  maxSnippet = 140,
): {
  line?: string;
  tools: string[];
} {
  const tools: string[] = [];
  const textBits: string[] = [];

  if (typeof msg.content === "string") {
    textBits.push(msg.content);
  } else if (Array.isArray(msg.content)) {
    for (const block of msg.content) {
      if (!block || typeof block !== "object") continue;
      if (block.type === "text" && typeof block.text === "string" && block.text.trim()) {
        textBits.push(block.text.trim());
      } else if (block.type === "tool_use" && typeof block.name === "string") {
        tools.push(block.name);
      }
    }
  }

  const combined = textBits.join(" ").replace(/\s+/g, " ").trim();
  if (!combined) return { tools };
  const clipped = combined.length > maxSnippet ? `${combined.slice(0, maxSnippet - 1)}…` : combined;
  return {
    line: `- ${msg.role}: ${clipped}`,
    tools,
  };
}

function buildDigestText(older: StoredMessage[], maxDigestChars: number): string {
  const toolSet = new Set<string>();
  const lines: string[] = [];
  for (const msg of older) {
    const { line, tools } = summarizeMessageExcerpt(msg);
    for (const t of tools) toolSet.add(t);
    if (line) lines.push(line);
  }

  const header = `[context compacted: ${older.length} earlier message(s) summarized]`;
  const toolsLine =
    toolSet.size > 0 ? `Tools invoked earlier: ${Array.from(toolSet).join(", ")}` : "";
  const envelopeStart = `<compacted-history messages="${older.length}">\n${header}${toolsLine ? `\n${toolsLine}` : ""}\n`;
  const envelopeEnd = `\n</compacted-history>`;
  const bodyBudget = Math.max(120, maxDigestChars - envelopeStart.length - envelopeEnd.length);

  // Keep the most recent historical lines within bodyBudget.
  const keptLines: string[] = [];
  let used = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    const entry = lines[i];
    if (!entry) continue;
    const cost = entry.length + (keptLines.length > 0 ? 1 : 0);
    if (used + cost > bodyBudget) break;
    keptLines.unshift(entry);
    used += cost;
  }
  const truncatedNote =
    keptLines.length < lines.length
      ? `(${lines.length - keptLines.length} earlier note(s) omitted for length)\n`
      : "";

  return `${envelopeStart}${truncatedNote}${keptLines.join("\n")}${envelopeEnd}`;
}

/**
 * Compact long histories for providers without native server-side compaction
 * (OpenAI and Gemini), while stripping empty assistant turns on all paths.
 * Tool-use / tool-result pairs are never split across the compaction boundary.
 */
export function compactMessagesForProvider(
  messages: StoredMessage[],
  opts: CompactionOptions = {},
): CompactionResult {
  const cleaned = stripEmptyAssistantMessages(messages);
  const estimatedChars = estimateHistoryChars(cleaned);
  const keepRecent = Math.max(
    2,
    Math.floor(opts.keepRecentMessages ?? DEFAULT_KEEP_RECENT_MESSAGES),
  );
  const maxChars = resolveCompactionThresholdChars(opts.maxChars);

  if (!opts.enabled || estimatedChars <= maxChars || cleaned.length <= keepRecent) {
    return {
      compacted: false,
      messages: cleaned,
      droppedCount: 0,
      estimatedChars,
    };
  }

  const initialSplit = Math.max(1, cleaned.length - keepRecent);
  let splitIdx = initialSplit;
  while (splitIdx > 0 && !isSafeSplitIndex(cleaned, splitIdx)) {
    splitIdx -= 1;
  }
  if (splitIdx === 0) {
    // Walking backward hit index 0 (e.g. an unbroken tool chain). Walk forward
    // from initialSplit so we keep the latest intact tool sequence untouched.
    let forward = initialSplit;
    while (forward < cleaned.length && !isSafeSplitIndex(cleaned, forward)) {
      forward += 1;
    }
    splitIdx = forward < cleaned.length ? forward : 0;
  }

  if (splitIdx <= 0) {
    return {
      compacted: false,
      messages: cleaned,
      droppedCount: 0,
      estimatedChars,
    };
  }

  const older = cleaned.slice(0, splitIdx);
  const recent = cleaned.slice(splitIdx);
  const digest = buildDigestText(
    older,
    Math.max(512, Math.floor(opts.maxDigestChars ?? DEFAULT_MAX_DIGEST_CHARS)),
  );

  const prefix: StoredMessage[] = [
    {
      role: "user",
      content: [{ type: "text", text: digest } satisfies Anthropic.TextBlockParam],
    },
  ];
  if (recent[0]?.role === "user") {
    prefix.push({
      role: "assistant",
      content: [
        {
          type: "text",
          text: "Understood — continuing from the compacted context above.",
        } satisfies Anthropic.TextBlockParam,
      ],
    });
  }

  return {
    compacted: true,
    messages: [...prefix, ...recent],
    droppedCount: older.length,
    estimatedChars,
  };
}

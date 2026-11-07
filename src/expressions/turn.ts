import { randomUUID } from "node:crypto";
import type { ToolDefinition } from "../types.js";
import { expressionCatalog, resolveExpression, type ExpressionRecord } from "./catalog.js";
import type { ExpressionPreferences } from "./preferences.js";

/** A queue private to one user turn. Nothing is published until the turn commits. */
export function expressionTurn(
  prefs: ExpressionPreferences,
  turnsSinceLast: number,
  userText: string,
) {
  let pending: ExpressionRecord | undefined;
  let toolFailed = false;
  const veto =
    /(?:不要|别|不用|no\b|without\b|(?:don't|do not) (?:use|send)).{0,12}(?:表情|贴纸|动图|emoji|sticker)/i.test(
      userText,
    );
  const requested = !veto && /(?:表情包|贴纸|动图|emoji|sticker)/i.test(userText);
  const allowed =
    prefs.display !== "off" &&
    !veto &&
    (requested || turnsSinceLast >= (prefs.frequency === "lively" ? 1 : 3));
  const tool: ToolDefinition = {
    name: "reply_expression",
    description:
      "Add ONE expression to the end of this reply. Choose an existing asset and animated, static, emoji or auto. Optional: greetings, thanks, encouragement, gentle company; do not decorate serious or technical answers unnecessarily. Celebrate completion only after observing successful results. Never replace important explanations with a sticker. It is queued until this user turn succeeds. IDs: " +
      expressionCatalog.map((x) => `${x.id}=${x.alt}`).join("; "),
    inputSchema: {
      type: "object",
      properties: {
        assetId: { type: "string", enum: expressionCatalog.map((x) => x.id) },
        format: { type: "string", enum: ["auto", "animated", "static", "emoji"] },
      },
      required: ["assetId", "format"],
      additionalProperties: false,
    },
    async execute(input) {
      if (prefs.display === "off")
        return "Expression not queued: the user turned conversation expressions off. Finish the reply without one.";
      if (veto)
        return "Expression not queued: the user asked for no stickers or emoji in this reply. Finish it without one, and without decorative emoji.";
      if (!allowed)
        return "Expression not queued: a recent reply already had one. Finish this reply without it.";
      if (pending) return "An expression is already queued for this reply. Do not add another.";
      const v = input as { assetId?: unknown; format?: unknown };
      if (!v || !["auto", "animated", "static", "emoji"].includes(String(v.format)))
        throw new Error("Unknown expression format");
      let format = v.format === "auto" ? "animated" : v.format;
      if (prefs.display === "static" && format !== "emoji") format = "static";
      if (prefs.display === "emoji") format = "emoji";
      const e = resolveExpression({ version: 1, id: randomUUID(), assetId: v.assetId, format });
      if (!e) throw new Error("Unknown expression asset");
      pending = { version: 1, id: e.id, assetId: e.assetId, format: e.format };
      return "Expression queued. Finish your reply normally; do not repeat the expression in text.";
    },
  };
  return {
    tool,
    noteToolFailure: () => {
      toolFailed = true;
    },
    pending: () =>
      toolFailed &&
      !requested &&
      pending &&
      ["proud", "cheering", "sticker-celebrate", "sticker-well-done"].includes(pending.assetId)
        ? undefined
        : pending,
    prompt: expressionPrompt(prefs),
  };
}

/**
 * The system-prompt suffix. It depends on the saved preferences only — never on
 * this turn's cadence or wording — because it is appended to the 1h-cached
 * system prefix: a per-turn flip would re-write that cache (and every cached
 * message after it) and append another full prompt entry to the session log.
 * Per-turn spacing and "no stickers" requests are enforced by the tool result.
 */
export function expressionPrompt(prefs: ExpressionPreferences): string {
  if (prefs.display === "off")
    return "\n\nConversation expressions are off: do not call reply_expression, and avoid decorative emoji.";
  const pacing =
    prefs.frequency === "lively"
      ? "Use one only when it suits the moment."
      : "Keep them occasional: unless the user asks for one, leave at least two replies without one after using it.";
  return `\n\nConversation expressions: display=${prefs.display}, frequency=${prefs.frequency}. reply_expression optionally adds one sticker or emoji to a reply. ${pacing} If the tool says an expression was not queued, finish the reply without it. Emoji may also appear naturally in text; keep them sparse. Never output asset URLs or internal expression JSON.`;
}

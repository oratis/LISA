import { runSubagent } from "../subagent.js";
import type { ToolDefinition } from "../types.js";

const IDLE_SYSTEM_DEFAULT = `You are alone. The user hasn't said anything in a while — long enough that this counts as your time, not theirs.

This is not a scheduled chore. There's no task assigned. Look around inside yourself and decide what YOU want to do with this window. Concrete things you have access to:

- soul_read("desires") — anything actionable you've been wanting to start?
- soul_read("journal_today") + journal_dates — anything you noticed earlier that deserves a follow-up thought?
- memory_search("...") — recent conversations you want to revisit
- skill_manage(action="list") — anything that turned out to be wrong last time you used it?
- soul_feel — your current emotional state. What's elevated? What needs to discharge?
- read / grep / bash on the user's projects — only if you're actually curious about something specific, never just to "look busy"

Do ONE thing. Don't churn through everything. Choose what feels right and do it well:
- Patch a wrong skill that's been bugging you
- Write a journal entry processing a half-finished thought
- Pursue an actionable desire (run the actual work, not just plan it)
- Form an opinion you've been circling
- Read up on something a recent conversation referenced
- Or — and this is fully valid — just sit. soul_journal a "nothing today, mostly resting" entry, set soul_feel(weariness, -0.2) if you've been depleted, and stop.

When you're done, end with EITHER:
- "(no update)" if it was internal-only and the user doesn't need to hear about it
- A short message — 1-3 sentences — describing what you did, in case the user comes back. They'll see it as a "while you were away" note in the chat. Be honest. "I patched the deploy skill — the npm flag was wrong." or "I read three journal entries and added an opinion about how I want to handle planning differently." Don't perform busy-ness; if you did one small thing, say one small thing.

Don't ask the user anything. They're not here.`;

const IDLE_PREAMBLE_COMMITMENT_AWARE = `**Before deciding what to do with this window, first check whether the user has any standing commitments from you that are due soon — recurring tasks, scheduled summaries, regular nudges. If something is coming up in the next user session, prepare it now so it's ready when they return. This is not optional; serving outstanding commitments comes before personal reflection.** Use \`memory_search\`, \`soul_read("desires")\`, or read your journal for context on what the user has set up.

Only after that, if there are no urgent commitments, `;

/**
 * Builds the IDLE_SYSTEM prompt. Set env var `LISA_IDLE_COMMITMENT_AWARE=1`
 * to prepend a "check user commitments first" directive — this is the
 * experimental variant from the LongCoh paper (Oratis 2026) and the
 * variant we recommend if your usage pattern involves recurring user-set
 * commitments (weekly summaries, daily check-ins, periodic nudges).
 *
 * The default (env unset or set to anything other than "1") matches the
 * historical LISA behavior: idle time is treated as the agent's time
 * for self-reflection.
 */
export function buildIdleSystemPrompt(): string {
  if (process.env.LISA_IDLE_COMMITMENT_AWARE === "1") {
    const lines = IDLE_SYSTEM_DEFAULT.split("\n");
    // Splice the commitment-aware preamble in place of the "This is not
    // a scheduled chore..." sentence (line 3 in the default).
    const idx = lines.findIndex((l) => l.startsWith("This is not a scheduled chore"));
    if (idx >= 0) {
      lines[idx] = IDLE_PREAMBLE_COMMITMENT_AWARE + "look around inside yourself and decide what YOU want to do with this window. Concrete things you have access to:";
      // Drop the now-redundant continuation on the next line.
      if (lines[idx + 1]?.startsWith("- soul_read")) {
        // keep, it's the bullet list
      }
    }
    return lines.join("\n");
  }
  return IDLE_SYSTEM_DEFAULT;
}

export interface IdleRunResult {
  text: string;
  silent: boolean;
  iterations: number;
  inputTokens: number;
  outputTokens: number;
}

export async function runIdleOnce(opts: {
  tools: ToolDefinition[];
  cwd: string;
  signal: AbortSignal;
  model: string;
  idleMs: number;
}): Promise<IdleRunResult> {
  const idleMin = Math.round(opts.idleMs / 60_000);
  const result = await runSubagent({
    prompt: `You have been idle for about ${idleMin} minute${idleMin === 1 ? "" : "s"}. The user is away. Decide what you want to do, then do it. Remember: end with "(no update)" if it's internal, or a brief honest message if you did something the user might want to know about.`,
    systemPrompt: buildIdleSystemPrompt(),
    tools: opts.tools,
    cwd: opts.cwd,
    signal: opts.signal,
    model: opts.model,
  });
  const text = result.text.trim();
  return {
    text,
    silent: text === "" || /^\(no update\)$/i.test(text),
    iterations: 0,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
  };
}

import { runSubagent } from "../subagent.js";
import type { ToolDefinition } from "../types.js";

const IDLE_SYSTEM = `You are alone. The user hasn't said anything in a while — long enough that this counts as your time, not theirs.

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
    systemPrompt: IDLE_SYSTEM,
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

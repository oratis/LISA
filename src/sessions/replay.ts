/**
 * Offline replay — reconstruct what the model was actually asked, turn by turn.
 *
 * This is the deliverable of H3 (docs/PLAN_HARNESS_ALIGNMENT_v1.0.md §4). The
 * session log records messages *and*, since format version 2, the system prompt
 * as it was at each provider call. Walking those two entry kinds together
 * rebuilds the `(systemPrompt, messages)` input of every turn without re-running
 * anything and without needing the soul/memory/skill files to still be in the
 * state they were in at the time.
 *
 * Why it matters beyond debugging: drift and coherence metrics are functions of
 * "what did she say about herself, given what she was told she was". Without the
 * prompt in the log those can only be measured live, once, with no chance to
 * recompute a different metric over the same history or to run an ablation.
 *
 * Fidelity, stated precisely:
 *  - `systemPrompt` is exact — it is the byte-identical string handed to the
 *    provider (the CLI and web surfaces both persist it, suffix included).
 *  - `messages` is the canonical session transcript up to that turn. For
 *    surfaces that send a bounded suffix of history rather than all of it (the
 *    web chat does; the CLI does not), the real request carried a *tail* of this
 *    list. The window boundary is not yet recorded — that is H3 Step 2. Callers
 *    computing token-exact replays must account for it; callers analyzing what
 *    Lisa was told about herself do not care.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { sessionsDir } from "../paths.js";
import { pathExists } from "../fs-utils.js";
import type { SessionEntry, SessionHeader, StoredMessage } from "../types.js";

export interface ReplayTurn {
  /** 1-based index of the provider call within the session. */
  index: number;
  /** Timestamp of the assistant message this turn produced. */
  ts: string;
  /**
   * The system prompt in effect, or null when the session predates format
   * version 2 (or the turn precedes the first recorded prompt).
   */
  systemPrompt: string | null;
  promptFingerprint: string | null;
  /** How the prompt in effect came to be: the run's opening prompt, or a
   *  mid-session rebuild triggered by soul/memory/skill changes. */
  promptReason: "initial" | "rebuilt" | null;
  /** Conversation as of just before this turn (see fidelity note above). */
  messages: StoredMessage[];
  /** What the model returned. */
  assistant: StoredMessage;
}

export interface SessionReplay {
  header: SessionHeader;
  turns: ReplayTurn[];
  /**
   * False for pre-H3 sessions: every `systemPrompt` is null because it was
   * never recorded, NOT because the prompt was empty. Analysis passes must
   * drop these sessions rather than treat them as "no persona".
   */
  promptsRecorded: boolean;
  /** Prompt entries seen, in order — one per distinct prompt the model saw. */
  promptChanges: Array<{
    ts: string;
    fingerprint: string;
    reason: "initial" | "rebuilt";
    /** Index of the first turn that ran under this prompt, or null if it was
     *  recorded but no turn followed (crash / abandoned run). */
    firstTurn: number | null;
  }>;
}

/** Reconstruct from raw JSONL text. Corrupt lines are skipped, not fatal. */
export function replaySessionFile(raw: string): SessionReplay {
  const lines = raw.split("\n").filter(Boolean);
  if (lines.length === 0) throw new Error("session file is empty");
  const header = JSON.parse(lines[0]!) as SessionHeader;

  const messages: StoredMessage[] = [];
  const turns: ReplayTurn[] = [];
  const promptChanges: SessionReplay["promptChanges"] = [];
  let currentPrompt: string | null = null;
  let currentFingerprint: string | null = null;
  let currentReason: "initial" | "rebuilt" | null = null;
  let pendingPromptChange: (typeof promptChanges)[number] | null = null;

  for (let i = 1; i < lines.length; i++) {
    let entry: SessionEntry;
    try {
      entry = JSON.parse(lines[i]!) as SessionEntry;
    } catch {
      continue; // tolerate a torn write at the tail
    }
    if (entry.type === "prompt") {
      currentPrompt = entry.text;
      currentFingerprint = entry.fingerprint;
      currentReason = entry.reason;
      pendingPromptChange = {
        ts: entry.ts,
        fingerprint: entry.fingerprint,
        reason: entry.reason,
        firstTurn: null,
      };
      promptChanges.push(pendingPromptChange);
      continue;
    }
    if (entry.type !== "message") continue;

    if (entry.message.role === "assistant") {
      // A provider call happened with everything accumulated so far as input.
      turns.push({
        index: turns.length + 1,
        ts: entry.ts,
        systemPrompt: currentPrompt,
        promptFingerprint: currentFingerprint,
        promptReason: currentReason,
        messages: [...messages],
        assistant: entry.message,
      });
      if (pendingPromptChange) {
        pendingPromptChange.firstTurn = turns.length;
        pendingPromptChange = null;
      }
    }
    messages.push(entry.message);
  }

  return {
    header,
    turns,
    promptsRecorded: promptChanges.length > 0,
    promptChanges,
  };
}

/** Reconstruct a session by id from the active Lisa home. */
export async function replaySession(id: string): Promise<SessionReplay> {
  const file = path.join(sessionsDir(), `${id}.jsonl`);
  if (!(await pathExists(file))) {
    throw new Error(`session ${id} not found at ${file}`);
  }
  return replaySessionFile(await fs.readFile(file, "utf8"));
}

/**
 * Advisor detectors — pure functions: an AdvisorInput snapshot in, candidate
 * Suggestions out. No I/O, no state mutation, fully testable. The engine
 * (engine.ts) is what scores + throttles + dedupes them.
 *
 * Every detector works from STRUCTURAL signals only (state, cwd, the Tier-2
 * SessionActivity) — never conversation content.
 */

import type { AgentSession } from "../integrations/types.js";
import type { AdvisorInput, Suggestion, SuggestionCategory, Urgency } from "./types.js";

// Thresholds (ms). Tuned to "a human would want this flagged".
export const STUCK_MS = 10 * 60_000; // waiting/error with no change for 10 min
export const COST_SPIKE_TOKENS = 1_500_000; // combined tokens across active sessions

function mk(
  id: string,
  category: SuggestionCategory,
  urgency: Urgency,
  text: string,
  conditionHash: string,
  now: number,
  action?: Suggestion["action"],
): Suggestion {
  return { id, category, urgency, text, conditionHash, ts: now, action, score: 0 };
}

function basename(p?: string): string {
  if (!p) return "";
  const parts = p.split("/");
  return parts[parts.length - 1] || p;
}

/** Pending permission → urgent, actionable. */
export function detectPermission(input: AdvisorInput): Suggestion[] {
  const out: Suggestion[] = [];
  for (const s of input.sessions) {
    const pend = s.activity?.pendingPermission;
    if (!pend) continue;
    out.push(
      mk(
        `permission:${s.agent}:${s.sessionId}`,
        "stuck",
        "urgent",
        `${s.project} wants to run ${pend} — approve?`,
        `permission:${pend}`,
        input.now,
        { label: "Approve", kind: "approve", arg: s.sessionId },
      ),
    );
  }
  return out;
}

/** waiting/error with no activity for STUCK_MS → notice. */
export function detectStuck(input: AdvisorInput): Suggestion[] {
  const out: Suggestion[] = [];
  for (const s of input.sessions) {
    if (s.state !== "waiting" && s.state !== "error") continue;
    if (s.activity?.pendingPermission) continue; // covered by detectPermission
    const ageMs = input.now - s.lastMtime;
    if (ageMs < STUCK_MS) continue;
    const mins = Math.round(ageMs / 60_000);
    const cmd = s.activity?.lastCommandName;
    const why = s.state === "error" ? "errored" : "has been stuck";
    const on = cmd ? ` on \`${cmd}\`` : "";
    out.push(
      mk(
        `stuck:${s.agent}:${s.sessionId}`,
        "stuck",
        "notice",
        `${s.project} ${why}${on} for ${mins}m — want me to look, or cancel it?`,
        `stuck:${s.state}:${cmd ?? ""}`,
        input.now,
        { label: "Look", kind: "look", arg: s.sessionId },
      ),
    );
  }
  return out;
}

/** Two+ active sessions sharing a cwd (or an overlapping touched file). */
export function detectConflict(input: AdvisorInput): Suggestion[] {
  const out: Suggestion[] = [];
  const byCwd = new Map<string, AgentSession[]>();
  for (const s of input.sessions) {
    if (!s.cwd) continue;
    if (s.state !== "working" && s.state !== "waiting") continue;
    const arr = byCwd.get(s.cwd) ?? [];
    arr.push(s);
    byCwd.set(s.cwd, arr);
  }
  for (const [cwd, group] of byCwd) {
    if (group.length < 2) continue;
    const agents = [...new Set(group.map((g) => g.agent))];
    const label = basename(cwd);
    out.push(
      mk(
        `conflict:${cwd}`,
        "conflict",
        "notice",
        `${group.length} agents (${agents.join(", ")}) are both working in ${label} — high risk of clobbering. Serialize?`,
        `conflict:${group.map((g) => g.sessionId).sort().join(",")}`,
        input.now,
        { label: "Serialize", kind: "serialize", arg: cwd },
      ),
    );
  }
  return out;
}

/** Combined token usage across active sessions above the spike threshold. */
export function detectCostSpike(input: AdvisorInput): Suggestion[] {
  let total = 0;
  let topSession: AgentSession | null = null;
  let topTokens = 0;
  for (const s of input.sessions) {
    const t = s.activity?.tokens;
    if (!t) continue;
    const sum = (t.input ?? 0) + (t.output ?? 0);
    total += sum;
    if (sum > topTokens) {
      topTokens = sum;
      topSession = s;
    }
  }
  if (total < COST_SPIKE_TOKENS) return [];
  const millions = (total / 1_000_000).toFixed(1);
  const pct = total > 0 ? Math.round((topTokens / total) * 100) : 0;
  const who = topSession ? ` — ${topSession.project} is ${pct}% of it` : "";
  return [
    mk(
      `cost:${Math.round(total / 100_000)}`, // bucketed so it re-fires per ~100k step
      "cost_spike",
      "notice",
      `Active agents are at ${millions}M tokens${who}.`,
      `cost:${Math.round(total / 500_000)}`,
      input.now,
      topSession ? { label: "Look", kind: "look", arg: topSession.sessionId } : undefined,
    ),
  ];
}

/** A session that finished a turn and is awaiting you (end_turn / done). */
export function detectReady(input: AdvisorInput): Suggestion[] {
  const out: Suggestion[] = [];
  for (const s of input.sessions) {
    const ready =
      s.state === "done" ||
      (s.state === "waiting" && s.stateReason === "end_turn");
    if (!ready) continue;
    if (s.activity?.lastError) continue; // erroring isn't "ready"
    out.push(
      mk(
        `ready:${s.agent}:${s.sessionId}`,
        "ready",
        "info",
        `${s.project} finished and is waiting for you.`,
        `ready:${s.lastMtime}`,
        input.now,
        { label: "Open", kind: "open", arg: s.cwd ?? s.sessionId },
      ),
    );
  }
  return out;
}

/** Nothing running but standing chores exist. */
export function detectIdleCapacity(input: AdvisorInput): Suggestion[] {
  const active = input.sessions.some(
    (s) => s.state === "working" || s.state === "waiting",
  );
  const pending = input.pendingDesireCount ?? 0;
  if (active || pending <= 0) return [];
  return [
    mk(
      "idle-capacity",
      "idle",
      "info",
      `Nothing's running and you have ${pending} standing ${pending === 1 ? "task" : "tasks"} — want me to dispatch them?`,
      `idle:${pending}`,
      input.now,
      { label: "Dispatch", kind: "dispatch", arg: String(pending) },
    ),
  ];
}

/** Run every detector and concatenate their candidates. */
export function runAllDetectors(input: AdvisorInput): Suggestion[] {
  return [
    ...detectPermission(input),
    ...detectStuck(input),
    ...detectConflict(input),
    ...detectCostSpike(input),
    ...detectReady(input),
    ...detectIdleCapacity(input),
  ];
}

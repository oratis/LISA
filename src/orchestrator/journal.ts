/**
 * Orchestrator journal (L6) — a small temporal record of agent activity.
 *
 * The hub (L1) only holds a *live snapshot*; once a session goes idle/done it
 * falls out of `hub.list()`. The advisor (L5) surfaces relevance-gated alerts.
 * Neither answers "what actually happened across all my agents while I was
 * away?" — which needs a record over *time*, including sessions that have since
 * ended. This journal is that record: every meaningful state transition the hub
 * emits is appended to a capped ring buffer, from which recap.ts synthesizes a
 * cross-agent "while you were away" digest.
 *
 * In-memory + capped (no growth): a recap covers the current server's uptime,
 * which is exactly the window the user was away *for*. PRIVACY: stores only the
 * same structural metadata the hub emits (agent, project, state, tool/file
 * names, error strings) — never prompts, replies, or file contents.
 */

import type { AgentSession, AgentSessionState } from "../integrations/types.js";

export interface AgentEvent {
  agent: string;
  sessionId: string;
  project: string;
  cwd?: string;
  state: AgentSessionState;
  stateReason: string;
  /** Epoch ms of the transition. */
  at: number;
  /** Compact structural activity summary (tool · file · $cmd), if any. */
  activity?: string;
  /** Short error string when the session errored. */
  error?: string;
}

const MAX_EVENTS = 400;
const events: AgentEvent[] = [];

/** Compact, structural one-liner from a session's Tier-2 activity. */
export function summarizeActivity(s: AgentSession): string | undefined {
  const a = s.activity;
  if (!a) return undefined;
  const bits: string[] = [];
  const tool = a.lastTools?.length ? a.lastTools[a.lastTools.length - 1] : "";
  if (tool) bits.push(tool);
  if (a.lastCommandName) bits.push("$" + a.lastCommandName);
  const file = a.filesTouched?.length
    ? a.filesTouched[a.filesTouched.length - 1]!.split("/").pop()
    : "";
  if (file) bits.push(file);
  return bits.length ? bits.join(" · ") : undefined;
}

/**
 * Append a transition. Consecutive events for the same session with the same
 * state + reason are collapsed (we only record *changes*), so a session that
 * sits in "working" for an hour produces one entry, not hundreds.
 */
export function recordEvent(s: AgentSession, now: number = Date.now()): AgentEvent | null {
  // Find the most recent event for this session.
  let prev: AgentEvent | undefined;
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i]!.sessionId === s.sessionId) {
      prev = events[i];
      break;
    }
  }
  if (prev && prev.state === s.state && prev.stateReason === s.stateReason) {
    return null; // no real transition
  }
  const ev: AgentEvent = {
    agent: s.agent,
    sessionId: s.sessionId,
    project: s.project,
    cwd: s.cwd,
    state: s.state,
    stateReason: s.stateReason,
    at: Number.isFinite(s.lastMtime) && s.lastMtime > 0 ? s.lastMtime : now,
    activity: summarizeActivity(s),
    error: s.activity?.lastError,
  };
  events.push(ev);
  if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS);
  return ev;
}

/** All recorded events (oldest → newest). */
export function allEvents(): AgentEvent[] {
  return events.slice();
}

/** Events at or after `sinceMs` (epoch ms), oldest → newest. */
export function eventsSince(sinceMs: number): AgentEvent[] {
  return events.filter((e) => e.at >= sinceMs);
}

/** Test hook — wipe the buffer. */
export function _resetJournalForTest(): void {
  events.length = 0;
}

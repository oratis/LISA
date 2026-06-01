/**
 * Recap (L6) — synthesize the orchestrator journal into a cross-agent
 * "while you were away" digest. Deterministic (no LLM): given the journal
 * events in a time window, group by project, tally how each session ended,
 * and surface the notable moments (errors, finishes, merged PRs, blocks).
 *
 * This is the narrative counterpart to the advisor's alerts and list_agents'
 * roster: it answers "what happened, across everything, since I left?"
 */

import type { AgentEvent } from "./journal.js";
import type { AgentSessionState } from "../integrations/types.js";

export interface ProjectRecap {
  project: string;
  agents: string[];
  /** Distinct sessions seen in the window. */
  sessions: number;
  finished: number; // ended in "done"
  errored: number; // currently/last in "error"
  active: number; // still working/waiting
  /** Up to a few file basenames touched. */
  files: string[];
  /** Human-readable notable lines for this project. */
  notable: string[];
}

export interface Recap {
  sinceMs: number;
  now: number;
  /** Distinct sessions that had any event in the window. */
  totalSessions: number;
  totalEvents: number;
  projects: ProjectRecap[];
  /** One-line headline. */
  headline: string;
}

interface SessionRoll {
  agent: string;
  project: string;
  lastState: AgentSessionState;
  lastReason: string;
  lastAt: number;
  files: Set<string>;
  errored: boolean;
  lastError?: string;
  lastActivity?: string;
}

const FILES_PER_PROJECT = 6;

function basename(p: string): string {
  return p.split("/").pop() || p;
}

/** Build the structured recap from journal events in [sinceMs, now]. Pure. */
export function buildRecap(events: AgentEvent[], sinceMs: number, now: number): Recap {
  const inWindow = events.filter((e) => e.at >= sinceMs);

  // Roll up per session (the latest meaningful state wins).
  const sessions = new Map<string, SessionRoll>();
  for (const e of inWindow) {
    let r = sessions.get(e.sessionId);
    if (!r) {
      r = {
        agent: e.agent,
        project: e.project || "(unknown)",
        lastState: e.state,
        lastReason: e.stateReason,
        lastAt: e.at,
        files: new Set(),
        errored: false,
      };
      sessions.set(e.sessionId, r);
    }
    if (e.at >= r.lastAt) {
      r.lastState = e.state;
      r.lastReason = e.stateReason;
      r.lastAt = e.at;
      if (e.activity) r.lastActivity = e.activity;
    }
    if (e.state === "error") {
      r.errored = true;
      if (e.error || e.stateReason) r.lastError = e.error || e.stateReason;
    }
    if (e.activity) {
      // The activity summary's last token is often a file basename; cheap to keep.
      const f = e.activity.split(" · ").find((t) => /\.[a-z0-9]+$/i.test(t));
      if (f) r.files.add(f);
    }
  }

  // Group sessions by project.
  const byProject = new Map<string, SessionRoll[]>();
  for (const r of sessions.values()) {
    const list = byProject.get(r.project) ?? [];
    list.push(r);
    byProject.set(r.project, list);
  }

  const projects: ProjectRecap[] = [];
  let totalFinished = 0,
    totalErrored = 0,
    totalActive = 0;
  for (const [project, rolls] of byProject) {
    const agents = [...new Set(rolls.map((r) => r.agent))].sort();
    let finished = 0,
      errored = 0,
      active = 0;
    const files = new Set<string>();
    const notable: string[] = [];
    for (const r of rolls) {
      if (r.errored) {
        errored++;
        notable.push(`✗ ${r.agent} errored${r.lastError ? `: ${r.lastError}` : ""}`);
      } else if (r.lastState === "done") {
        finished++;
        notable.push(`✓ ${r.agent} finished${r.lastReason ? ` (${r.lastReason})` : ""}`);
      } else if (r.lastState === "working" || r.lastState === "waiting") {
        active++;
        if (r.lastState === "waiting" && r.lastReason)
          notable.push(`• ${r.agent} waiting — ${r.lastReason}`);
      }
      for (const f of r.files) files.add(basename(f));
    }
    totalFinished += finished;
    totalErrored += errored;
    totalActive += active;
    projects.push({
      project,
      agents,
      sessions: rolls.length,
      finished,
      errored,
      active,
      files: [...files].slice(0, FILES_PER_PROJECT),
      notable: notable.slice(0, 6),
    });
  }

  // Errors first, then most sessions, then name.
  projects.sort(
    (a, b) =>
      b.errored - a.errored || b.sessions - a.sessions || a.project.localeCompare(b.project),
  );

  const parts: string[] = [];
  if (totalFinished) parts.push(`${totalFinished} finished`);
  if (totalErrored) parts.push(`${totalErrored} errored`);
  if (totalActive) parts.push(`${totalActive} still going`);
  const headline =
    sessions.size === 0
      ? "No agent activity in this window."
      : `${sessions.size} agent session${sessions.size === 1 ? "" : "s"} across ` +
        `${projects.length} project${projects.length === 1 ? "" : "s"}` +
        (parts.length ? ` — ${parts.join(", ")}.` : ".");

  return {
    sinceMs,
    now,
    totalSessions: sessions.size,
    totalEvents: inWindow.length,
    projects,
    headline,
  };
}

/** Render the recap as a readable multi-line digest. Pure. */
export function formatRecap(recap: Recap): string {
  if (recap.totalSessions === 0) return recap.headline;
  const lines: string[] = [recap.headline, ""];
  for (const p of recap.projects) {
    lines.push(`${p.project} · ${p.agents.join(", ")}`);
    for (const n of p.notable) lines.push(`  ${n}`);
    if (p.files.length) lines.push(`  touched: ${p.files.join(", ")}`);
  }
  return lines.join("\n");
}

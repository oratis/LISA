/**
 * What forget covers in a home, stated per entry, so its report can say what
 * it verified and name what it did not scan — instead of a blanket "no layer
 * still matches".
 *
 * HOME_ENTRIES classifies every top-level entry the code can create under a
 * home (`lisaHome()`, `lisaGlobalHome()`, `homeForUid()`):
 *
 *   scanned       forget searches it and cleans what matches
 *   not_scanned   can hold user text; forget does not edit it and names it
 *                 in the report whenever it is present
 *   no_user_text  configuration, counters, hashes, locks or secrets
 *   other         another home (`users/`) or a transient staging dir
 *
 * coverage.test.ts scans src/ for entries created under a home and fails when
 * one is missing here, so a new store has to be classified before it ships.
 */
import fs from "node:fs/promises";
import path from "node:path";

export type CoverageKind = "scanned" | "not_scanned" | "no_user_text" | "other";

export interface HomeEntryCoverage {
  forget: CoverageKind;
  what: string;
}

/** Top-level home entries. A key ending in "*" matches by prefix. */
export const HOME_ENTRIES: Readonly<Record<string, HomeEntryCoverage>> = {
  // ── scanned by forget ──
  soul: {
    forget: "scanned",
    what: "journal and relationships (literal redactions); identity, values, opinions and desires reported, never edited",
  },
  memory: { forget: "scanned", what: "MEMORY.md and USER.md entries" },
  kb: { forget: "scanned", what: "knowledge-base pages (wiki/, sources/) and their index" },
  sessions: { forget: "scanned", what: "conversation transcripts" },
  reflections: { forget: "scanned", what: "per-conversation reflection records" },
  tasks: { forget: "scanned", what: "task specs, run transcripts and pending notices" },
  embeddings: { forget: "scanned", what: "search embedding cache (evicted)" },

  // ── can hold user text, not scanned ──
  skills: { forget: "not_scanned", what: "skill instructions and notes" },
  autonomy: { forget: "not_scanned", what: "Lisa's autonomy run log (chore and desire notes)" },
  sense: { forget: "not_scanned", what: "activity log, social drafts and uploaded media" },
  mail: { forget: "not_scanned", what: "mail digests (subjects and snippets)" },
  "dispatches.json": { forget: "not_scanned", what: "dispatched agent prompts" },
  dispatches: { forget: "not_scanned", what: "dispatched agent output logs" },
  "scheduled-dispatches.json": { forget: "not_scanned", what: "scheduled dispatch prompts" },
  "comparisons.json": { forget: "not_scanned", what: "agent comparison tasks" },
  compare: { forget: "not_scanned", what: "agent comparison worktrees" },
  history: { forget: "not_scanned", what: "command-line prompt history" },
  "heartbeat.json": { forget: "not_scanned", what: "heartbeat chore prompts" },
  "heartbeat.json.pre-tasks*": { forget: "not_scanned", what: "backup of heartbeat chore prompts" },
  "heartbeat-state.json": { forget: "not_scanned", what: "heartbeat state keyed by chore names" },
  "heartbeat.log": { forget: "not_scanned", what: "heartbeat output log" },
  "serve.log*": { forget: "not_scanned", what: "server log" },
  "serve.launchd.log": { forget: "not_scanned", what: "server crash log" },
  warden: {
    forget: "not_scanned",
    what: "pending approvals (tool inputs) and approval audit previews",
  },
  "accounts.json": { forget: "not_scanned", what: "account records (email addresses)" },
  "devices.json": { forget: "not_scanned", what: "paired device names" },
  "otp.json": { forget: "not_scanned", what: "sign-in codes by email address" },
  "current-mood.json": { forget: "not_scanned", what: "current mood and its origin label" },
  "import-backups": { forget: "not_scanned", what: "data backed up by `lisa import --replace`" },

  // ── no user text ──
  reachout: { forget: "no_user_text", what: "reach-out settings and a ledger of hashes" },
  sovereignty: { forget: "no_user_text", what: "content-free audit of export/import/forget" },
  billing: { forget: "no_user_text", what: "usage and cost counters" },
  "billing-global.json": { forget: "no_user_text", what: "global spend counters" },
  "iap-transactions.json": { forget: "no_user_text", what: "in-app purchase transaction ids" },
  "iap-transactions.lock": { forget: "no_user_text", what: "lock" },
  "apple-root-g3.cer": { forget: "no_user_text", what: "certificate" },
  "advisor-state.json": { forget: "no_user_text", what: "advisor counters" },
  "advisor-state.json.lock": { forget: "no_user_text", what: "lock" },
  "screen-advisor.json": { forget: "no_user_text", what: "screen advisor settings" },
  "active-web-session.txt": { forget: "no_user_text", what: "a session id" },
  "takoapi-calls.json": { forget: "no_user_text", what: "gateway call ids and states" },
  "consent.json": { forget: "no_user_text", what: "consent grants" },
  "control-policy.json": { forget: "no_user_text", what: "control policy flags" },
  "session-secret": { forget: "no_user_text", what: "session signing secret" },
  "push.json": { forget: "no_user_text", what: "push topics and tokens" },
  "live-activities.json": { forget: "no_user_text", what: "Live Activity tokens" },
  "channels.json": { forget: "no_user_text", what: "channel configuration" },
  "agents.json": { forget: "no_user_text", what: "agent configuration" },
  "config.env": { forget: "no_user_text", what: "settings and provider keys" },
  "mcp.json": { forget: "no_user_text", what: "MCP server configuration" },
  plugins: { forget: "no_user_text", what: "generated connector plugins" },
  music: { forget: "no_user_text", what: "audio files the user added" },
  "idle.lock": { forget: "no_user_text", what: "lock" },
  "desire-review.lock": { forget: "no_user_text", what: "lock" },
  "heartbeat.lock": { forget: "no_user_text", what: "lock" },
  ".DS_Store": { forget: "no_user_text", what: "Finder metadata" },

  // ── other ──
  users: { forget: "other", what: "other accounts' homes (each forgets in its own)" },
  ".import-*": { forget: "other", what: "transient import staging" },
};

/** Places inside scanned areas that forget does not search. */
export const NESTED_NOT_SCANNED: readonly { path: string; what: string }[] = [
  { path: "soul/emotions.json", what: "Lisa's feelings log (one-line triggers)" },
  { path: "kb/feeds", what: "feed briefs (item titles and summaries)" },
  { path: "kb/.ingested.json", what: "ingest ledger (source slugs)" },
  { path: "kb/SCHEMA.md", what: "knowledge-base rules" },
];

/** The coverage entry for a top-level name, honouring "*" prefix keys. */
export function coverageOf(name: string): HomeEntryCoverage | null {
  const exact = HOME_ENTRIES[name];
  if (exact) return exact;
  for (const [key, v] of Object.entries(HOME_ENTRIES)) {
    if (key.endsWith("*") && name.startsWith(key.slice(0, -1))) return v;
  }
  return null;
}

/** What a forget re-scan verifies, for the report. */
export function scannedAreas(): string[] {
  return Object.entries(HOME_ENTRIES)
    .filter(([, v]) => v.forget === "scanned")
    .map(([k, v]) => `${k}/ — ${v.what}`);
}

/**
 * Entries present in `home` that can hold user text and that forget does not
 * scan, as "path — what" lines. Unknown top-level entries are listed too:
 * nothing is assumed clean that has not been classified.
 */
export async function notScannedIn(home: string): Promise<string[]> {
  const out: string[] = [];
  let names: string[];
  try {
    names = (await fs.readdir(home)).sort();
  } catch {
    return out;
  }
  for (const name of names) {
    const c = coverageOf(name);
    if (!c) out.push(`${name} — not classified; may hold anything`);
    else if (c.forget === "not_scanned") out.push(`${name} — ${c.what}`);
  }
  for (const n of NESTED_NOT_SCANNED) {
    try {
      await fs.lstat(path.join(home, n.path));
      out.push(`${n.path} — ${n.what}`);
    } catch {
      // absent
    }
  }
  return out;
}

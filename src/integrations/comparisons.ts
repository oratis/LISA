/**
 * Comparison jobs — the persisted state behind compare_agents. A job runs the
 * SAME task across N agents, each in its own git worktree off the repo, so they
 * don't clobber each other. The job ledger lets a later turn check status and
 * collect/diff the results (agents run for minutes — it can't be synchronous).
 */
import { randomUUID } from "node:crypto";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { atomicWrite } from "../fs-utils.js";
import { LISA_HOME } from "../paths.js";

export type CompareAgentKind = "claude" | "codex" | "opencode" | "aider";

export interface ComparisonEntry {
  agent: CompareAgentKind;
  worktree: string;
  branch: string;
  pid?: number;
  launchError?: string;
}

export interface ComparisonJob {
  id: string;
  task: string;
  repo: string;
  createdAt: number;
  entries: ComparisonEntry[];
}

const FILE = path.join(LISA_HOME, "comparisons.json");
/** Where worktrees live — outside the repo, so they never get committed. */
export const COMPARE_ROOT = path.join(LISA_HOME, "compare");

interface Store {
  jobs: ComparisonJob[];
}

export async function loadComparisons(): Promise<ComparisonJob[]> {
  try {
    const store = JSON.parse(await readFile(FILE, "utf8")) as Store;
    return Array.isArray(store.jobs) ? store.jobs : [];
  } catch {
    return [];
  }
}

async function save(jobs: ComparisonJob[]): Promise<void> {
  await atomicWrite(FILE, JSON.stringify({ jobs }, null, 2));
}

export function newJobId(): string {
  return randomUUID().slice(0, 8);
}

export async function addComparison(job: ComparisonJob): Promise<void> {
  const jobs = await loadComparisons();
  jobs.push(job);
  await save(jobs);
}

export async function getComparison(idOrPrefix: string): Promise<ComparisonJob | null> {
  const jobs = await loadComparisons();
  return jobs.find((j) => j.id === idOrPrefix || j.id.startsWith(idOrPrefix)) ?? null;
}

export async function removeComparison(idOrPrefix: string): Promise<boolean> {
  const jobs = await loadComparisons();
  const next = jobs.filter((j) => j.id !== idOrPrefix && !j.id.startsWith(idOrPrefix));
  if (next.length === jobs.length) return false;
  await save(next);
  return true;
}

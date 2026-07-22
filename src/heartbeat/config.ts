import fs from "node:fs/promises";
import path from "node:path";
import { lisaGlobalHome } from "../paths.js";
import { pathExists } from "../fs-utils.js";

export interface HeartbeatTask {
  name: string;
  prompt: string;
  enabled?: boolean;
  /** Cron-like spec OR `every:30m` shorthand handled by runner. Currently informational. */
  schedule?: string;
}

export interface HeartbeatConfig {
  tasks: HeartbeatTask[];
  /**
   * Max combined (input+output) tokens to spend across all tasks in a single
   * heartbeat invocation. Once exceeded, remaining tasks are skipped (logged,
   * not silently dropped). Guards against the runaway-cost case: a short
   * interval × several actionable desires × deep tool loops can otherwise run
   * to millions of tokens/day unbounded. 0 / unset = no limit.
   */
  budgetTokens?: number;
}

/** Default per-run token ceiling when heartbeat.json doesn't set one. */
export const DEFAULT_HEARTBEAT_BUDGET_TOKENS = 500_000;

const FILE = path.join(lisaGlobalHome(), "heartbeat.json");

export async function loadHeartbeatConfig(): Promise<HeartbeatConfig> {
  if (!(await pathExists(FILE))) return { tasks: [], budgetTokens: DEFAULT_HEARTBEAT_BUDGET_TOKENS };
  const raw = await fs.readFile(FILE, "utf8");
  let parsed: HeartbeatConfig;
  try {
    parsed = JSON.parse(raw) as HeartbeatConfig;
  } catch (err) {
    throw new Error(`failed to parse ${FILE}: ${(err as Error).message}`);
  }
  return {
    tasks: parsed.tasks ?? [],
    // Explicit 0 means "no limit"; undefined means "use the default ceiling".
    budgetTokens:
      parsed.budgetTokens === undefined ? DEFAULT_HEARTBEAT_BUDGET_TOKENS : parsed.budgetTokens,
  };
}

export const HEARTBEAT_CONFIG_PATH = FILE;

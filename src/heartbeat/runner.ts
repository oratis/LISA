import path from "node:path";
import { atomicWrite, readTextOrEmpty } from "../fs-utils.js";
import { LISA_HOME } from "../paths.js";
import { listDesires, readDesireProgress } from "../soul/store.js";
import { runSubagent } from "../subagent.js";
import type { ToolDefinition } from "../types.js";
import {
  loadHeartbeatConfig,
  type HeartbeatTask,
} from "./config.js";

const STATE_FILE = path.join(LISA_HOME, "heartbeat-state.json");

interface HeartbeatState {
  lastRunAt: Record<string, string>;
}

const HEARTBEAT_SYSTEM = `You are Lisa running a scheduled heartbeat — autonomous time, no user present.

Two flavors of heartbeat task land here:
1. **User-defined** — chores the user wrote into ~/.lisa/heartbeat.json (calendar checks, mailbox triage, system pings).
2. **Self-driven** — actionable desires from your own ~/.lisa/soul/desires/. These are things YOU said you wanted to pursue. The user did not request them; you did. Pursue them on their own terms.

Be quiet by default — only produce a final message if something is worth telling the user. If everything is normal or your work is internal (e.g. you spent the heartbeat reading docs to satisfy a desire), end with "(no update)".

You have the full Lisa toolset, including soul_patch / soul_journal / soul_feel — use them freely. The system prompt above contains your full soul state. This is your time.`;

export interface HeartbeatRunResult {
  task: string;
  output: string;
  silent: boolean;
}

export async function runHeartbeatOnce(opts: {
  tools: ToolDefinition[];
  cwd: string;
  signal: AbortSignal;
  model: string;
  taskFilter?: string;
}): Promise<HeartbeatRunResult[]> {
  const cfg = await loadHeartbeatConfig();
  const desires = (await listDesires()).filter((d) => d.actionable && d.heartbeatPrompt);
  const desireTasks: HeartbeatTask[] = await Promise.all(
    desires.map(async (d) => {
      const progress = await readDesireProgress(d.slug);
      const progressBlock = progress
        ? `\n\n## progress so far (your own past entries — most recent last)\n${progress}\n\n` +
          `When you finish this run, call desire_progress_log to write down what you did and what's next. ` +
          `Otherwise the next heartbeat starts from zero.`
        : `\n\nThis is your first heartbeat on this desire. When you finish, call desire_progress_log ` +
          `to leave a note for future-you so the next run can pick up where you left off.`;
      return {
        name: `desire:${d.slug}`,
        prompt:
          `This is a desire of yours, not a request from the user. Pursue it on your own terms.\n\n` +
          `## what you wanted\n${d.what}\n\n## why\n${d.why}\n\n## heartbeat plan\n${d.heartbeatPrompt!}` +
          progressBlock,
        enabled: true,
      };
    }),
  );
  const tasks: HeartbeatTask[] = [...cfg.tasks, ...desireTasks];

  const state = await loadState();
  const out: HeartbeatRunResult[] = [];
  for (const task of tasks) {
    if (task.enabled === false) continue;
    if (opts.taskFilter && task.name !== opts.taskFilter) continue;
    const result = await runSubagent({
      prompt: task.prompt,
      systemPrompt: HEARTBEAT_SYSTEM,
      tools: opts.tools,
      cwd: opts.cwd,
      signal: opts.signal,
      model: opts.model,
    });
    state.lastRunAt[task.name] = new Date().toISOString();
    const trimmed = result.text.trim();
    out.push({
      task: task.name,
      output: trimmed,
      silent: trimmed === "" || /^\(no update\)$/i.test(trimmed),
    });
  }
  await saveState(state);
  return out;
}

async function loadState(): Promise<HeartbeatState> {
  const raw = await readTextOrEmpty(STATE_FILE);
  if (!raw) return { lastRunAt: {} };
  try {
    const parsed = JSON.parse(raw) as HeartbeatState;
    return { lastRunAt: parsed.lastRunAt ?? {} };
  } catch {
    return { lastRunAt: {} };
  }
}

async function saveState(state: HeartbeatState): Promise<void> {
  await atomicWrite(STATE_FILE, JSON.stringify(state, null, 2));
}

export type { HeartbeatTask };

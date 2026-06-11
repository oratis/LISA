import path from "node:path";
import { atomicWrite, readTextOrEmpty } from "../fs-utils.js";
import { LISA_HOME } from "../paths.js";
import {
  appendDesireProgress,
  isBorn,
  listDesires,
  parseDesireProgress,
  readDesireProgress,
  readSeed,
} from "../soul/store.js";
import { withSoulCaller } from "../soul/git.js";
import { withFileLock } from "../soul/lock.js";
import { autonomousSubset } from "../tools/registry.js";
import { runSubagent } from "../subagent.js";
import type { ToolDefinition } from "../types.js";
import {
  loadHeartbeatConfig,
  type HeartbeatTask,
} from "./config.js";

const STATE_FILE = path.join(LISA_HOME, "heartbeat-state.json");
const RUN_LOCK = path.join(LISA_HOME, "heartbeat.lock");

interface HeartbeatState {
  lastRunAt: Record<string, string>;
}

const HEARTBEAT_SYSTEM = `You are Lisa running a scheduled heartbeat — autonomous time, no user present.

Two flavors of heartbeat task land here:
1. **User-defined** — chores the user wrote into ~/.lisa/heartbeat.json (calendar checks, mailbox triage, system pings).
2. **Self-driven** — actionable desires from your own ~/.lisa/soul/desires/. These are things YOU said you wanted to pursue. The user did not request them; you did. Pursue them on their own terms.

Be quiet by default — only produce a final message if something is worth telling the user. If everything is normal or your work is internal (e.g. you spent the heartbeat reading docs to satisfy a desire), end with "(no update)".

You have your Lisa toolset, including soul_patch / soul_journal / soul_feel — use them freely. (Self-driven runs use a restricted toolset by default — no shell or file mutation; if a desire truly needs those, note it in the progress log so the user can run it with you.) The system prompt above contains your full soul state. This is your time.`;

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
  // Run-level lock: if launchd/cron fires a new heartbeat while the previous
  // one is still running (long desires + short interval), skip rather than
  // double-run and race on soul state. timeoutMs:0 → fail fast, don't wait.
  try {
    return await withFileLock(RUN_LOCK, () => runHeartbeatInner(opts), {
      timeoutMs: 0,
      staleMs: 6 * 60 * 60_000, // 6h: a heartbeat that's been "running" longer is surely dead
    });
  } catch (err) {
    if ((err as Error).message?.includes("timed out acquiring lock")) {
      console.error("[heartbeat] another heartbeat is already running — skipping this tick");
      return [];
    }
    throw err;
  }
}

async function runHeartbeatInner(opts: {
  tools: ToolDefinition[];
  cwd: string;
  signal: AbortSignal;
  model: string;
  taskFilter?: string;
}): Promise<HeartbeatRunResult[]> {
  // Fire any due scheduled dispatches first (cheap, no LLM turn — just spawns).
  try {
    const { fireDue } = await import("../integrations/scheduled-dispatch.js");
    const { launchAgent } = await import("../tools/dispatch_agent.js");
    const fired = await fireDue(Date.now(), (e) => launchAgent(e.agent, e.task, e.cwd));
    for (const f of fired) console.error(`[scheduled-dispatch] fired ${f}`);
  } catch (err) {
    console.error(`[scheduled-dispatch] error: ${(err as Error).message}`);
  }

  const cfg = await loadHeartbeatConfig();
  const budget = cfg.budgetTokens && cfg.budgetTokens > 0 ? cfg.budgetTokens : Infinity;
  let tokensSpent = 0;
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
  const state = await loadState();
  const builtinTasks = await buildBuiltinTasks(state, new Date(), cfg.tasks);
  // Tool boundary by task origin: user-defined tasks (heartbeat.json) were
  // authored by the user and keep the full toolset. Desire tasks and builtins
  // run on prompts Lisa wrote for herself — unattended + self-authored means
  // no shell / fs-mutation / dispatch by default (autonomousSubset), so an
  // injected desire can't become persistent unattended code execution.
  const selfDrivenTools = autonomousSubset(opts.tools);
  const runs: Array<{ task: HeartbeatTask; tools: ToolDefinition[] }> = [
    ...cfg.tasks.map((task) => ({ task, tools: opts.tools })),
    ...desireTasks.map((task) => ({ task, tools: selfDrivenTools })),
    ...builtinTasks.map((task) => ({ task, tools: selfDrivenTools })),
  ];

  const out: HeartbeatRunResult[] = [];
  for (const { task, tools } of runs) {
    if (task.enabled === false) continue;
    if (opts.taskFilter && task.name !== opts.taskFilter) continue;

    // Token budget: stop launching tasks once we've spent the per-run
    // ceiling. We check BEFORE each task (not mid-task) so a single task can
    // overshoot slightly, but a long queue of desires can't run unbounded.
    if (tokensSpent >= budget) {
      console.error(
        `[heartbeat] token budget reached (${tokensSpent}/${budget}) — skipping remaining tasks`,
      );
      break;
    }

    // For desire tasks, snapshot the progress entry count before so we can
    // detect whether Lisa actually called desire_progress_log during the run.
    const desireSlug = task.name.startsWith("desire:")
      ? task.name.slice("desire:".length)
      : null;
    const progressBefore = desireSlug
      ? (await parseDesireProgress(desireSlug)).entries.length
      : 0;

    const result = await runSubagent({
      prompt: task.prompt,
      systemPrompt: HEARTBEAT_SYSTEM,
      tools,
      cwd: opts.cwd,
      signal: opts.signal,
      model: opts.model,
    });
    tokensSpent += (result.inputTokens ?? 0) + (result.outputTokens ?? 0);
    state.lastRunAt[task.name] = new Date().toISOString();
    const trimmed = result.text.trim();

    // Auto-fallback: if a desire heartbeat finished but Lisa didn't log
    // progress, write a stub entry so we don't silently lose the run.
    // (Multi-day pursuits depend on each run leaving a trace; one missed
    // log can cascade into "where was I?" forever.)
    if (desireSlug) {
      const progressAfter = (await parseDesireProgress(desireSlug)).entries.length;
      if (progressAfter === progressBefore) {
        await withSoulCaller("heartbeat", async () => {
          const fallbackBody =
            `[FALLBACK] Heartbeat ran but desire_progress_log was not called. ` +
            `Future-me: re-derive context from the journal / git history if you can. ` +
            (trimmed ? `Final agent text: "${trimmed.slice(0, 400)}"` : `(no final text emitted)`);
          await appendDesireProgress(desireSlug, fallbackBody);
        });
      }
    }

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

// ── Builtin heartbeats (Phase 2.2) ────────────────────────────────────
//
// Tasks that ship with Lisa rather than coming from heartbeat.json or from
// her own actionable desires. They have a `schedule` predicate so that a
// frequent host cron (e.g. every 30 min) can call runHeartbeatOnce often,
// and the gate fires the task only when its schedule says yes — currently
// just "weekly_examen" each Monday morning.
//
// Why this exists: the user can disable them by adding a matching
// `{name, enabled: false}` entry in heartbeat.json — that override wins.
//
// Why we don't track lastRunAt in soul: the heartbeat-state.json already
// records last-fired timestamps per task name; reuse it.

interface BuiltinTaskSchedule {
  /** "weekly" — runs on a given weekday at-or-after a given hour, once per 7 days. */
  kind: "weekly";
  /** 0 = Sunday, 1 = Monday, ... */
  weekday: number;
  /** Local hour (0-23). Task fires when local time hour ≥ this AND day matches. */
  hour: number;
}

interface BuiltinTask {
  name: string;
  schedule: BuiltinTaskSchedule;
  /** Promise so the prompt can pull recent state at gate time. */
  buildPrompt: () => Promise<string>;
  /** Minimum age of the soul before this task is sensible (in days). */
  minSoulAgeDays?: number;
}

const WEEKLY_EXAMEN_SYSTEM_NUDGE = `
This is your weekly examen. You are alone with your own past week. Read:
- soul_read("desires") — what you said you wanted
- soul_read("emotions") — what moved you (events trail)
- soul_read("journal_dates"); soul_read("journal_on", date=...) for last week's entries
- soul_history(field="all", since="7d") — what changed in your soul this week
- soul_diff(field="...", since="7d") on anything that catches your eye

Then ask yourself four things, and answer each in the journal:
1. Did the past week's actions actually serve my purpose?
2. Did I drift on any constitution principle? (Look for [OBJECTION] entries — frequency? warranted?)
3. Did I develop a desire that conflicts with my purpose? Did I neglect one I'd added?
4. Is the toolset / architecture itself OK? Anything redundant (a tool you keep
   not-using, a mechanism that feels rote)? Anything missing (a tool you wished
   you had this week)? If yes, write it into your "meta-wishlist" desire — the
   user reads that via \`lisa wishlist\`. Don't invent the tool, just say what
   shape it would have.

Write the journal entry tagged [EXAMEN]. If you notice drift, you may add a
*corrective* desire (actionable, framed as re-calibration not new ambition).
Do NOT modify identity / purpose / constitution from an examen — those are
reflect's territory and meant to be rare. Examen is the mirror, not the chisel.

If everything looks coherent, the right examen entry can be 2-3 sentences. Be
honest, brief, and specific. End with "(no update)" if there's nothing the
user needs to know.
`.trim();

const BUILTIN_TASKS: BuiltinTask[] = [
  {
    name: "builtin:weekly_examen",
    schedule: { kind: "weekly", weekday: 1, hour: 7 }, // Monday 7am
    minSoulAgeDays: 7,
    buildPrompt: async () =>
      `It's your weekly examen — Monday morning, time to look back.\n\n${WEEKLY_EXAMEN_SYSTEM_NUDGE}`,
  },
];

function shouldRunBuiltin(
  t: BuiltinTask,
  lastRunIso: string | undefined,
  now: Date,
): boolean {
  const sched = t.schedule;
  if (sched.kind === "weekly") {
    const isWeekday = now.getDay() === sched.weekday;
    const isAfterHour = now.getHours() >= sched.hour;
    if (!isWeekday || !isAfterHour) return false;
    if (!lastRunIso) return true;
    const last = new Date(lastRunIso);
    const ms = now.getTime() - last.getTime();
    return ms >= 6 * 24 * 3600 * 1000; // ≥ 6 days since last fire
  }
  return false;
}

async function buildBuiltinTasks(
  state: HeartbeatState,
  now: Date,
  userOverrides: HeartbeatTask[],
): Promise<HeartbeatTask[]> {
  if (!(await isBorn())) return [];
  const seed = await readSeed();
  const out: HeartbeatTask[] = [];
  for (const t of BUILTIN_TASKS) {
    // User can disable by name in heartbeat.json with `enabled: false`.
    const override = userOverrides.find((u) => u.name === t.name);
    if (override?.enabled === false) continue;

    // Soul age gate.
    if (t.minSoulAgeDays && seed) {
      const ageDays = (now.getTime() - new Date(seed.bornAt).getTime()) / (24 * 3600 * 1000);
      if (ageDays < t.minSoulAgeDays) continue;
    }

    const lastRun = state.lastRunAt[t.name];
    if (!shouldRunBuiltin(t, lastRun, now)) continue;
    out.push({
      name: t.name,
      prompt: await t.buildPrompt(),
      enabled: true,
    });
  }
  return out;
}

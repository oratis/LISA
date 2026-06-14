#!/usr/bin/env tsx
/**
 * Live observer verification (Observer deepening O-D3).
 *
 * Unit tests prove the PARSING logic against fixtures; they cannot prove the
 * fixtures still match what a given CLI version writes to disk. Agent session
 * formats drift (codex rollout schema, opencode DB schema, aider markdown), so
 * "LISA can see all your agents" is only true if the parse SCHEMA assumptions
 * still hold against the real, current tools.
 *
 * This harness starts the orchestrator hub against your real machine and prints,
 * per observer, the SessionActivity LISA currently parses — so you can eyeball
 * it against what the agent is actually doing, then log the result in
 * docs/OBSERVER_FIDELITY.md.
 *
 * Usage:
 *   npx tsx scripts/verify-observers.ts            # uses ~/.lisa/agents.json
 *   VERIFY_ALL=1 npx tsx scripts/verify-observers.ts   # force-enable every observer
 *   VERIFY_AGENTS=codex,opencode npx tsx scripts/verify-observers.ts  # only these
 *
 * It prints structural metadata only (the same fields the hub surfaces) — never
 * prompts, replies, or file content. Read-only; it never writes to any session.
 */
import os from "node:os";
import path from "node:path";
import {
  OrchestratorHub,
  loadOrchestratorConfig,
  DEFAULT_ORCHESTRATOR_CONFIG,
  type OrchestratorConfig,
} from "../src/integrations/hub.js";
import { listAvailableIntegrations, registerBuiltinIntegrations } from "../src/integrations/registry.js";
import type { AgentSession } from "../src/integrations/types.js";

const LISA_HOME = process.env.LISA_HOME ?? path.join(os.homedir(), ".lisa");

function rel(ms: number): string {
  const d = Date.now() - ms;
  if (d < 60_000) return `${Math.round(d / 1000)}s ago`;
  if (d < 3_600_000) return `${Math.round(d / 60_000)}m ago`;
  return `${Math.round(d / 3_600_000)}h ago`;
}

/** Build the run config: respect ~/.lisa/agents.json, or force-enable per env. */
async function buildConfig(): Promise<OrchestratorConfig> {
  await registerBuiltinIntegrations();
  const all = listAvailableIntegrations();
  const onlyEnv = (process.env.VERIFY_AGENTS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const forceAll = process.env.VERIFY_ALL === "1" || onlyEnv.length > 0;

  if (!forceAll) {
    const cfg = await loadOrchestratorConfig(path.join(LISA_HOME, "agents.json"));
    return { ...cfg, visibility: "activity" }; // activity tier so we see the fields
  }
  const targets = onlyEnv.length > 0 ? onlyEnv : all;
  const integrations: OrchestratorConfig["integrations"] = {};
  for (const name of all) {
    const base = DEFAULT_ORCHESTRATOR_CONFIG.integrations[name] ?? {};
    integrations[name] = { ...base, enabled: targets.includes(name) };
  }
  return { integrations, visibility: "activity" };
}

function printSession(s: AgentSession): void {
  const head = `  • ${s.project}  [${s.state}${s.stateReason ? `:${s.stateReason}` : ""}]  ${rel(s.lastMtime)}`;
  console.log(head);
  if (s.cwd) console.log(`      cwd: ${s.cwd}`);
  const a = s.activity;
  if (!a) {
    console.log("      activity: (none — metadata tier or no Tier-2 content)");
    return;
  }
  const bits: string[] = [`turns=${a.turnCount}`];
  if (a.lastTools?.length) bits.push(`tools=[${a.lastTools.join(", ")}]`);
  if (a.filesTouched?.length) bits.push(`files=[${a.filesTouched.join(", ")}]`);
  if (a.lastCommandName) bits.push(`cmd=${a.lastCommandName}`);
  if (a.lastError) bits.push(`error=${a.lastError}`);
  if (a.gitBranch) bits.push(`branch=${a.gitBranch}`);
  if (a.tokens) bits.push(`tokens=${a.tokens.input}/${a.tokens.output}`);
  if (a.pendingPermission) bits.push(`pending=${a.pendingPermission}`);
  console.log(`      activity: ${bits.join("  ")}`);
}

async function main(): Promise<void> {
  const cfg = await buildConfig();
  const enabled = Object.entries(cfg.integrations)
    .filter(([, e]) => e.enabled !== false)
    .map(([n]) => n);
  console.log(`LISA observer fidelity check — LISA_HOME=${LISA_HOME}`);
  console.log(`Enabled observers (visibility=${cfg.visibility}): ${enabled.join(", ") || "(none)"}\n`);

  const hub = new OrchestratorHub(cfg, { log: (m) => console.error(m) });
  await hub.start();
  // Give file-watch / poll a beat to settle before snapshotting.
  await new Promise((r) => setTimeout(r, 800));

  const sessions = hub.list();
  const byAgent = new Map<string, AgentSession[]>();
  for (const s of sessions) {
    const arr = byAgent.get(s.agent) ?? [];
    arr.push(s);
    byAgent.set(s.agent, arr);
  }

  for (const name of enabled) {
    const list = byAgent.get(name) ?? [];
    console.log(`── ${name} (${list.length} active session${list.length === 1 ? "" : "s"}) ──`);
    if (list.length === 0) {
      console.log("  (none active — start a real session in this agent, then re-run)\n");
      continue;
    }
    for (const s of list) printSession(s);
    console.log();
  }

  console.log("Eyeball each field against what the agent is actually doing, then");
  console.log("record the result (CLI version + date) in docs/OBSERVER_FIDELITY.md.");
  await hub.stop();
  // Observers hold unref'd timers / watchers; exit explicitly.
  process.exit(0);
}

main().catch((e) => {
  console.error("verify-observers failed:", e);
  process.exit(1);
});

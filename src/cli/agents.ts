/**
 * `lisa agents` — one-shot snapshot of every agent session the orchestrator hub
 * sees right now (Dispatch's `lisa <domain>` command, FOUNDATIONS §4). Spins the
 * hub briefly, lists, exits — works without a running `serve`. Structural only.
 */
import os from "node:os";
import path from "node:path";
import { OrchestratorHub, loadOrchestratorConfig } from "../integrations/hub.js";
import { registerBuiltinIntegrations } from "../integrations/registry.js";
import type { AgentSession } from "../integrations/types.js";
import { detectPlans, planSummaryLine, selectedPlan } from "../model/plans.js";

const LISA_HOME = process.env.LISA_HOME ?? path.join(os.homedir(), ".lisa");

function rel(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  return `${Math.round(ms / 3_600_000)}h`;
}

export async function runAgentsCommand(subargs: string[]): Promise<number> {
  // `lisa agents pty <agent> <task…>` — adopt-at-launch: start a real CLI under a
  // PTY through the running server so it's controllable from the roster / phone.
  if (subargs[0] === "pty" || subargs[0] === "attach") {
    const { runAgentPtyAttach } = await import("./agents-pty.js");
    return runAgentPtyAttach(subargs.slice(1));
  }

  await registerBuiltinIntegrations();
  const cfg = await loadOrchestratorConfig(path.join(LISA_HOME, "agents.json"));
  const hub = new OrchestratorHub(cfg, { log: () => {} });
  await hub.start();
  await new Promise((r) => setTimeout(r, 600)); // let file-watch / poll settle
  const sessions = hub.list();
  await hub.stop();

  // Coding-plan delegation target + detection (CODING_PLANS Phase 4).
  console.log(planSummaryLine(detectPlans(), selectedPlan()));

  if (sessions.length === 0) {
    console.log("No active agent sessions in the last window.");
    console.log("(claude-code is observed by default; enable others in ~/.lisa/agents.json)");
    return 0;
  }

  const byAgent = new Map<string, AgentSession[]>();
  for (const s of sessions) {
    const arr = byAgent.get(s.agent) ?? [];
    arr.push(s);
    byAgent.set(s.agent, arr);
  }
  const now = Date.now();
  for (const [agent, list] of byAgent) {
    console.log(`\n${agent} (${list.length})`);
    for (const s of list.slice(0, 10)) {
      const a = s.activity;
      const bits: string[] = [];
      if (a?.gitBranch) bits.push(a.gitBranch);
      if (a?.lastTools?.length) bits.push(a.lastTools[a.lastTools.length - 1]!);
      if (a?.pendingPermission) bits.push(`⚠${a.pendingPermission}`);
      const reason = s.stateReason ? `:${s.stateReason}` : "";
      console.log(
        `  ${(s.state + reason).padEnd(16)} ${s.project.padEnd(20)} ${rel(now - s.lastMtime).padStart(4)} ago` +
          (bits.length ? `  · ${bits.join(" ")}` : ""),
      );
    }
  }
  return 0;
}

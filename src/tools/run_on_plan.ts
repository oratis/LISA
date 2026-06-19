/**
 * run_on_plan (CODING_PLANS Phase 2) — delegate a coding task to a subscription
 * "coding plan" instead of a metered API key.
 *
 * The mechanism is the sanctioned one from docs/CODING_PLANS.md: LISA does NOT
 * touch the vendor's subscription token. It runs the vendor's OWN CLI that the
 * user is already logged into — `claude -p "<task>"` / `codex exec "<task>"` —
 * via the same `launchAgent` path `dispatch_agent` uses. Because that CLI owns
 * its subscription auth, the work bills to the plan, not an API key.
 *
 * This is a thin, plan-aware wrapper over dispatch: it resolves the selected
 * plan (`lisa model use plan://…`, stored as LISA_CODING_PLAN) or an explicit
 * one, presence-/login-checks it (plans.ts, no secrets read), then hands off to
 * launchAgent. Same safety posture as dispatch_agent — it spawns an autonomous,
 * file-mutating process, so it's approval-gated and excluded from the autonomous
 * / remote-safe toolsets.
 */
import type { ToolDefinition } from "../types.js";
import { activeAgentInCwd, launchAgent, type DispatchAgentKind } from "./dispatch_agent.js";
import {
  detectPlan,
  parsePlanRef,
  planDispatchKind,
  planPreflight,
  selectedPlan,
  PLAN_IDS,
  type PlanId,
  type PlanStatus,
} from "../model/plans.js";

interface RunOnPlanInput {
  task: string;
  /** "claude" | "codex" | "plan://claude" | …  Default: the selected plan. */
  plan?: string;
  cwd?: string;
  /** Override the same-cwd conflict guard (default false). */
  force?: boolean;
}

/** Resolve a loose plan argument (id or `plan://id`) or the configured default. Pure. */
export function resolvePlanId(
  raw: string | undefined,
  env: Record<string, string | undefined> = process.env,
): PlanId | null {
  if (!raw || !raw.trim()) return selectedPlan(env);
  const viaRef = parsePlanRef(raw);
  if (viaRef) return viaRef;
  const v = raw.trim().toLowerCase();
  return (PLAN_IDS as readonly string[]).includes(v) ? (v as PlanId) : null;
}

export type PlanRunCheck =
  | { ok: true; kind: DispatchAgentKind }
  | { ok: false; message: string };

/**
 * Decide whether a resolved plan can be delegated to, given its detected status.
 * Pure — the tool composes this with detectPlan() + launchAgent(). Returns the
 * dispatch kind to launch, or a user-facing refusal message.
 */
export function planRunPreCheck(planId: PlanId, status: PlanStatus): PlanRunCheck {
  const pf = planPreflight(status);
  if (!pf.ok) return { ok: false, message: `Can't run on your ${planId} plan: ${pf.reason}.` };
  return { ok: true, kind: planDispatchKind(planId) };
}

export const runOnPlanTool: ToolDefinition<RunOnPlanInput, string> = {
  name: "run_on_plan",
  description:
    "Delegate a coding task to the user's subscription coding plan (Claude Pro/Max, " +
    "ChatGPT/Codex, or GitHub Copilot) instead of a metered API key. Runs the vendor's own " +
    "CLI that the user is logged into (claude -p / codex exec / copilot -p), so the work " +
    "bills to their subscription, not an API key. Uses the plan selected via " +
    "`lisa model use plan://…` unless you pass one " +
    "in `plan`. The agent runs autonomously in the background and appears in the session " +
    "monitor; this returns a handle and does NOT wait for it to finish (check dispatch_status). " +
    "Spawns an autonomous process, so it requires user approval. Use when the user wants " +
    "coding work run on their subscription rather than spending API tokens.",
  inputSchema: {
    type: "object",
    properties: {
      task: {
        type: "string",
        description: "The coding task/prompt (passed as a single argument, never a shell string).",
        minLength: 1,
      },
      plan: {
        type: "string",
        description:
          "Which coding plan to use: \"claude\", \"codex\", or \"copilot\" (or plan://<id>). " +
          "Defaults to the plan selected with `lisa model use plan://…`.",
      },
      cwd: {
        type: "string",
        description: "Absolute working directory. Defaults to the current directory.",
      },
      force: {
        type: "boolean",
        description: "Launch even if another agent is already active in this directory (default false).",
      },
    },
    required: ["task"],
    additionalProperties: false,
  },
  async execute(input, ctx) {
    const planId = resolvePlanId(input.plan);
    if (!planId) {
      return input.plan
        ? `Unknown coding plan "${input.plan}". Use one of: ${PLAN_IDS.join(", ")} (or plan://<id>).`
        : "No coding plan selected. Pick one with `lisa model use plan://claude` (or pass " +
            'plan: "claude" | "codex"). See docs/CODING_PLANS.md.';
    }

    const check = planRunPreCheck(planId, detectPlan(planId));
    if (!check.ok) return check.message;

    const cwd = input.cwd && input.cwd.startsWith("/") ? input.cwd : ctx.cwd;
    if (!input.force) {
      const clash = activeAgentInCwd(cwd);
      if (clash) {
        return (
          `Refusing to run on your ${planId} plan in ${cwd}: ${clash} is already active there. ` +
          `Running two agents in one directory risks clobbering changes. ` +
          `Wait for it to finish, pick another directory, or pass force:true.`
        );
      }
    }

    const { pid, error, id } = await launchAgent(check.kind, input.task, cwd, ctx.log);
    if (error) return error;

    ctx.log(`[plan] ran on ${planId} via ${check.kind} (pid ${pid}) in ${cwd}: ${input.task.slice(0, 80)}`);
    return (
      `Running on your ${planId} plan — launched ${check.kind} (pid ${pid}) in ${cwd}. ` +
      `This spends your subscription, not an API key. It runs autonomously; I won't block on it — ` +
      `read its output with dispatch_status${id ? ` (id ${id})` : ""}, or signal_agent to list/cancel.`
    );
  },
};

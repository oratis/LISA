import readline from "node:readline";
import type { ApprovalCallback, ApprovalDecision } from "./agent.js";

export type ApprovalMode = "auto" | "ask" | "ask-mutating";

export interface ApprovalConfig {
  mode: ApprovalMode;
  mutatingTools: Set<string>;
  /** Per-tool action-level mutating gate, for action-dispatched tools whose
   *  reads are safe but writes aren't (e.g. github). tool → mutating actions. */
  mutatingActions?: Record<string, string[]>;
  /** Injectable prompt reader (tests); defaults to reading one stdin line. */
  readLine?: () => Promise<string>;
}

export const DEFAULT_MUTATING_TOOLS = new Set([
  "write",
  "edit",
  "apply_patch",
  "bash",
  // Local execution / process control — always state-changing.
  "dispatch_agent",
  "signal_agent",
]);

/**
 * Action-dispatched tools where only SOME actions mutate. Reads (issue_view,
 * pr_view, …) stay un-gated under ask-mutating; only these write actions prompt.
 * Mirrors github.ts's own "reads are safe; create/comment/merge are writes".
 */
export const DEFAULT_MUTATING_ACTIONS: Record<string, string[]> = {
  github: ["issue_create", "issue_comment", "pr_create", "pr_comment", "pr_merge"],
};

/** Does this tool call change state (so ask-mutating should prompt)? */
export function isMutatingCall(
  cfg: ApprovalConfig,
  toolName: string,
  input: unknown,
): boolean {
  if (cfg.mutatingTools.has(toolName)) return true;
  const actions = cfg.mutatingActions?.[toolName];
  if (actions && input && typeof input === "object") {
    const action = (input as Record<string, unknown>).action;
    if (typeof action === "string" && actions.includes(action)) return true;
  }
  return false;
}

export function buildApprovalCallback(
  cfg: ApprovalConfig,
): ApprovalCallback | undefined {
  if (cfg.mode === "auto") return undefined;
  return async (toolName: string, toolInput: unknown): Promise<ApprovalDecision> => {
    if (cfg.mode === "ask-mutating" && !isMutatingCall(cfg, toolName, toolInput)) {
      return { allow: true };
    }
    const preview = previewInput(toolInput);
    process.stderr.write(
      `\n[approval] ${toolName}(${preview})\n  [y]es / [n]o (default n) > `,
    );
    const answer = await (cfg.readLine ?? readSingleLine)();
    if (/^y(es)?$/i.test(answer.trim())) {
      return { allow: true };
    }
    return { allow: false, reason: answer.trim() || "user denied" };
  };
}

function previewInput(input: unknown): string {
  try {
    const json = JSON.stringify(input);
    if (json.length <= 200) return json;
    return json.slice(0, 197) + "...";
  } catch {
    return String(input);
  }
}

function readSingleLine(): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stderr,
    });
    rl.once("line", (line) => {
      rl.close();
      resolve(line);
    });
  });
}

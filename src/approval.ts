import readline from "node:readline";
import type { ApprovalCallback, ApprovalDecision } from "./agent.js";

export type ApprovalMode = "auto" | "ask" | "ask-mutating";

export interface ApprovalConfig {
  mode: ApprovalMode;
  mutatingTools: Set<string>;
}

export const DEFAULT_MUTATING_TOOLS = new Set([
  "write",
  "edit",
  "apply_patch",
  "bash",
]);

export function buildApprovalCallback(
  cfg: ApprovalConfig,
): ApprovalCallback | undefined {
  if (cfg.mode === "auto") return undefined;
  return async (toolName: string, toolInput: unknown): Promise<ApprovalDecision> => {
    if (cfg.mode === "ask-mutating" && !cfg.mutatingTools.has(toolName)) {
      return { allow: true };
    }
    const preview = previewInput(toolInput);
    process.stderr.write(
      `\n[approval] ${toolName}(${preview})\n  [y]es / [n]o (default n) > `,
    );
    const answer = await readSingleLine();
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

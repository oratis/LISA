/**
 * Purpose-based model routing (plan W12, "分层路由").
 *
 * Watching, triage, classification and summarisation go to a small model;
 * chat, planning and execution stay on the model the user chose. The router
 * only ever answers "which model id" — credentials, provider construction and
 * (in cloud) admission, reservation and settlement stay where they are, keyed
 * by the id this returns.
 */

export type ModelPurpose =
  "chat" | "plan" | "execute" | "triage" | "classify" | "summarize" | "watch";

export type ModelTierName = "strong" | "small";

/** Which tier each purpose runs on. Chat-facing work is never downgraded. */
export const PURPOSE_TIER: Readonly<Record<ModelPurpose, ModelTierName>> = {
  chat: "strong",
  plan: "strong",
  execute: "strong",
  triage: "small",
  classify: "small",
  summarize: "small",
  watch: "small",
};

export function tierForPurpose(purpose: ModelPurpose): ModelTierName {
  return PURPOSE_TIER[purpose];
}

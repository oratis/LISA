/** Operations are promises made by this host, for this caller and current run state. */
export interface FleetActions {
  observe: boolean;
  append: boolean;
  cancel: boolean;
  approve: boolean;
  resume: boolean;
  handoff: boolean;
}
export type FleetAgent = "claude-code" | "codex" | "codex-workspace";
export const observedActions: FleetActions = {
  observe: true,
  append: false,
  cancel: false,
  approve: false,
  resume: false,
  handoff: false,
};
export function runActions(
  agent: FleetAgent,
  state: string,
  live: boolean,
  control: boolean,
  pending: boolean,
  context: boolean,
): FleetActions {
  const active = control && live;
  return {
    ...observedActions,
    append: active && agent !== "codex" && state === "waiting",
    cancel: active && ["running", "waiting", "approval"].includes(state),
    approve: active && agent !== "codex" && state === "approval" && pending,
    // The host may separately offer a new continuation after verifying the old process stopped.
    handoff: control && !live && ["completed", "cancelled", "failed"].includes(state) && context,
  };
}

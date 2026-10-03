/**
 * The Task Engine's model-facing tools, as one list for the registry.
 *
 * Where they are offered (see registry.ts):
 *   - interactive chat on the Mac edition: all five;
 *   - unattended runs (heartbeat, idle, task runs) and remote channels: none —
 *     unattended work must not create more unattended work;
 *   - hosted edition: none, unless LISA_CLOUD_TASKS=1, and then never
 *     watch_create (hosted watchers are not supported yet).
 */
import type { ToolDefinition } from "../types.js";
import { taskCancelTool } from "./task_cancel.js";
import { taskCreateTool } from "./task_create.js";
import { taskListTool } from "./task_list.js";
import { taskUpdateTool } from "./task_update.js";
import { watchCreateTool } from "./watch_create.js";

export const taskEngineTools: ToolDefinition[] = [
  taskCreateTool,
  taskListTool,
  taskUpdateTool,
  taskCancelTool,
  watchCreateTool,
] as ToolDefinition[];

export const TASK_ENGINE_TOOL_NAMES: readonly string[] = taskEngineTools.map((t) => t.name);

/** The subset the hosted edition may expose when cloud tasks are switched on. */
export const CLOUD_TASK_TOOL_NAMES: ReadonlySet<string> = new Set([
  "task_create",
  "task_list",
  "task_update",
  "task_cancel",
]);

import type { ToolDefinition } from "../types.js";
import {
  appendMemory,
  readMemory,
  removeFromMemory,
  replaceInMemory,
  type MemoryStore,
} from "./store.js";

interface MemoryInput {
  action: "read" | "append" | "replace" | "remove";
  store?: MemoryStore;
  entry?: string;
  old_string?: string;
  new_string?: string;
  fragment?: string;
}

export const memoryTool: ToolDefinition<MemoryInput, string> = {
  name: "memory",
  description:
    "Manage Lisa's persistent memory across sessions. Two stores: " +
    "`memory` (your own observations and project facts) and " +
    "`user` (durable preferences about the human you assist). " +
    "Actions: `read`, `append` (adds a bullet), `replace` (exact-string edit), `remove` (drop lines containing a fragment). " +
    "Memory is appended to the system prompt at the start of each session — keep it terse, durable, non-obvious. " +
    "Do NOT store secrets or sensitive personal data.",
  inputSchema: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["read", "append", "replace", "remove"] },
      store: { type: "string", enum: ["memory", "user"], default: "memory" },
      entry: { type: "string" },
      old_string: { type: "string" },
      new_string: { type: "string" },
      fragment: { type: "string" },
    },
    required: ["action"],
  },
  async execute(input) {
    const store: MemoryStore = input.store ?? "memory";
    switch (input.action) {
      case "read": {
        const content = await readMemory(store);
        return content || `(${store} memory is empty)`;
      }
      case "append": {
        if (!input.entry) throw new Error("`entry` required for append");
        await appendMemory(store, input.entry);
        return `Appended to ${store} memory. New entries take effect next session.`;
      }
      case "replace": {
        if (input.old_string == null || input.new_string == null) {
          throw new Error("`old_string` and `new_string` required for replace");
        }
        await replaceInMemory(store, input.old_string, input.new_string);
        return `Replaced text in ${store} memory.`;
      }
      case "remove": {
        if (!input.fragment) throw new Error("`fragment` required for remove");
        await removeFromMemory(store, input.fragment);
        return `Removed matching lines from ${store} memory.`;
      }
      default:
        throw new Error(`unknown action: ${(input as { action: string }).action}`);
    }
  },
};

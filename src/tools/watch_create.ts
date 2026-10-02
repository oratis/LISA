/**
 * watch_create — Lisa drafts a watcher: "tell me when this page / feed /
 * mailbox shows X". Like task_create, the watcher is created DISABLED.
 *
 * A watcher polls without calling a model. By default a hit only notifies;
 * `on_hit: "run"` hands the observation to the instruction as data.
 */
import { createTask } from "../tasks/store.js";
import { parseNewTask } from "../tasks/validate.js";
import type { ToolDefinition } from "../types.js";
import { announce, atTaskLimit, confirmationCard, MAX_TASKS_FROM_TOOLS, toolContext } from "./task_common.js";

interface WatchCreateInput {
  title: string;
  source: "web" | "rss" | "mail";
  url?: string;
  mode?: "changed" | "appears" | "disappears" | "above" | "below";
  contains?: string;
  regex?: string;
  selector?: string;
  threshold?: number;
  keywords?: string[];
  from?: string;
  subject?: string;
  every?: string;
  on_hit?: "notify" | "run";
  instruction?: string;
}

export const watchCreateTool: ToolDefinition<WatchCreateInput, string> = {
  name: "watch_create",
  description:
    "Draft a watcher that checks something on a timer and tells the user when a condition is met — a " +
    "price drop, a slot opening, a page changing, a feed item matching keywords, mail from a sender. " +
    "source 'web': url + mode (changed | appears | disappears | above | below) with contains / regex / " +
    "selector (tag, #id, .class) and threshold for above/below. source 'rss': url + keywords. source " +
    "'mail': from and/or subject (needs the mail module connected). every: every:<n>(m|h|d), default " +
    "every:30m, minimum 5m. A hit notifies by default; on_hit 'run' runs `instruction` with the " +
    "observation. The watcher is created OFF — you cannot turn it on; tell the user it is waiting for them.",
  annotations: { title: "Create watcher", readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  inputSchema: {
    type: "object",
    properties: {
      title: { type: "string", minLength: 1, maxLength: 200 },
      source: { type: "string", enum: ["web", "rss", "mail"] },
      url: { type: "string", description: "http(s) URL of the page or feed (web / rss)." },
      mode: { type: "string", enum: ["changed", "appears", "disappears", "above", "below"], description: "web only. Default: changed." },
      contains: { type: "string", maxLength: 300, description: "Text to look for (appears / disappears)." },
      regex: { type: "string", maxLength: 300, description: "Regex; its first capture group (or whole match) is the watched value." },
      selector: { type: "string", maxLength: 300, description: "Narrow the page first: tag, #id or .class (e.g. span.price)." },
      threshold: { type: "number", description: "Number to compare against (above / below)." },
      keywords: { type: "array", items: { type: "string" }, maxItems: 64, description: "rss: any-of keywords; empty = every new item." },
      from: { type: "string", maxLength: 300, description: "mail: sender contains." },
      subject: { type: "string", maxLength: 300, description: "mail: subject contains." },
      every: { type: "string", description: "Poll interval, e.g. every:15m. Default every:30m." },
      on_hit: { type: "string", enum: ["notify", "run"], description: "notify (default) or run the instruction with the hit." },
      instruction: { type: "string", maxLength: 8000, description: "What to do on a hit when on_hit is 'run'; otherwise a note on why this is watched." },
    },
    required: ["title", "source"],
    additionalProperties: false,
  },
  async execute(input) {
    const ctx = toolContext();
    if (input.on_hit === "run" && !input.instruction?.trim()) {
      return "(not created: on_hit 'run' needs an instruction to run)";
    }
    const trigger: Record<string, unknown> = { kind: input.source };
    for (const key of ["url", "mode", "contains", "regex", "selector", "threshold", "keywords", "from", "subject", "every"] as const) {
      if (input[key] !== undefined) trigger[key] = input[key];
    }
    if (input.on_hit) trigger.onHit = input.on_hit;
    const parsed = parseNewTask(
      {
        kind: "watcher",
        title: input.title,
        instruction: input.instruction?.trim() || `Tell me when the watched condition is met: ${input.title}`,
        trigger,
      },
      { cloud: ctx.cloud, origin: { kind: "chat" }, owner: ctx.owner },
    );
    if (!parsed.ok) return `(not created: ${parsed.error})`;
    if (await atTaskLimit()) return `(not created: there are already ${MAX_TASKS_FROM_TOOLS} tasks — remove some first)`;
    const task = await createTask({ ...parsed.value, enabled: false, createdDisabled: true });
    announce(task);
    return confirmationCard(task, "Created");
  },
};

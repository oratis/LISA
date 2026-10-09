/**
 * Confirming a task's envelope — the only thing that turns it from a
 * restriction into a pre-approval.
 *
 * The model can draft a task and its envelope (`task_create`'s `tools`). That
 * draft restricts what the run is offered; it pre-approves nothing. When the
 * user enables the task they are shown, in plain words, what it would do
 * without asking, and only their confirmation of exactly that — recorded as a
 * digest of every field that reaches the run's prompt or bounds what a run may
 * do: the title (the first line of the prompt), the instruction, the schedule
 * or trigger, the host, the envelope, the notify mode and the budget — lets
 * Warden treat the envelope as "preapproved". Any change to any of them makes
 * the digest stop matching, so a confirmation never covers a task it was not
 * given for (#422 review N1).
 *
 * The stored confirmation is an HMAC of that digest (and the task id) under
 * the per-home key in `<lisaHome>/warden/` — the key Warden's approval digests
 * use, which no tool call can read without asking or write at all. A task file
 * written by anything but the user's own surface therefore cannot carry a
 * valid confirmation: a missing or wrong MAC reads as unconfirmed (#422
 * review N4).
 *
 * Pure but for `confirmationKey`. The callers that may confirm are the user's
 * own surfaces — `lisa tasks enable` and `PATCH /api/tasks/{id}` from a caller
 * who may approve. No model tool calls `confirmTask`.
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { loadDigestKey, readDigestKey } from "../warden/store.js";
import {
  DEFAULT_APPROVAL_WAIT_MS,
  DEFAULT_MAX_APPROVALS,
  type Task,
  type TaskEnvelopeConfirmation,
} from "./types.js";

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      out[key] = canonical((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

type Confirmable = Pick<
  Task,
  | "kind"
  | "title"
  | "instruction"
  | "schedule"
  | "trigger"
  | "host"
  | "envelope"
  | "notify"
  | "budget"
>;

/**
 * The digest of what a confirmation covers: sha256 hex of the canonical JSON
 * of every field that reaches the run's prompt frame (frame.ts) or bounds what
 * a run may do — the title, the instruction, the schedule, the trigger, the
 * host, the envelope, the notify mode and the budget, and the kind, which
 * decides how the schedule is read. Nothing the frame quotes from the task is
 * left out (#422 review N1).
 */
export function taskDigest(task: Confirmable): string {
  const content = {
    kind: task.kind,
    title: task.title,
    instruction: task.instruction,
    schedule: task.schedule ?? null,
    trigger: task.trigger ?? null,
    host: task.host,
    envelope: task.envelope ?? null,
    notify: task.notify,
    budget: task.budget,
  };
  return createHash("sha256")
    .update("lisa.task-confirmation.v2\n")
    .update(JSON.stringify(canonical(content)))
    .digest("hex");
}

/** Does the envelope name anything a confirmation could pre-approve (a tool or a category)? */
export function envelopeCouldPreapprove(task: Pick<Task, "envelope">): boolean {
  const envelope = task.envelope;
  return (
    !!envelope && ((envelope.tools?.length ?? 0) > 0 || (envelope.categories?.length ?? 0) > 0)
  );
}

/** True when the user confirmed the task exactly as it is now. */
/**
 * The key a confirmation is signed with: the home's Warden digest key
 * (`<home>/warden/digest.key`). `create` only where the user is confirming —
 * a check never creates it, so it never brings a deleted home back; with no
 * key, nothing is confirmed. An unreadable or malformed key is null too: it
 * can only cost a pre-approval, never grant one.
 */
export async function confirmationKey(
  opts: { create?: boolean; home?: string } = {},
): Promise<Buffer | null> {
  try {
    return opts.create ? await loadDigestKey(opts.home) : await readDigestKey(opts.home);
  } catch {
    if (opts.create) throw new Error("the confirmation key could not be read or created");
    return null;
  }
}

function confirmationMac(key: Buffer, taskId: string, digest: string): string {
  return createHmac("sha256", key)
    .update("lisa.task-confirmation.mac.v1\n")
    .update(`${taskId}\n${digest}`)
    .digest("hex");
}

/** True when the user confirmed the task exactly as it is now, signed with this home's key. */
export function isEnvelopeConfirmed(
  task: Confirmable & Pick<Task, "id" | "envelopeConfirmation">,
  key: Buffer | null,
): boolean {
  const confirmation = task.envelopeConfirmation;
  if (!key || typeof confirmation?.digest !== "string" || typeof confirmation.mac !== "string") {
    return false;
  }
  const digest = taskDigest(task);
  if (confirmation.digest !== digest) return false;
  const expected = Buffer.from(confirmationMac(key, task.id, digest), "hex");
  const stored = Buffer.from(confirmation.mac, "hex");
  return stored.length === expected.length && timingSafeEqual(stored, expected);
}

/** Record the user's confirmation of the task as it is now. */
export function confirmTask(
  task: Task,
  now: number,
  via: TaskEnvelopeConfirmation["via"],
  key: Buffer,
): void {
  const digest = taskDigest(task);
  task.envelopeConfirmation = { digest, mac: confirmationMac(key, task.id, digest), at: now, via };
}

/** A stored confirmation, if it has the right shape; anything else is dropped (it can only grant). */
export function parseConfirmation(value: unknown): TaskEnvelopeConfirmation | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const v = value as Record<string, unknown>;
  if (typeof v.digest !== "string" || !/^[0-9a-f]{64}$/.test(v.digest)) return undefined;
  // No MAC (a confirmation from before it was signed, or a hand-written one): not a confirmation.
  if (typeof v.mac !== "string" || !/^[0-9a-f]{64}$/.test(v.mac)) return undefined;
  if (typeof v.at !== "number" || !Number.isFinite(v.at)) return undefined;
  if (v.via !== "cli" && v.via !== "api") return undefined;
  return { digest: v.digest, mac: v.mac, at: v.at, via: v.via };
}

// ── what the user is shown ──

const CATEGORY_WORDS: Readonly<Record<string, string>> = Object.freeze({
  read: "read files and pages (reads never ask anyway)",
  self: "write Lisa's own memory and notes",
  draft: "write drafts",
  write: "write files",
  exec: "run commands",
  network: "send requests to other services",
  send: "send messages",
  publish: "publish or post",
  delete: "delete things",
  purchase: "buy things (never: purchases are always handed back to you)",
  credential: "enter credentials (never: always handed back to you)",
});

const TOOL_WORDS: Readonly<Record<string, string>> = Object.freeze({
  bash: "run shell commands",
  write: "write files",
  edit: "edit files",
  apply_patch: "change and delete files",
  web_fetch: "fetch web pages",
  web_search: "search the web",
  github: "act on GitHub (including comments and merges)",
  memory: "write Lisa's memory",
  kb_write: "write the knowledge base",
  kb_add: "add to the knowledge base",
  takoapi: "call remote agents",
});

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

const HOST_WORDS: Readonly<Record<Task["host"], string>> = Object.freeze({
  home: "this Mac only",
  cloud: "the hosted edition only",
  any: "this Mac or the hosted edition",
});

function budgetWords(budget: Task["budget"]): string {
  const parts = [
    `${budget.tokens} tokens`,
    `${Math.round(budget.wallclockMs / 60_000)} min`,
    `${budget.maxToolCalls} tool calls`,
  ];
  if (budget.usdMicros !== undefined) parts.push(`$${(budget.usdMicros / 1_000_000).toFixed(2)}`);
  parts.push(
    `at most ${budget.maxApprovals ?? DEFAULT_MAX_APPROVALS} approvals asked`,
    `${Math.round((budget.approvalWaitMs ?? DEFAULT_APPROVAL_WAIT_MS) / 60_000)} min waiting for them`,
  );
  return parts.join(", ");
}

function whenWords(task: Confirmable): string {
  if (task.trigger) {
    const t = task.trigger;
    const every = (t.every ?? "every:30m").replace("every:", "");
    const what =
      t.kind === "web"
        ? `the page ${t.url} (${t.mode})`
        : t.kind === "rss"
          ? `the feed ${t.url}${t.keywords?.length ? ` for ${t.keywords.join(", ")}` : ""}`
          : `your mail${t.from ? ` from "${t.from}"` : ""}${t.subject ? ` with subject "${t.subject}"` : ""}`;
    const onHit =
      t.onHit === "run"
        ? "on a hit it runs the instruction with what it found"
        : "on a hit it tells you";
    return `watches ${what}, checked every ${every}; ${onHit}`;
  }
  if (task.schedule) {
    return `${task.schedule.expr}${task.schedule.tz ? ` (${task.schedule.tz})` : ""}`;
  }
  return "once, as soon as it is on";
}

/**
 * The confirmation screen, in plain words: what runs, when, and which actions
 * would run without asking. The same lines are printed by `lisa tasks show` /
 * `enable` and returned by `GET /api/tasks/{id}`.
 */
export function describeForConfirmation(task: Confirmable): string[] {
  const lines = [
    `Title: ${task.title}`,
    `Instruction: ${clip(task.instruction, 600)}`,
    `When: ${whenWords(task)}`,
    `Runs on: ${HOST_WORDS[task.host]}`,
    `Tells you: ${task.notify}`,
    `Budget per run: ${budgetWords(task.budget)}`,
  ];
  const envelope = task.envelope;
  if (!envelopeCouldPreapprove(task)) {
    lines.push(
      "Nothing is pre-approved: every action with a side effect asks you first (with Warden on) or is not run.",
    );
    if (envelope?.tools?.length) lines.push(`It may only use: ${envelope.tools.join(", ")}.`);
    return lines;
  }
  lines.push("If you confirm, these actions will run without asking:");
  for (const tool of envelope!.tools ?? []) {
    const words = Object.hasOwn(TOOL_WORDS, tool) ? TOOL_WORDS[tool] : undefined;
    lines.push(`  - the tool ${tool}${words ? ` (${words})` : ""}`);
  }
  for (const category of envelope!.categories ?? []) {
    const words = Object.hasOwn(CATEGORY_WORDS, category) ? CATEGORY_WORDS[category] : undefined;
    lines.push(
      words
        ? `  - any "${category}" action: ${words}`
        : `  - "${category}" (a label, not a permission: it pre-approves nothing)`,
    );
  }
  lines.push(
    envelope!.targets?.length ? `  …only on: ${envelope!.targets.join(", ")}` : "  …on any target.",
  );
  if (envelope!.tools?.length) lines.push(`It may only use: ${envelope!.tools.join(", ")}.`);
  lines.push(
    "Even then it asks first before it runs a command, sends, publishes, deletes, makes another " +
      "network write or writes outside its own folder once the run has read outside content " +
      "(a web page, a mail, a watcher hit). Purchases and credentials are always handed back to you.",
    "This applies only while the server runs with Warden on; otherwise an unattended run makes read-only calls only.",
  );
  return lines;
}

export interface TaskConfirmationView {
  /** What `--confirm` / `confirmEnvelope` must name to confirm the task as it is now. */
  digest: string;
  /** The user confirmed the task as it is now. */
  confirmed: boolean;
  /** The envelope names something a confirmation would pre-approve. */
  preapproves: boolean;
  summary: string[];
}

export function confirmationView(task: Task, key: Buffer | null): TaskConfirmationView {
  return {
    digest: taskDigest(task),
    confirmed: isEnvelopeConfirmed(task, key),
    preapproves: envelopeCouldPreapprove(task),
    summary: describeForConfirmation(task),
  };
}

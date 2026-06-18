/**
 * Managed agents — the controllable unit of the agent control plane.
 *
 * Unlike an externally-started CLI (observe + cancel only — different identity
 * space, no control channel), a managed agent is one LISA runs itself by looping
 * `runAgent`: it has a stable id, streams live progress, takes follow-up
 * commands, pauses on every mutating tool for the user's approve/deny, and
 * cancels cleanly. This is how the user "sends commands to a running agent."
 *
 * Tool policy (per product decision): FULL tools, but every mutating call
 * (DEFAULT_MUTATING_TOOLS / DEFAULT_MUTATING_ACTIONS) blocks on a UI decision —
 * so an unattended managed agent can't write/exec without explicit approval.
 */
import { EventEmitter } from "node:events";
import { runAgent } from "../agent.js";
import { DEFAULT_MODEL } from "../llm.js";
import { providerForModel } from "../providers/registry.js";
import {
  isMutatingCall,
  DEFAULT_MUTATING_TOOLS,
  DEFAULT_MUTATING_ACTIONS,
  type ApprovalConfig,
} from "../approval.js";
import type { Provider } from "../providers/types.js";
import type { AgentEvent, StoredMessage, ToolDefinition } from "../types.js";

export type ManagedState = "working" | "waiting" | "error" | "done";

/** Public, serializable snapshot of a managed agent. */
export interface ManagedView {
  id: string;
  project: string;
  cwd: string;
  model: string;
  state: ManagedState;
  stateReason: string;
  lastMtime: number;
  turnCount: number;
  tokens: { input: number; output: number };
  lastTools: string[];
  filesTouched: string[];
  lastText: string;
  /** Set while paused awaiting approve/deny of a mutating tool. */
  pending?: { tool: string };
}

export interface ManagedStartOpts {
  task: string;
  cwd: string;
  systemPrompt: string;
  tools: ToolDefinition[];
  model?: string;
  /** Injectable provider (tests); defaults to providerForModel(model). */
  provider?: Provider;
  /** Override the clock (tests). */
  now?: () => number;
}

const MAX_TOOLS = 6;
const MAX_FILES = 10;
const APPROVAL_CFG: ApprovalConfig = {
  mode: "ask-mutating",
  mutatingTools: DEFAULT_MUTATING_TOOLS,
  mutatingActions: DEFAULT_MUTATING_ACTIONS,
};

let counter = 0;

export class ManagedAgent {
  readonly id: string;
  readonly cwd: string;
  readonly project: string;
  readonly model: string;
  state: ManagedState = "working";
  stateReason = "starting";
  lastMtime: number;
  turnCount = 0;
  private tokensIn = 0;
  private tokensOut = 0;
  lastTools: string[] = [];
  filesTouched: string[] = [];
  lastText = "";
  pending?: { tool: string; resolve: (allow: boolean) => void };
  /** Set by the registry to broadcast snapshots. */
  onChange: () => void = () => {};

  private history: StoredMessage[] = [];
  private readonly tools: ToolDefinition[];
  private readonly systemPrompt: string;
  private readonly provider: Provider;
  private readonly ac = new AbortController();
  private readonly now: () => number;
  private queue: string[] = [];
  private wake?: () => void;

  constructor(opts: ManagedStartOpts) {
    this.id = "m" + (++counter).toString(36) + "-" + this.now0().toString(36).slice(-4);
    this.cwd = opts.cwd;
    this.project = opts.cwd.split("/").filter(Boolean).pop() || opts.cwd;
    this.model = opts.model ?? DEFAULT_MODEL;
    this.provider = opts.provider ?? providerForModel(this.model);
    this.tools = opts.tools;
    this.systemPrompt = opts.systemPrompt;
    this.now = opts.now ?? Date.now;
    this.lastMtime = this.now();
    this.queue.push(opts.task);
    void this.runLoop();
  }

  // Date.now indirection only for the id seed (constructor runs before this.now set).
  private now0(): number {
    return Date.now();
  }

  /** Queue a follow-up command; wakes the loop if it's idle. */
  send(text: string): void {
    if (this.ac.signal.aborted) return;
    this.queue.push(text);
    this.wake?.();
  }

  /** Resolve a pending approve/deny. Returns false if nothing is pending. */
  decide(allow: boolean): boolean {
    if (!this.pending) return false;
    const p = this.pending;
    this.setState("working", "running");
    p.resolve(allow);
    return true;
  }

  /** Abort the run; unblocks any pending tool/input. */
  cancel(): void {
    if (this.ac.signal.aborted) return;
    this.ac.abort();
    this.pending?.resolve(false);
    this.wake?.();
    this.setState("done", "cancelled");
  }

  view(): ManagedView {
    return {
      id: this.id,
      project: this.project,
      cwd: this.cwd,
      model: this.model,
      state: this.state,
      stateReason: this.stateReason,
      lastMtime: this.lastMtime,
      turnCount: this.turnCount,
      tokens: { input: this.tokensIn, output: this.tokensOut },
      lastTools: [...this.lastTools],
      filesTouched: [...this.filesTouched],
      lastText: this.lastText,
      ...(this.pending ? { pending: { tool: this.pending.tool } } : {}),
    };
  }

  // ── internals ──

  private async runLoop(): Promise<void> {
    while (!this.ac.signal.aborted) {
      const message = await this.nextInput();
      if (message === null) break;
      this.setState("working", "running");
      try {
        const result = await runAgent({
          provider: this.provider,
          systemPrompt: this.systemPrompt,
          tools: this.tools,
          toolCtx: { cwd: this.cwd, signal: this.ac.signal, log: () => {} },
          history: this.history,
          userMessage: message,
          model: this.model,
          maxIterations: 64,
          onEvent: (e) => this.onAgentEvent(e),
          approval: (tool, input) => this.approve(tool, input),
        });
        this.history = result.history;
        this.tokensIn += result.inputTokens;
        this.tokensOut += result.outputTokens;
        if (result.finalText) this.lastText = result.finalText;
        this.setState("waiting", result.stopReason);
      } catch (err) {
        if (this.ac.signal.aborted) break;
        this.setState("error", (err as Error).message.slice(0, 80));
      }
    }
    if (this.state !== "done") this.setState("done", "done");
  }

  /** Resolve with the next queued command, or null when cancelled. */
  private nextInput(): Promise<string | null> {
    if (this.ac.signal.aborted) return Promise.resolve(null);
    if (this.queue.length) return Promise.resolve(this.queue.shift()!);
    return new Promise((resolve) => {
      this.wake = () => {
        this.wake = undefined;
        resolve(this.ac.signal.aborted ? null : this.queue.shift() ?? null);
      };
    });
  }

  /** Approval callback: auto-allow safe tools; block mutating ones on a UI decision. */
  private approve(tool: string, input: unknown): Promise<{ allow: boolean; reason?: string }> {
    if (!isMutatingCall(APPROVAL_CFG, tool, input)) return Promise.resolve({ allow: true });
    return new Promise((resolve) => {
      this.pending = {
        tool,
        resolve: (allow) => {
          this.pending = undefined;
          resolve(allow ? { allow: true } : { allow: false, reason: "denied in Lisa" });
        },
      };
      this.setState("waiting", "permission");
    });
  }

  private onAgentEvent(e: AgentEvent): void {
    if (e.type === "turn_start") this.turnCount++;
    if (e.type === "tool_call_start") {
      if (e.toolName) {
        this.lastTools.push(e.toolName);
        if (this.lastTools.length > MAX_TOOLS) this.lastTools.shift();
      }
      const input = e.toolInput as Record<string, unknown> | undefined;
      const p = input && (input.file_path ?? input.path ?? input.filename);
      if (typeof p === "string" && p) {
        this.filesTouched.push(p);
        if (this.filesTouched.length > MAX_FILES) this.filesTouched.shift();
      }
    }
    if (e.type === "text_delta" && e.text) this.lastText = (this.lastText + e.text).slice(-2000);
    this.touch();
  }

  private setState(s: ManagedState, reason: string): void {
    this.state = s;
    this.stateReason = reason;
    this.touch();
  }

  private touch(): void {
    this.lastMtime = this.now();
    this.onChange();
  }
}

/** Process-wide registry of managed agents; emits "update" with a ManagedView. */
export class ManagedRegistry extends EventEmitter {
  private agents = new Map<string, ManagedAgent>();

  start(opts: ManagedStartOpts): ManagedView {
    const a = new ManagedAgent(opts);
    a.onChange = () => this.emit("update", a.view());
    this.agents.set(a.id, a);
    this.emit("update", a.view());
    return a.view();
  }

  send(id: string, text: string): boolean {
    const a = this.agents.get(id);
    if (!a) return false;
    a.send(text);
    return true;
  }

  decide(id: string, allow: boolean): boolean {
    return this.agents.get(id)?.decide(allow) ?? false;
  }

  cancel(id: string): boolean {
    const a = this.agents.get(id);
    if (!a) return false;
    a.cancel();
    return true;
  }

  get(id: string): ManagedAgent | undefined {
    return this.agents.get(id);
  }

  list(): ManagedView[] {
    return [...this.agents.values()].map((a) => a.view());
  }
}

export const managedRegistry = new ManagedRegistry();

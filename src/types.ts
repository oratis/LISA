import type Anthropic from "@anthropic-ai/sdk";

export type Role = "user" | "assistant";

export interface ToolDefinition<TInput = unknown, TOutput = unknown> {
  name: string;
  description: string;
  inputSchema: Anthropic.Tool.InputSchema;
  /**
   * MCP-compatible behavior hints. These are metadata for UX/policy inputs,
   * never proof that an untrusted tool is safe.
   */
  annotations?: {
    title?: string;
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
  execute(input: TInput, ctx: ToolContext): Promise<TOutput>;
  renderResultForModel?(result: TOutput): string;
}

export interface ToolContext {
  cwd: string;
  signal: AbortSignal;
  log: (msg: string) => void;
  /**
   * Set by the agent loop. soul_object calls this to register an
   * architectural objection that must be surfaced in Lisa's reply
   * before the turn is considered closed. (Phase 2.1)
   */
  onObjection?: (o: { reason: string; refusing: boolean; userRequestSummary: string }) => void;
  /**
   * The execution world filesystem/shell tools act on (H1, see
   * docs/PLAN_HARNESS_ALIGNMENT_v1.0.md §2). Unset means the host's own disk
   * and shell — swapping it (sandboxed, per-tenant, remote) redirects every
   * fs/shell tool at once without touching tool code.
   *
   * Tools read this through `capsOf(ctx)` from src/capabilities/, never
   * directly, so the local default is applied in exactly one place.
   */
  caps?: import("./capabilities/types.js").Capabilities;
  /**
   * The sandbox mode this turn is pinned to (H2). When `caps` is unset, this is
   * what `capsOf` resolves the world from — so a session pinned to `read-only`
   * confines its writes/shell even though the process-wide `LISA_SANDBOX_MODE`
   * default says otherwise, and two concurrent sessions can differ. Unset ⇒ the
   * environment default (`resolveSandboxMode()` re-read per call).
   */
  sandboxMode?: import("./sandbox/mode.js").SandboxMode;
}

export type StoredMessage = Anthropic.MessageParam;

export interface SkillFrontmatter {
  name: string;
  description: string;
  version?: string;
  tags?: string[];
}

export interface Skill {
  frontmatter: SkillFrontmatter;
  body: string;
  path: string;
}

export interface SessionHeader {
  type: "session";
  id: string;
  /**
   * 1 — messages only. 2 — adds `prompt` entries (H3, see
   * docs/PLAN_HARNESS_ALIGNMENT_v1.0.md §4). Readers never branch on this:
   * every entry reader skips unknown `type`s, so a v1 file reads fine and a
   * v2 file reads fine in older builds. It exists to tell an *analysis* pass
   * whether the absence of `prompt` entries means "not recorded" (v1) or
   * "genuinely unchanged" (v2).
   */
  version: 1 | 2;
  startedAt: string;
  cwd: string;
  model: string;
  /**
   * The sandbox mode this session runs under (H2). Fixed when the session is
   * created and never re-read: changing a setting mid-flight must not silently
   * widen — or narrow — what an already-running task is allowed to do.
   *
   * Optional because sessions written before H2 do not have it; absent means
   * "not recorded", not "unconfined".
   */
  sandboxMode?: import("./sandbox/mode.js").SandboxMode;
}

export type SessionEntry =
  | { type: "message"; ts: string; message: StoredMessage }
  | { type: "model_change"; ts: string; model: string }
  | { type: "reflection"; ts: string; summary: string }
  /**
   * The system prompt as the model actually saw it (H3 — "model-visible ⟺
   * recorded"). Written before the first provider call of a run and again
   * whenever mid-session hot-reload swaps it, so a historical session can be
   * replayed with the persona that was live at each turn. `fingerprint` is a
   * content hash of `text`; consecutive identical ones are not re-written, so
   * "the prompt in effect at entry N" is the nearest preceding prompt entry.
   */
  | {
      type: "prompt";
      ts: string;
      fingerprint: string;
      text: string;
      reason: "initial" | "rebuilt";
    };

export interface AgentEvent {
  type:
    | "turn_start"
    | "text_delta"
    | "thinking_delta"
    | "tool_call_start"
    | "tool_call_end"
    | "turn_end"
    | "error"
    | "info"
    | "system_prompt_rebuilt";
  text?: string;
  toolName?: string;
  toolInput?: unknown;
  toolResult?: unknown;
  isError?: boolean;
  message?: string;
}

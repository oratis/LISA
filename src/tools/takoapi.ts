/**
 * `takoapi` tool — reach remote agents through TakoAPI (PLAN_DISPATCH_v1.0 D2a).
 *
 * TakoAPI (https://takoapi.com) is "OpenRouter for agents": one key, any
 * registered agent. This tool lets Lisa, mid-conversation, DISCOVER a remote
 * agent by capability and CALL it (A2A `message`) — delegating a task that a
 * specialized remote agent handles better than she would directly. The richer
 * native hub integration (remote agents as first-class sessions) is D2b; this
 * is the near-free discover+call entry point.
 *
 * Outbound + spends the user's TAKO_KEY, so it's gated out of autonomous and
 * remote-origin runs (see AUTONOMOUS_BLOCKED_TOOL_NAMES). The HTTP layer is
 * injectable so the logic is unit-testable without hitting the network.
 */
import type { ToolDefinition } from "../types.js";
import { extractTaskState } from "../integrations/takoapi/a2a.js";
import { recordTakoCall } from "../integrations/takoapi/ledger.js";

const DEFAULT_BASE = "https://takoapi.com";
function base(): string {
  return (process.env.TAKOAPI_BASE_URL ?? DEFAULT_BASE).replace(/\/$/, "");
}

export interface HttpResponse {
  ok: boolean;
  status: number;
  body: string;
}
export interface TakoFetcher {
  get(url: string): Promise<HttpResponse>;
  postJson(url: string, body: unknown, headers: Record<string, string>): Promise<HttpResponse>;
}

const defaultFetcher: TakoFetcher = {
  async get(url) {
    try {
      const r = await fetch(url, { headers: { accept: "application/json" } });
      return { ok: r.ok, status: r.status, body: await r.text() };
    } catch (e) {
      return { ok: false, status: 0, body: (e as Error).message };
    }
  },
  async postJson(url, body, headers) {
    try {
      const r = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
      });
      return { ok: r.ok, status: r.status, body: await r.text() };
    } catch (e) {
      return { ok: false, status: 0, body: (e as Error).message };
    }
  },
};

/** Format a /api/registry response into a readable agent list. Pure. */
export function formatRegistry(body: string, limit = 10): string {
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return "(could not parse the TakoAPI registry response)";
  }
  const j = json as Record<string, unknown>;
  const arr = Array.isArray(json) ? json : (j.agents ?? j.data ?? j.results ?? []);
  if (!Array.isArray(arr) || arr.length === 0) return "(no matching agents found)";
  return arr
    .slice(0, limit)
    .map((raw) => {
      const a = raw as Record<string, unknown>;
      const name = (a.name ?? a.slug ?? "(unnamed)") as string;
      const slug = (a.slug ?? "") as string;
      const desc = String(a.description ?? a.summary ?? "").replace(/\s+/g, " ").slice(0, 100);
      const skills = Array.isArray(a.skills)
        ? a.skills
            .map((s) => (typeof s === "string" ? s : (s as Record<string, unknown>)?.name))
            .filter(Boolean)
            .slice(0, 4)
            .join(", ")
        : "";
      return `- ${name}${slug ? ` (slug: ${slug})` : ""}${desc ? ` — ${desc}` : ""}${skills ? ` [${skills}]` : ""}`;
    })
    .join("\n");
}

/** Pull a text reply out of an A2A / OpenAI-shim response, tolerating shapes. Pure. */
export function extractAgentReply(body: string): string {
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return body.slice(0, 2000); // non-JSON → return raw, truncated
  }
  const j = json as Record<string, any>;
  const partsText = (parts: unknown): string | undefined =>
    Array.isArray(parts)
      ? parts.map((p) => (p as Record<string, unknown>)?.text).filter((t) => typeof t === "string").join("\n")
      : undefined;
  const candidates: Array<unknown> = [
    j?.choices?.[0]?.message?.content, // OpenAI-compat shim
    partsText(j?.message?.parts), // A2A message
    partsText(j?.parts),
    j?.text,
    j?.reply,
    j?.output,
    j?.result,
    typeof j?.message === "string" ? j.message : undefined,
  ];
  for (const c of candidates) if (typeof c === "string" && c.trim()) return c.trim();
  return JSON.stringify(json).slice(0, 2000);
}

/** Discover agents in the public registry (no auth). */
export async function takoDiscover(query: string, f: TakoFetcher = defaultFetcher): Promise<string> {
  const url = `${base()}/api/registry?format=json${query ? `&q=${encodeURIComponent(query)}` : ""}`;
  const res = await f.get(url);
  if (!res.ok) return `TakoAPI registry unreachable (status ${res.status || "network error"}).`;
  return formatRegistry(res.body);
}

export interface TakoCallResult {
  /** Did we reach the agent and get a non-error response? */
  ok: boolean;
  status: number;
  /** Formatted reply (or a human error string) — what the tool returns to LISA. */
  reply: string;
  /** A2A TaskState observed for the call (D2b ledger). "completed" for a plain
   *  sync reply; the agent's own task state if the response carried a Task. */
  taskState: string;
  /** A2A task id, if the response carried one. */
  taskId?: string;
}

/**
 * Call an agent via the A2A message endpoint with the user's key, returning both
 * the reply and the observed A2A task state (for the D2b call ledger). Pure
 * w.r.t. fs — recording is the caller's job, so existing `takoCall` tests stay
 * side-effect-free.
 */
export async function takoCallDetailed(
  slug: string,
  text: string,
  key: string,
  f: TakoFetcher = defaultFetcher,
): Promise<TakoCallResult> {
  const url = `${base()}/v1/agents/${encodeURIComponent(slug)}/message`;
  const res = await f.postJson(url, { text }, { authorization: `Bearer ${key}` });
  if (res.status === 401) {
    return {
      ok: false,
      status: 401,
      reply: "TakoAPI rejected the key (401). Check TAKO_KEY at https://takoapi.com/dashboard.",
      taskState: "rejected",
    };
  }
  if (!res.ok) {
    return {
      ok: false,
      status: res.status,
      reply: `TakoAPI call to "${slug}" failed (status ${res.status || "network error"}).`,
      taskState: "failed",
    };
  }
  const task = extractTaskState(res.body); // {state, taskId} | null
  return {
    ok: true,
    status: res.status,
    reply: extractAgentReply(res.body),
    taskState: task?.state ?? "completed",
    ...(task?.taskId ? { taskId: task.taskId } : {}),
  };
}

/** Call an agent via the A2A message endpoint with the user's key. */
export async function takoCall(
  slug: string,
  text: string,
  key: string,
  f: TakoFetcher = defaultFetcher,
): Promise<string> {
  return (await takoCallDetailed(slug, text, key, f)).reply;
}

interface TakoInput {
  action: "discover" | "call";
  query?: string;
  slug?: string;
  text?: string;
}

export const takoapiTool: ToolDefinition<TakoInput, string> = {
  name: "takoapi",
  description:
    "Reach remote AI agents through TakoAPI (https://takoapi.com) — one key, any agent. " +
    "action='discover' searches the agent registry (optionally by `query`); action='call' sends `text` " +
    "to the agent with the given `slug` and returns its reply. Use when a task is better handled by a " +
    "specialized remote agent than by you. 'call' requires TAKO_KEY (free key at /dashboard).",
  inputSchema: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["discover", "call"] },
      query: { type: "string", description: "search terms (for discover)" },
      slug: { type: "string", description: "agent slug (for call)" },
      text: { type: "string", description: "the request to send the agent (for call)" },
    },
    required: ["action"],
  },
  async execute(input) {
    if (input.action === "discover") return await takoDiscover(input.query ?? "");
    if (input.action === "call") {
      if (!input.slug || !input.text) return "call needs both `slug` and `text`.";
      const key = process.env.TAKO_KEY?.trim();
      if (!key) {
        return "TAKO_KEY is not set — create one at https://takoapi.com/dashboard and add it to ~/.lisa/config.env.";
      }
      const r = await takoCallDetailed(input.slug, input.text, key);
      // D2b — record the delegation so the agent shows up as a session in the
      // hub (with its A2A TaskState). Best-effort: a ledger write must never
      // break the reply. Only successful calls are recorded (so transient
      // transport errors don't manufacture error-sessions); a genuine agent
      // task failure arrives as ok=true with taskState="failed".
      if (r.ok) {
        try {
          recordTakoCall({ slug: input.slug, state: r.taskState, taskId: r.taskId });
        } catch {
          /* ledger unavailable — surface the reply anyway */
        }
      }
      return r.reply;
    }
    return `unknown action "${(input as { action: string }).action}" — use "discover" or "call".`;
  },
};

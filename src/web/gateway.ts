/**
 * LISA inference gateway — key-free managed inference for signed-in clients
 * (docs/PLAN_ACCOUNTS_BILLING_v1.0.md §6.6, milestone B6).
 *
 * A signed-in Mac / CLI / app with NO provider key of its own sends its LLM
 * calls here instead of to the provider: the uid-authed key-swap descendant of
 * packaging/gcp-relay. Two upstream protocol faces:
 *
 *   POST /gw/anthropic/v1/messages          → api.anthropic.com (x-api-key swap)
 *   POST /gw/openai/v1/chat/completions     → the model's OpenAI-compatible
 *                                             preset (GLM → open.bigmodel.cn)
 *
 * Per request: session auth (handled by the server gate — accountUid arrives
 * here non-null), quota precheck (B4; premium models need paid balance),
 * key-swap, streaming passthrough with a tee-parser that extracts token usage
 * from the stream itself, then metering + debit into the uid's ledger.
 *
 * PRIVACY BOUNDARY (documented in the plan + site): prompts TRANSIT this
 * process over TLS and are never persisted; the ledger stores token counts
 * and the model name only.
 */
import type http from "node:http";
import { findPreset } from "../providers/registry.js";
import type { ProviderUsage } from "../providers/types.js";
import type { AccountRecord } from "./accounts.js";
import { precheckTurn, debitTurn } from "../billing/quota.js";
import { recordUsage } from "../billing/meter.js";
import { preflightLimits } from "../billing/limits.js";
import { readCappedText, BodyTooLargeError } from "./http-body.js";

/**
 * Gateway body cap (#266). Far larger than the control-plane cap: LLM payloads
 * legitimately carry base64 images and long transcripts. Bounded all the same —
 * an unbounded read OOMs the instance before any quota gate runs.
 */
const GW_BODY_LIMIT = Number(process.env.LISA_GW_MAX_BODY_MB || 20) * 1_048_576;

/** Chars-per-token used only for the missing-usage debit floor (#264). */
const BYTES_PER_TOKEN_EST = 4;

export interface UpstreamPlan {
  url: string;
  headers: Record<string, string>;
}

/**
 * Where does this gateway call go, and with which swapped-in credentials?
 * Returns null when the operator has no key for the model's provider.
 */
export function planUpstream(
  face: "anthropic" | "openai",
  subpath: string,
  model: string,
  clientHeaders: http.IncomingHttpHeaders,
  env: Record<string, string | undefined> = process.env,
): UpstreamPlan | null {
  if (face === "anthropic") {
    const key = env.ANTHROPIC_API_KEY;
    if (!key) return null;
    const version = typeof clientHeaders["anthropic-version"] === "string"
      ? clientHeaders["anthropic-version"]
      : "2023-06-01";
    return {
      url: `https://api.anthropic.com${subpath}`,
      headers: {
        "content-type": "application/json",
        "x-api-key": key,
        "anthropic-version": version,
      },
    };
  }
  // OpenAI-compatible face: route by the model's preset (GLM → bigmodel), else
  // vanilla OpenAI.
  const preset = findPreset(model);
  const base = preset ? preset.baseURL : "https://api.openai.com/v1";
  const key = preset ? env[preset.apiKeyEnv] : env.OPENAI_API_KEY;
  if (!key) return null;
  return {
    url: `${base.replace(/\/$/, "")}${subpath}`,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${key}`,
    },
  };
}

const ZERO: ProviderUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };

/**
 * Fold one upstream SSE `data:` JSON object into the running usage.
 * Anthropic: message_start carries input/cache counts, message_delta the
 * output count. OpenAI-compat: the final chunk (stream_options.include_usage)
 * carries {usage:{prompt_tokens, completion_tokens}}.
 */
export function foldUsage(face: "anthropic" | "openai", obj: Record<string, unknown>, acc: ProviderUsage): ProviderUsage {
  if (face === "anthropic") {
    if (obj.type === "message_start") {
      const usage = ((obj.message as Record<string, unknown> | undefined)?.usage ?? {}) as Record<string, unknown>;
      return {
        ...acc,
        inputTokens: acc.inputTokens + num(usage.input_tokens),
        cacheReadTokens: acc.cacheReadTokens + num(usage.cache_read_input_tokens),
        cacheWriteTokens: acc.cacheWriteTokens + num(usage.cache_creation_input_tokens),
        outputTokens: acc.outputTokens + num(usage.output_tokens),
      };
    }
    if (obj.type === "message_delta") {
      const usage = (obj.usage ?? {}) as Record<string, unknown>;
      return { ...acc, outputTokens: acc.outputTokens + num(usage.output_tokens) };
    }
    return acc;
  }
  const usage = obj.usage as Record<string, unknown> | undefined | null;
  if (usage && typeof usage === "object") {
    return {
      ...acc,
      inputTokens: acc.inputTokens + num(usage.prompt_tokens),
      outputTokens: acc.outputTokens + num(usage.completion_tokens),
    };
  }
  return acc;
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/**
 * Debit floor for an upstream that answered 2xx but reported no usage (#264).
 * Without it a provider that omits the usage block — or an SSE stream the
 * client cut before the usage chunk — bills 0, i.e. free inference. A coarse
 * bytes/4 estimate is wrong in the user's favour on cache-heavy turns and in
 * ours on nothing, which is the right direction to be wrong in.
 */
export function estimateUsageFromBytes(requestBytes: number, responseBytes: number): ProviderUsage {
  return {
    inputTokens: Math.ceil(Math.max(0, requestBytes) / BYTES_PER_TOKEN_EST),
    outputTokens: Math.ceil(Math.max(0, responseBytes) / BYTES_PER_TOKEN_EST),
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  };
}

/** True when the upstream reported nothing billable at all. */
function usageIsEmpty(u: ProviderUsage): boolean {
  return u.inputTokens === 0 && u.outputTokens === 0 && u.cacheReadTokens === 0 && u.cacheWriteTokens === 0;
}

/** Extract usage from a NON-streaming upstream JSON response body. */
export function usageFromJson(face: "anthropic" | "openai", body: Record<string, unknown>): ProviderUsage {
  if (face === "anthropic") {
    const usage = (body.usage ?? {}) as Record<string, unknown>;
    return {
      inputTokens: num(usage.input_tokens),
      outputTokens: num(usage.output_tokens),
      cacheReadTokens: num(usage.cache_read_input_tokens),
      cacheWriteTokens: num(usage.cache_creation_input_tokens),
    };
  }
  return foldUsage("openai", body, ZERO);
}

/**
 * Handle one gateway request (server.ts routes /gw/* here AFTER the auth gate
 * has established the account session + entered the per-uid home scope).
 */
export async function handleGateway(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: string,
  acct: AccountRecord,
): Promise<void> {
  const face: "anthropic" | "openai" = url.startsWith("/gw/anthropic/") ? "anthropic" : "openai";
  const subpath = url.slice(face === "anthropic" ? "/gw/anthropic".length : "/gw/openai".length);

  let raw: string;
  try {
    raw = await readCappedText(req, GW_BODY_LIMIT);
  } catch (err) {
    if (err instanceof BodyTooLargeError) {
      res.writeHead(413, { "content-type": "application/json", connection: "close" });
      res.end(JSON.stringify({ error: "payload_too_large", limitBytes: err.limitBytes }));
    } else {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "read_failed" }));
    }
    return;
  }
  const requestBytes = Buffer.byteLength(raw, "utf8");
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "bad_json" }));
    return;
  }
  const model = typeof body.model === "string" ? body.model : "";
  if (!model) {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "model_required" }));
    return;
  }

  // Non-quota guards (B7): kill switch, global daily cap, per-uid RPM.
  const limits = preflightLimits(acct.uid);
  if (!limits.ok) {
    res.writeHead(limits.status, { "content-type": "application/json" });
    res.end(JSON.stringify(limits.body));
    return;
  }
  // Quota gate (same engine as /chat): tier decides model access; exhaustion
  // is a structured 402 the local providers surface verbatim.
  const pre = await precheckTurn(acct, model);
  if (!pre.ok) {
    res.writeHead(402, { "content-type": "application/json" });
    res.end(
      JSON.stringify(
        pre.error === "quota_exhausted"
          ? { error: pre.error, resetAt: pre.resetAt, tier: pre.tier }
          : { error: pre.error, tier: pre.tier },
      ),
    );
    return;
  }

  const stream = body.stream === true;
  if (stream && face === "openai") {
    // Ask the upstream to append the usage chunk so the tee-parser can meter.
    body.stream_options = { ...(body.stream_options as object ?? {}), include_usage: true };
  }

  const plan = planUpstream(face, subpath, model, req.headers);
  if (!plan) {
    res.writeHead(503, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "model_not_available" }));
    return;
  }

  let upstream: Response;
  try {
    upstream = await fetch(plan.url, {
      method: "POST",
      headers: plan.headers,
      body: JSON.stringify(body),
    });
  } catch {
    res.writeHead(502, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "upstream_unreachable" }));
    return;
  }

  let usage: ProviderUsage = { ...ZERO };
  let responseBytes = 0;
  const settle = async () => {
    // A 2xx with no usage at all is a billing hole, not a free turn (#264):
    // fall back to a byte estimate. Non-2xx settles at whatever we parsed
    // (normally zero) — the user shouldn't pay for an upstream error.
    const u = upstream.ok && usageIsEmpty(usage) ? estimateUsageFromBytes(requestBytes, responseBytes) : usage;
    const rec = await recordUsage("gw", model, u);
    await debitTurn(acct, model, rec.microUSD);
  };

  const contentType = upstream.headers.get("content-type") ?? "application/json";
  if (!upstream.body || !contentType.includes("text/event-stream")) {
    // Non-streaming (or error) response: buffer, meter, forward as-is.
    const text = await upstream.text();
    responseBytes = Buffer.byteLength(text, "utf8");
    if (upstream.ok) {
      try {
        usage = usageFromJson(face, JSON.parse(text) as Record<string, unknown>);
      } catch {
        /* unmeterable body — forward anyway */
      }
      await settle();
    }
    res.writeHead(upstream.status, { "content-type": contentType });
    res.end(text);
    return;
  }

  // Streaming: byte-for-byte passthrough + tee-parse `data:` lines for usage.
  res.writeHead(upstream.status, {
    "content-type": contentType,
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let carry = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      responseBytes += value.length;
      res.write(Buffer.from(value));
      carry += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = carry.indexOf("\n")) >= 0) {
        const line = carry.slice(0, nl).trim();
        carry = carry.slice(nl + 1);
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        try {
          usage = foldUsage(face, JSON.parse(payload) as Record<string, unknown>, usage);
        } catch {
          /* non-JSON data line */
        }
      }
    }
  } catch {
    // client or upstream dropped — meter what we saw
  } finally {
    await settle();
    res.end();
  }
}

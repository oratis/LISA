/**
 * LISA inference gateway — key-free managed inference for signed-in clients
 * (docs/PLAN_ACCOUNTS_BILLING_v1.0.md §6.6, milestone B6).
 *
 * A signed-in Mac / CLI / app with NO provider key of its own sends its LLM
 * calls here instead of to the provider: the uid-authed key-swap descendant of
 * packaging/gcp-relay. Three upstream protocol faces:
 *
 *   POST /gw/anthropic/v1/messages          → api.anthropic.com (x-api-key swap)
 *   POST /gw/openai/v1/chat/completions     → the model's OpenAI-compatible
 *                                             preset (GLM → open.bigmodel.cn)
 *   POST /gw/gemini/v1beta/models/<model>:generateContent
 *   POST /gw/gemini/v1beta/models/<model>:streamGenerateContent[?alt=sse]
 *                                           → generativelanguage.googleapis.com
 *                                             (x-goog-api-key swap)
 *
 * The Gemini face is narrower than the other two on purpose. Gemini bills
 * several things per request or at non-text rates (search grounding, code
 * execution, audio and image output, audio input), and the price table only
 * has token rates for text. So that face serves only models with an explicit
 * price row, and refuses any request field it cannot price — see
 * `validateGeminiRequest`. Everything it does serve is metered from
 * `usageMetadata` exactly as the Gemini provider meters it (v0.27.1): thinking
 * tokens as output, cached prompt tokens separately from input.
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
import { admitInference, type InferenceAdmission } from "../billing/admission.js";
import { explicitPriceForModel, tokensAffordable } from "../billing/prices.js";
import { readCappedText, BodyTooLargeError } from "./http-body.js";

/**
 * Gateway body cap (#266). Far larger than the control-plane cap: LLM payloads
 * legitimately carry base64 images and long transcripts. Bounded all the same —
 * an unbounded read OOMs the instance before any quota gate runs.
 */
const GW_BODY_LIMIT = Number(process.env.LISA_GW_MAX_BODY_MB || 20) * 1_048_576;

/** Chars-per-token used only for the missing-usage debit floor (#264). */
const BYTES_PER_TOKEN_EST = 4;

export type GatewayFace = "anthropic" | "openai" | "gemini";

export interface UpstreamPlan {
  url: string;
  headers: Record<string, string>;
}

/**
 * Where does this gateway call go, and with which swapped-in credentials?
 * Returns null when the operator has no key for the model's provider.
 */
export function planUpstream(
  face: GatewayFace,
  subpath: string,
  model: string,
  clientHeaders: http.IncomingHttpHeaders,
  env: Record<string, string | undefined> = process.env,
): UpstreamPlan | null {
  if (face === "gemini") {
    // `subpath` is rebuilt from the validated route, never the client's raw
    // path or query — a client `?key=` can not reach the upstream.
    const key = env.GEMINI_API_KEY ?? env.GOOGLE_API_KEY;
    if (!key) return null;
    return {
      url: `https://generativelanguage.googleapis.com${subpath}`,
      headers: {
        "content-type": "application/json",
        "x-goog-api-key": key,
      },
    };
  }
  if (face === "anthropic") {
    const key = env.ANTHROPIC_API_KEY;
    if (!key) return null;
    const version =
      typeof clientHeaders["anthropic-version"] === "string"
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

const ZERO: ProviderUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
};

/**
 * Fold one upstream SSE `data:` JSON object into the running usage.
 * Anthropic: message_start carries input/cache counts, message_delta the
 * output count. OpenAI-compat: the final chunk (stream_options.include_usage)
 * carries {usage:{prompt_tokens, completion_tokens}}.
 */
export function foldUsage(
  face: "anthropic" | "openai",
  obj: Record<string, unknown>,
  acc: ProviderUsage,
): ProviderUsage {
  if (face === "anthropic") {
    if (obj.type === "message_start") {
      const usage = ((obj.message as Record<string, unknown> | undefined)?.usage ?? {}) as Record<
        string,
        unknown
      >;
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
  return (
    u.inputTokens === 0 &&
    u.outputTokens === 0 &&
    u.cacheReadTokens === 0 &&
    u.cacheWriteTokens === 0
  );
}

/** Extract usage from a NON-streaming upstream JSON response body. */
export function usageFromJson(
  face: "anthropic" | "openai",
  body: Record<string, unknown>,
): ProviderUsage {
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

// ── Gemini face ─────────────────────────────────────────────────────────────

export interface GeminiRoute {
  version: "v1beta" | "v1";
  model: string;
  method: "generateContent" | "streamGenerateContent";
  /** True when the client asked for SSE framing (`?alt=sse`). */
  sse: boolean;
  /** The upstream path + query, rebuilt from the validated parts. */
  upstreamPath: string;
}

const GEMINI_PATH =
  /^\/gw\/gemini\/(v1beta|v1)\/models\/([a-z0-9][a-z0-9.-]{0,63}):(generateContent|streamGenerateContent)$/;

/**
 * Parse `/gw/gemini/<version>/models/<model>:<method>[?alt=sse]`. Returns null
 * for anything else: another method (countTokens, embedContent, batch…), a
 * model id outside the plain charset, or any query parameter other than
 * `alt=sse` — in particular `key=`, which is how a Gemini client would
 * otherwise carry a credential.
 */
export function parseGeminiRoute(rawUrl: string): GeminiRoute | null {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl, "http://gateway.invalid");
  } catch {
    return null;
  }
  const match = GEMINI_PATH.exec(parsed.pathname);
  if (!match) return null;
  let sse = false;
  for (const [name, value] of parsed.searchParams) {
    if (name !== "alt" || value !== "sse" || sse) return null;
    sse = true;
  }
  const version = match[1] as GeminiRoute["version"];
  const model = match[2]!;
  const method = match[3] as GeminiRoute["method"];
  return {
    version,
    model,
    method,
    sse,
    upstreamPath: `/${version}/models/${model}:${method}${sse ? "?alt=sse" : ""}`,
  };
}

/**
 * May this model be served through the Gemini face? Only a Gemini model with
 * its own row in the price table: an id priced at the generic fallback could
 * be an image, audio or preview model whose real rate is above it.
 */
export function geminiModelServed(model: string): boolean {
  return model.startsWith("gemini-") && explicitPriceForModel(model) !== null;
}

/** Accept both JSON spellings the Generative Language API takes. */
function field(obj: Record<string, unknown>, camel: string, snake: string): unknown {
  return obj[camel] !== undefined ? obj[camel] : obj[snake];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const GEMINI_TOP_LEVEL = new Set([
  "contents",
  "systemInstruction",
  "system_instruction",
  "generationConfig",
  "generation_config",
  "tools",
  "toolConfig",
  "tool_config",
  "safetySettings",
  "safety_settings",
]);

const GEMINI_PART_KEYS = new Set([
  "text",
  "thought",
  "thoughtSignature",
  "thought_signature",
  "functionCall",
  "function_call",
  "functionResponse",
  "function_response",
  "inlineData",
  "inline_data",
]);

/** Inline media billed at the text/image input rate. Audio and video are not. */
const GEMINI_INLINE_MIME = /^(image\/(png|jpeg|webp|heic|heif)|application\/pdf|text\/plain)$/;

function validateGeminiParts(owner: unknown, where: string): string | null {
  if (owner === undefined) return null;
  if (!isObject(owner)) return `${where} must be an object`;
  const parts = owner.parts;
  if (parts === undefined) return null;
  if (!Array.isArray(parts)) return `${where}.parts must be an array`;
  for (const part of parts) {
    if (!isObject(part)) return `${where}.parts entries must be objects`;
    for (const key of Object.keys(part)) {
      if (!GEMINI_PART_KEYS.has(key)) return `${where}: part field "${key}" is not supported`;
    }
    const inline = field(part, "inlineData", "inline_data");
    if (inline !== undefined) {
      const mime = isObject(inline) ? field(inline, "mimeType", "mime_type") : undefined;
      if (typeof mime !== "string" || !GEMINI_INLINE_MIME.test(mime.trim().toLowerCase())) {
        return `${where}: inline data of type "${String(mime)}" is not supported`;
      }
    }
  }
  return null;
}

/**
 * Refuse any request the gateway cannot price from token counts alone.
 *
 * This is an allow-list. Whatever is not named here — Google Search grounding,
 * code execution, URL context, cached-content references, file URIs, audio or
 * video input, image or audio output, more than one candidate — is rejected
 * with a 400 before admission, so nothing unpriced reaches the upstream on the
 * operator's key. Returns the reason, or null when the request is acceptable.
 */
export function validateGeminiRequest(body: Record<string, unknown>): string | null {
  for (const key of Object.keys(body)) {
    if (!GEMINI_TOP_LEVEL.has(key)) return `field "${key}" is not supported`;
  }
  const contents = body.contents;
  if (!Array.isArray(contents) || contents.length === 0)
    return "contents must be a non-empty array";
  for (const content of contents) {
    const problem = validateGeminiParts(content, "contents");
    if (problem) return problem;
  }
  const system = field(body, "systemInstruction", "system_instruction");
  const systemProblem = validateGeminiParts(system, "systemInstruction");
  if (systemProblem) return systemProblem;

  const tools = body.tools;
  if (tools !== undefined) {
    if (!Array.isArray(tools)) return "tools must be an array";
    for (const tool of tools) {
      if (!isObject(tool)) return "tools entries must be objects";
      for (const key of Object.keys(tool)) {
        if (key !== "functionDeclarations" && key !== "function_declarations") {
          return `tool "${key}" is not supported (function declarations only)`;
        }
      }
    }
  }

  const config = field(body, "generationConfig", "generation_config");
  if (config !== undefined) {
    if (!isObject(config)) return "generationConfig must be an object";
    const modalities = field(config, "responseModalities", "response_modalities");
    if (modalities !== undefined) {
      const textOnly =
        Array.isArray(modalities) &&
        modalities.every((m) => typeof m === "string" && m.toUpperCase() === "TEXT");
      if (!textOnly) return "only TEXT response modality is supported";
    }
    if (field(config, "speechConfig", "speech_config") !== undefined) {
      return "speechConfig is not supported";
    }
    const candidates = field(config, "candidateCount", "candidate_count");
    if (candidates !== undefined && candidates !== 1) return "candidateCount must be 1";
    const maxOut = field(config, "maxOutputTokens", "max_output_tokens");
    if (
      maxOut !== undefined &&
      !(typeof maxOut === "number" && Number.isInteger(maxOut) && maxOut > 0)
    ) {
      return "maxOutputTokens must be a positive integer";
    }
  }
  return null;
}

/** Above this the model's own output limit is the binding one; no need to send a ceiling. */
const GEMINI_MODEL_OUTPUT_LIMIT = 65_536;

/**
 * Cost reservation for one Gemini call: hold the output side to what the
 * admitted budget can pay for. Thinking tokens count against
 * `maxOutputTokens`, so the ceiling covers them too. Mutates `body`.
 */
export function clampGeminiOutput(
  body: Record<string, unknown>,
  model: string,
  budgetMicroUSD: number,
): number | null {
  const affordable = tokensAffordable(model, Number.isFinite(budgetMicroUSD) ? budgetMicroUSD : 0);
  const key = body.generation_config !== undefined ? "generation_config" : "generationConfig";
  const config = isObject(body[key]) ? body[key] : {};
  const snake = config.max_output_tokens !== undefined && config.maxOutputTokens === undefined;
  const requested = snake ? config.max_output_tokens : config.maxOutputTokens;
  const wanted = typeof requested === "number" ? requested : Number.POSITIVE_INFINITY;
  const ceiling = Math.min(wanted, affordable);
  if (ceiling >= GEMINI_MODEL_OUTPUT_LIMIT && requested === undefined) return null;
  if (ceiling === requested) return ceiling;
  body[key] = { ...config, [snake ? "max_output_tokens" : "maxOutputTokens"]: ceiling };
  return ceiling;
}

/** Raw `usageMetadata` counters, kept as reported so derived values are computed once. */
export interface GeminiUsageCounts {
  prompt: number;
  cached: number;
  candidates: number;
  thoughts: number;
  toolUsePrompt: number;
}

export const ZERO_GEMINI_USAGE: GeminiUsageCounts = {
  prompt: 0,
  cached: 0,
  candidates: 0,
  thoughts: 0,
  toolUsePrompt: 0,
};

/**
 * Fold one response object's `usageMetadata` into the running counters.
 *
 * Gemini's counters are CUMULATIVE within a response: every stream chunk
 * restates the totals so far, and the last chunk carries the final ones. They
 * must therefore be merged by maximum, never summed — summing would bill the
 * prompt once per chunk. Taking the maximum per raw counter (rather than
 * "latest chunk wins") also survives a trailing chunk that omits a field.
 */
export function mergeGeminiUsage(
  acc: GeminiUsageCounts,
  obj: Record<string, unknown>,
): GeminiUsageCounts {
  const meta = field(obj, "usageMetadata", "usage_metadata");
  if (!isObject(meta)) return acc;
  const top = (current: number, camel: string, snake: string): number =>
    Math.max(current, num(field(meta, camel, snake)));
  return {
    prompt: top(acc.prompt, "promptTokenCount", "prompt_token_count"),
    cached: top(acc.cached, "cachedContentTokenCount", "cached_content_token_count"),
    candidates: top(acc.candidates, "candidatesTokenCount", "candidates_token_count"),
    thoughts: top(acc.thoughts, "thoughtsTokenCount", "thoughts_token_count"),
    toolUsePrompt: top(acc.toolUsePrompt, "toolUsePromptTokenCount", "tool_use_prompt_token_count"),
  };
}

/**
 * Billable usage from Gemini's counters — the same mapping as
 * src/providers/gemini.ts (v0.27.1): `promptTokenCount` INCLUDES cached
 * tokens, so they are subtracted and billed at the cache-read rate instead of
 * twice; thinking tokens are output.
 */
export function geminiUsageToProvider(counts: GeminiUsageCounts): ProviderUsage {
  const cacheReadTokens = Math.min(counts.cached, counts.prompt);
  return {
    inputTokens: Math.max(0, counts.prompt - cacheReadTokens) + counts.toolUsePrompt,
    outputTokens: counts.candidates + counts.thoughts,
    cacheReadTokens,
    cacheWriteTokens: 0,
  };
}

/** Usage from a buffered Gemini body: one response object, or the array a non-SSE stream returns. */
export function usageFromGeminiJson(body: unknown): ProviderUsage {
  const chunks = Array.isArray(body) ? body : [body];
  let counts = ZERO_GEMINI_USAGE;
  for (const chunk of chunks) {
    if (isObject(chunk)) counts = mergeGeminiUsage(counts, chunk);
  }
  return geminiUsageToProvider(counts);
}

/** Test seams; production uses the real upstream fetch and the real admission boundary. */
export interface GatewayDependencies {
  fetch?: typeof fetch;
  admit?: (acct: AccountRecord, model: string) => Promise<InferenceAdmission>;
  env?: Record<string, string | undefined>;
}

function sendJson(res: http.ServerResponse, status: number, body: Record<string, unknown>): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
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
  deps: GatewayDependencies = {},
): Promise<void> {
  const face: GatewayFace = url.startsWith("/gw/anthropic/")
    ? "anthropic"
    : url.startsWith("/gw/gemini/")
      ? "gemini"
      : "openai";
  // Gemini carries the model and method in the path, so the route is validated
  // before the body is even read.
  const geminiRoute = face === "gemini" ? parseGeminiRoute(url) : null;
  if (face === "gemini" && !geminiRoute) {
    sendJson(res, 404, { error: "unsupported_gemini_route" });
    return;
  }
  const subpath = geminiRoute
    ? geminiRoute.upstreamPath
    : url.slice(face === "anthropic" ? "/gw/anthropic".length : "/gw/openai".length);

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
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    sendJson(res, 400, { error: "bad_json" });
    return;
  }
  const model = geminiRoute ? geminiRoute.model : typeof body.model === "string" ? body.model : "";
  if (!model) {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "model_required" }));
    return;
  }
  if (geminiRoute) {
    // Both checks run BEFORE admission: a request this face cannot price must
    // not take the tenant's turn lease, let alone reach the upstream.
    if (!geminiModelServed(model)) {
      sendJson(res, 400, { error: "model_not_supported", model });
      return;
    }
    const problem = validateGeminiRequest(body);
    if (problem) {
      sendJson(res, 400, { error: "unsupported_request", detail: problem });
      return;
    }
  }
  const plan = planUpstream(face, subpath, model, req.headers, deps.env ?? process.env);
  if (!plan) {
    res.writeHead(503, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "model_not_available" }));
    return;
  }

  const admission = await (deps.admit ?? admitInference)(acct, model);
  if (!admission.ok) {
    res.writeHead(admission.status, { "content-type": "application/json" });
    res.end(JSON.stringify(admission.body));
    return;
  }

  try {
    const stream = body.stream === true;
    if (stream && face === "openai") {
      // Ask the upstream to append the usage chunk so the tee-parser can meter.
      body.stream_options = { ...(body.stream_options ?? {}), include_usage: true };
    }
    if (face === "gemini") {
      clampGeminiOutput(body, model, admission.permit.budgetMicroUSD);
    }

    let upstream: Response;
    try {
      upstream = await (deps.fetch ?? fetch)(plan.url, {
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
    let geminiCounts = ZERO_GEMINI_USAGE;
    let responseBytes = 0;
    const settle = async () => {
      // A 2xx with no usage at all is a billing hole, not a free turn (#264):
      // fall back to a byte estimate. Non-2xx settles at whatever we parsed
      // (normally zero) — the user shouldn't pay for an upstream error.
      const u =
        upstream.ok && usageIsEmpty(usage)
          ? estimateUsageFromBytes(requestBytes, responseBytes)
          : usage;
      await admission.permit.settle("gw", u);
    };

    const contentType = upstream.headers.get("content-type") ?? "application/json";
    if (!upstream.body || !contentType.includes("text/event-stream")) {
      // Non-streaming (or error) response: buffer, meter, forward as-is.
      const text = await upstream.text();
      responseBytes = Buffer.byteLength(text, "utf8");
      if (upstream.ok) {
        try {
          usage =
            face === "gemini"
              ? usageFromGeminiJson(JSON.parse(text) as unknown)
              : usageFromJson(face, JSON.parse(text) as Record<string, unknown>);
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
            const obj = JSON.parse(payload) as Record<string, unknown>;
            if (face === "gemini") {
              geminiCounts = mergeGeminiUsage(geminiCounts, obj);
              usage = geminiUsageToProvider(geminiCounts);
            } else {
              usage = foldUsage(face, obj, usage);
            }
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
  } finally {
    await admission.permit.release();
  }
}

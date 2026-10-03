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
 * price row, and sends upstream only a request it rebuilt from fields it can
 * price — see `canonicalGeminiRequest`. Everything it does serve is metered from
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
import { explicitPriceForModel, normalizeModelId, tokensAffordable } from "../billing/prices.js";
import { readCappedText, BodyTooLargeError } from "./http-body.js";
import { estimateUsageFromBytes } from "../billing/usage-floor.js";

/**
 * Gateway body cap (#266). Far larger than the control-plane cap: LLM payloads
 * legitimately carry base64 images and long transcripts. Bounded all the same —
 * an unbounded read OOMs the instance before any quota gate runs.
 */
const GW_BODY_LIMIT = Number(process.env.LISA_GW_MAX_BODY_MB || 20) * 1_048_576;

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
 * client cut before the usage chunk — bills 0, i.e. free inference. Shared
 * with the per-run USD cap; re-exported here for the gateway's callers.
 */
export { estimateUsageFromBytes };

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
 * be an image, audio or preview model whose real rate is above it. Only the
 * normalised id (`normalizeModelId`) is accepted — the form GeminiProvider
 * sends and the managed-key gate (`managedGeminiServed`) checks.
 */
export function geminiModelServed(model: string): boolean {
  return (
    model === normalizeModelId(model) &&
    model.startsWith("gemini-") &&
    explicitPriceForModel(model) !== null
  );
}

/**
 * Read a field of a Google RESPONSE under either JSON spelling. Requests are
 * never read this way — see `canonicalGeminiRequest`.
 */
function field(obj: Record<string, unknown>, camel: string, snake: string): unknown {
  return obj[camel] !== undefined ? obj[camel] : obj[snake];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ── The Gemini request: validated, then rebuilt ─────────────────────────────
//
// Google's JSON parser accepts every request field under two names: the proto
// field name (`max_output_tokens`) and its lowerCamelCase JSON name
// (`maxOutputTokens`). A validator that reads one spelling while the client's
// object is forwarded as sent can be walked around with the other. So this
// face never forwards the client's object. It reads each supported field under
// either name, validates it, and builds a new camelCase request out of the
// validated values alone. A field sent under both names in one object is
// refused, and so is every field that is not listed below.
//
// Values the API treats as free-form JSON — `functionCall.args`,
// `functionResponse.response`, `parametersJsonSchema`, `responseJsonSchema` —
// are forwarded as sent: their keys are the caller's data, not API fields, and
// nothing in them is billed. `Schema` messages (`parameters`, `response`,
// `responseSchema`) are forwarded as sent too, after the two-spellings check.

class GeminiRefusal extends Error {}

function refuse(reason: string): never {
  throw new GeminiRefusal(reason);
}

/** The lowerCamelCase JSON name proto3 derives from a field name: `max_output_tokens` → `maxOutputTokens`. */
function jsonName(key: string): string {
  return key.replace(/_([a-z0-9])/g, (_match, ch: string) => ch.toUpperCase());
}

/** Refuses an object that carries one field under two spellings. */
function refuseTwoSpellings(value: Record<string, unknown>, where: string): void {
  const spelledAs = new Map<string, string>();
  for (const key of Object.keys(value)) {
    const name = jsonName(key);
    const other = spelledAs.get(name);
    if (other !== undefined) {
      refuse(`${where}: "${other}" and "${key}" are the same field; send it once`);
    }
    spelledAs.set(name, key);
  }
}

/**
 * The fields of one request message, keyed by their camelCase name. Refuses a
 * value that is not an object, a field sent under two spellings, and any field
 * not in `allowed`.
 */
function messageFields(
  value: unknown,
  where: string,
  allowed: ReadonlySet<string>,
): Map<string, unknown> {
  if (!isObject(value)) refuse(`${where} must be an object`);
  refuseTwoSpellings(value, where);
  const fields = new Map<string, unknown>();
  for (const key of Object.keys(value)) {
    const name = jsonName(key);
    if (!allowed.has(name)) refuse(`${where}: field "${key}" is not supported`);
    fields.set(name, value[key]);
  }
  return fields;
}

function str(value: unknown, where: string): string {
  if (typeof value !== "string") refuse(`${where} must be a string`);
  return value;
}

function bool(value: unknown, where: string): boolean {
  if (typeof value !== "boolean") refuse(`${where} must be true or false`);
  return value;
}

function finite(value: unknown, where: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) refuse(`${where} must be a number`);
  return value;
}

function integer(value: unknown, where: string, min = Number.MIN_SAFE_INTEGER): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min) {
    refuse(`${where} must be an integer of at least ${min}`);
  }
  return value;
}

function stringList(value: unknown, where: string): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    refuse(`${where} must be a list of strings`);
  }
  return value;
}

/** Free-form JSON object (function arguments, function results): forwarded as sent. */
function jsonObject(value: unknown, where: string): Record<string, unknown> {
  if (!isObject(value)) refuse(`${where} must be an object`);
  return value;
}

const SCHEMA_MAX_DEPTH = 64;

/**
 * A `Schema` message describes JSON and is forwarded as sent; it is still
 * checked, at every level, for a field sent under both names. The keys of
 * `properties` are the caller's property names, so they are not checked
 * against each other.
 */
function checkSchema(value: unknown, where: string, depth = 0): void {
  if (depth > SCHEMA_MAX_DEPTH) refuse(`${where}: schema nested too deeply`);
  if (Array.isArray(value)) {
    value.forEach((item, i) => checkSchema(item, `${where}[${i}]`, depth + 1));
    return;
  }
  if (!isObject(value)) return;
  refuseTwoSpellings(value, where);
  for (const [key, sub] of Object.entries(value)) {
    const name = jsonName(key);
    if (name === "properties" && isObject(sub)) {
      for (const [prop, schema] of Object.entries(sub)) {
        checkSchema(schema, `${where}.${key}.${prop}`, depth + 1);
      }
    } else if (name === "items" || name === "anyOf") {
      checkSchema(sub, `${where}.${key}`, depth + 1);
    }
  }
}

function schema(value: unknown, where: string): Record<string, unknown> {
  if (!isObject(value)) refuse(`${where} must be an object`);
  checkSchema(value, where);
  return value;
}

/** Inline media billed at the text/image input rate. Audio and video are not. */
const GEMINI_INLINE_MIME = /^(image\/(png|jpeg|webp|heic|heif)|application\/pdf|text\/plain)$/;

const REQUEST_FIELDS = new Set([
  "contents",
  "systemInstruction",
  "tools",
  "toolConfig",
  "generationConfig",
  "safetySettings",
]);
const CONTENT_FIELDS = new Set(["role", "parts"]);
const PART_FIELDS = new Set([
  "text",
  "thought",
  "thoughtSignature",
  "functionCall",
  "functionResponse",
  "inlineData",
]);
const FUNCTION_CALL_FIELDS = new Set(["id", "name", "args"]);
const FUNCTION_RESPONSE_FIELDS = new Set(["id", "name", "response"]);
const BLOB_FIELDS = new Set(["mimeType", "data"]);
const TOOL_FIELDS = new Set(["functionDeclarations"]);
const FUNCTION_DECLARATION_FIELDS = new Set([
  "name",
  "description",
  "parameters",
  "parametersJsonSchema",
  "response",
  "responseJsonSchema",
]);
const TOOL_CONFIG_FIELDS = new Set(["functionCallingConfig"]);
const FUNCTION_CALLING_CONFIG_FIELDS = new Set(["mode", "allowedFunctionNames"]);
const FUNCTION_CALLING_MODES = new Set(["MODE_UNSPECIFIED", "AUTO", "ANY", "NONE", "VALIDATED"]);
const SAFETY_SETTING_FIELDS = new Set(["category", "threshold"]);
const GENERATION_CONFIG_FIELDS = new Set([
  "temperature",
  "topP",
  "topK",
  "candidateCount",
  "maxOutputTokens",
  "stopSequences",
  "seed",
  "presencePenalty",
  "frequencyPenalty",
  "responseMimeType",
  "responseSchema",
  "responseJsonSchema",
  "responseModalities",
  "thinkingConfig",
]);
const THINKING_CONFIG_FIELDS = new Set(["thinkingBudget", "includeThoughts"]);
/** Structured output is still text, billed at the text output rate. */
const TEXT_RESPONSE_MIME = new Set(["text/plain", "application/json", "text/x.enum"]);

function buildPart(value: unknown, where: string): Record<string, unknown> {
  const fields = messageFields(value, where, PART_FIELDS);
  const part: Record<string, unknown> = {};
  if (fields.has("text")) part.text = str(fields.get("text"), `${where}.text`);
  if (fields.has("thought")) part.thought = bool(fields.get("thought"), `${where}.thought`);
  if (fields.has("thoughtSignature")) {
    part.thoughtSignature = str(fields.get("thoughtSignature"), `${where}.thoughtSignature`);
  }
  if (fields.has("functionCall")) {
    const at = `${where}.functionCall`;
    const call = messageFields(fields.get("functionCall"), at, FUNCTION_CALL_FIELDS);
    part.functionCall = {
      ...(call.has("id") ? { id: str(call.get("id"), `${at}.id`) } : {}),
      name: str(call.get("name"), `${at}.name`),
      ...(call.has("args") ? { args: jsonObject(call.get("args"), `${at}.args`) } : {}),
    };
  }
  if (fields.has("functionResponse")) {
    const at = `${where}.functionResponse`;
    const response = messageFields(fields.get("functionResponse"), at, FUNCTION_RESPONSE_FIELDS);
    part.functionResponse = {
      ...(response.has("id") ? { id: str(response.get("id"), `${at}.id`) } : {}),
      name: str(response.get("name"), `${at}.name`),
      response: jsonObject(response.get("response"), `${at}.response`),
    };
  }
  if (fields.has("inlineData")) {
    const at = `${where}.inlineData`;
    const blob = messageFields(fields.get("inlineData"), at, BLOB_FIELDS);
    const mime = blob.get("mimeType");
    const mimeType = typeof mime === "string" ? mime.trim().toLowerCase() : "";
    if (!GEMINI_INLINE_MIME.test(mimeType)) {
      refuse(`${where}: inline data of type "${String(mime)}" is not supported`);
    }
    part.inlineData = { mimeType, data: str(blob.get("data"), `${at}.data`) };
  }
  return part;
}

function buildContent(value: unknown, where: string): Record<string, unknown> {
  const fields = messageFields(value, where, CONTENT_FIELDS);
  const content: Record<string, unknown> = {};
  if (fields.has("role")) content.role = str(fields.get("role"), `${where}.role`);
  if (fields.has("parts")) {
    const parts = fields.get("parts");
    if (!Array.isArray(parts)) refuse(`${where}.parts must be an array`);
    content.parts = parts.map((part, i) => {
      if (!isObject(part)) refuse(`${where}.parts entries must be objects`);
      return buildPart(part, `${where}.parts[${i}]`);
    });
  }
  return content;
}

function buildTool(value: unknown, where: string): Record<string, unknown> {
  // Built-in tools (Search grounding, code execution, URL context, …) are
  // billed per request or per query; only function declarations are served.
  const fields = messageFields(value, where, TOOL_FIELDS);
  const tool: Record<string, unknown> = {};
  if (fields.has("functionDeclarations")) {
    const declarations = fields.get("functionDeclarations");
    if (!Array.isArray(declarations)) refuse(`${where}.functionDeclarations must be an array`);
    tool.functionDeclarations = declarations.map((declaration, i) => {
      const at = `${where}.functionDeclarations[${i}]`;
      const decl = messageFields(declaration, at, FUNCTION_DECLARATION_FIELDS);
      const out: Record<string, unknown> = { name: str(decl.get("name"), `${at}.name`) };
      if (decl.has("description"))
        out.description = str(decl.get("description"), `${at}.description`);
      for (const key of ["parameters", "response"]) {
        if (decl.has(key)) out[key] = schema(decl.get(key), `${at}.${key}`);
      }
      for (const key of ["parametersJsonSchema", "responseJsonSchema"]) {
        if (decl.has(key)) out[key] = decl.get(key);
      }
      return out;
    });
  }
  return tool;
}

function buildToolConfig(value: unknown): Record<string, unknown> {
  const fields = messageFields(value, "toolConfig", TOOL_CONFIG_FIELDS);
  const config: Record<string, unknown> = {};
  if (fields.has("functionCallingConfig")) {
    const at = "toolConfig.functionCallingConfig";
    const calling = messageFields(
      fields.get("functionCallingConfig"),
      at,
      FUNCTION_CALLING_CONFIG_FIELDS,
    );
    const out: Record<string, unknown> = {};
    if (calling.has("mode")) {
      const mode = str(calling.get("mode"), `${at}.mode`);
      if (!FUNCTION_CALLING_MODES.has(mode)) refuse(`${at}.mode "${mode}" is not supported`);
      out.mode = mode;
    }
    if (calling.has("allowedFunctionNames")) {
      out.allowedFunctionNames = stringList(
        calling.get("allowedFunctionNames"),
        `${at}.allowedFunctionNames`,
      );
    }
    config.functionCallingConfig = out;
  }
  return config;
}

function buildGenerationConfig(value: unknown): Record<string, unknown> {
  const where = "generationConfig";
  const fields = messageFields(value, where, GENERATION_CONFIG_FIELDS);
  const config: Record<string, unknown> = {};
  for (const key of ["temperature", "topP", "presencePenalty", "frequencyPenalty"]) {
    if (fields.has(key)) config[key] = finite(fields.get(key), `${where}.${key}`);
  }
  for (const key of ["topK", "seed"]) {
    if (fields.has(key)) config[key] = integer(fields.get(key), `${where}.${key}`);
  }
  if (fields.has("candidateCount")) {
    if (fields.get("candidateCount") !== 1) refuse("candidateCount must be 1");
    config.candidateCount = 1;
  }
  if (fields.has("maxOutputTokens")) {
    const maxOut = fields.get("maxOutputTokens");
    if (!(typeof maxOut === "number" && Number.isSafeInteger(maxOut) && maxOut > 0)) {
      refuse("maxOutputTokens must be a positive integer");
    }
    config.maxOutputTokens = maxOut;
  }
  if (fields.has("stopSequences")) {
    config.stopSequences = stringList(fields.get("stopSequences"), `${where}.stopSequences`);
  }
  if (fields.has("responseMimeType")) {
    const mime = str(fields.get("responseMimeType"), `${where}.responseMimeType`);
    if (!TEXT_RESPONSE_MIME.has(mime)) refuse(`response type "${mime}" is not supported`);
    config.responseMimeType = mime;
  }
  if (fields.has("responseSchema")) {
    config.responseSchema = schema(fields.get("responseSchema"), `${where}.responseSchema`);
  }
  if (fields.has("responseJsonSchema"))
    config.responseJsonSchema = fields.get("responseJsonSchema");
  if (fields.has("responseModalities")) {
    const modalities = fields.get("responseModalities");
    const textOnly =
      Array.isArray(modalities) &&
      modalities.every((m) => typeof m === "string" && m.toUpperCase() === "TEXT");
    if (!textOnly) refuse("only TEXT response modality is supported");
    config.responseModalities = modalities.map(() => "TEXT");
  }
  if (fields.has("thinkingConfig")) {
    const at = `${where}.thinkingConfig`;
    const thinking = messageFields(fields.get("thinkingConfig"), at, THINKING_CONFIG_FIELDS);
    const out: Record<string, unknown> = {};
    // -1 asks for dynamic thinking; the output ceiling still bounds it.
    if (thinking.has("thinkingBudget")) {
      out.thinkingBudget = integer(thinking.get("thinkingBudget"), `${at}.thinkingBudget`, -1);
    }
    if (thinking.has("includeThoughts")) {
      out.includeThoughts = bool(thinking.get("includeThoughts"), `${at}.includeThoughts`);
    }
    config.thinkingConfig = out;
  }
  return config;
}

function buildGeminiRequest(body: Record<string, unknown>): Record<string, unknown> {
  const fields = messageFields(body, "request", REQUEST_FIELDS);
  const contents = fields.get("contents");
  if (!Array.isArray(contents) || contents.length === 0) {
    refuse("contents must be a non-empty array");
  }
  const request: Record<string, unknown> = {
    contents: contents.map((content, i) => buildContent(content, `contents[${i}]`)),
  };
  if (fields.has("systemInstruction")) {
    request.systemInstruction = buildContent(fields.get("systemInstruction"), "systemInstruction");
  }
  if (fields.has("tools")) {
    const tools = fields.get("tools");
    if (!Array.isArray(tools)) refuse("tools must be an array");
    request.tools = tools.map((tool, i) => buildTool(tool, `tools[${i}]`));
  }
  if (fields.has("toolConfig")) request.toolConfig = buildToolConfig(fields.get("toolConfig"));
  if (fields.has("generationConfig")) {
    request.generationConfig = buildGenerationConfig(fields.get("generationConfig"));
  }
  if (fields.has("safetySettings")) {
    const settings = fields.get("safetySettings");
    if (!Array.isArray(settings)) refuse("safetySettings must be an array");
    request.safetySettings = settings.map((setting, i) => {
      const at = `safetySettings[${i}]`;
      const s = messageFields(setting, at, SAFETY_SETTING_FIELDS);
      return {
        ...(s.has("category") ? { category: str(s.get("category"), `${at}.category`) } : {}),
        ...(s.has("threshold") ? { threshold: str(s.get("threshold"), `${at}.threshold`) } : {}),
      };
    });
  }
  return request;
}

export type GeminiRequestCheck =
  { ok: true; request: Record<string, unknown> } | { ok: false; reason: string };

/**
 * Validate a client's Gemini request and rebuild it from the validated fields.
 *
 * The rebuilt request — camelCase, nothing but the fields listed above — is
 * the only thing sent upstream. Whatever is not listed (Google Search
 * grounding, code execution, URL context, cached-content references, file
 * URIs, audio or video input, image or audio output, more than one candidate,
 * any field this face does not know) is refused, and so is a field sent under
 * both of its JSON names. handleGateway runs this before admission, so a
 * refused request takes no turn lease and reaches no upstream.
 */
export function canonicalGeminiRequest(body: Record<string, unknown>): GeminiRequestCheck {
  try {
    return { ok: true, request: buildGeminiRequest(body) };
  } catch (err) {
    if (err instanceof GeminiRefusal) return { ok: false, reason: err.message };
    throw err;
  }
}

/** The refusal reason for a request, or null when it can be served. */
export function validateGeminiRequest(body: Record<string, unknown>): string | null {
  const check = canonicalGeminiRequest(body);
  return check.ok ? null : check.reason;
}

/** Above this the model's own output limit is the binding one; no need to send a ceiling. */
const GEMINI_MODEL_OUTPUT_LIMIT = 65_536;

/**
 * The largest thinking budget Gemini 2.5 Flash (the one model this face
 * serves) accepts; dynamic thinking (`thinkingBudget: -1`) stays within it.
 */
const GEMINI_THINKING_BUDGET_LIMIT = 24_576;

/**
 * Cost reservation for one Gemini call: hold the output side to what the
 * admitted budget can pay for.
 *
 * Thinking is counted against the same ceiling. Gemini 2.5 counts thinking
 * tokens against `maxOutputTokens`, and the meter bills them as output, so
 * the ceiling is what the call's whole output — thoughts plus answer — may
 * cost. A thinking budget above the ceiling (or dynamic thinking, whose limit
 * is above it) is lowered to the ceiling, so the request never asks for more
 * thinking than the reservation pays for.
 *
 * Takes the request `canonicalGeminiRequest` rebuilt — the only output limit
 * it can carry is `generationConfig.maxOutputTokens` — and mutates it.
 */
export function clampGeminiOutput(
  request: Record<string, unknown>,
  model: string,
  budgetMicroUSD: number,
): number | null {
  const affordable = tokensAffordable(model, Number.isFinite(budgetMicroUSD) ? budgetMicroUSD : 0);
  const config = isObject(request.generationConfig) ? request.generationConfig : {};
  const requested = typeof config.maxOutputTokens === "number" ? config.maxOutputTokens : undefined;
  const ceiling = Math.min(requested ?? Number.POSITIVE_INFINITY, affordable);
  if (ceiling >= GEMINI_MODEL_OUTPUT_LIMIT && requested === undefined) return null;
  const clamped: Record<string, unknown> = { ...config, maxOutputTokens: ceiling };
  const thinking = isObject(config.thinkingConfig) ? config.thinkingConfig : null;
  if (thinking && typeof thinking.thinkingBudget === "number") {
    const asked =
      thinking.thinkingBudget < 0 ? GEMINI_THINKING_BUDGET_LIMIT : thinking.thinkingBudget;
    if (asked > ceiling) clamped.thinkingConfig = { ...thinking, thinkingBudget: ceiling };
  }
  request.generationConfig = clamped;
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

/**
 * Does this streamed event carry the response's FINAL usage? Until one has
 * been seen, the counters read so far can lag behind the text already
 * forwarded — an upstream that cuts the stream after a prompt-only chunk
 * would otherwise leave that output unbilled.
 *
 *  - anthropic: `message_delta` carries the final output count.
 *  - openai-compatible: the usage chunk (`include_usage`) carries
 *    `completion_tokens`.
 *  - gemini: the last chunk names a `finishReason`, next to the final
 *    `usageMetadata`.
 */
export function isFinalUsageEvent(face: GatewayFace, obj: Record<string, unknown>): boolean {
  if (face === "anthropic") return obj.type === "message_delta" && isObject(obj.usage);
  if (face === "openai") {
    return isObject(obj.usage) && typeof obj.usage.completion_tokens === "number";
  }
  const candidates = obj.candidates;
  return (
    Array.isArray(candidates) &&
    candidates.some(
      (c) => isObject(c) && typeof field(c, "finishReason", "finish_reason") === "string",
    )
  );
}

/** Read a whole response body, reporting each chunk's size as it arrives. */
async function readBody(response: Response, onBytes: (bytes: number) => void): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return text + decoder.decode();
    onBytes(value.length);
    text += decoder.decode(value, { stream: true });
  }
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
  // What is sent upstream. The Gemini face replaces the client's object with
  // one rebuilt from validated fields; the other faces forward the body.
  let outbound = body;
  if (geminiRoute) {
    // Both checks run BEFORE admission: a request this face cannot price must
    // not take the tenant's turn lease, let alone reach the upstream.
    if (!geminiModelServed(model)) {
      sendJson(res, 400, { error: "model_not_supported", model });
      return;
    }
    const check = canonicalGeminiRequest(body);
    if (!check.ok) {
      sendJson(res, 400, { error: "unsupported_request", detail: check.reason });
      return;
    }
    outbound = check.request;
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
      outbound.stream_options = { ...(body.stream_options ?? {}), include_usage: true };
    }
    if (face === "gemini") {
      clampGeminiOutput(outbound, model, admission.permit.budgetMicroUSD);
    }

    let upstream: Response;
    try {
      upstream = await (deps.fetch ?? fetch)(plan.url, {
        method: "POST",
        headers: plan.headers,
        body: JSON.stringify(outbound),
      });
    } catch {
      res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "upstream_unreachable" }));
      return;
    }

    let usage: ProviderUsage = { ...ZERO };
    let geminiCounts = ZERO_GEMINI_USAGE;
    let responseBytes = 0;
    // False while a stream has not yet delivered its final usage event.
    let usageFinal = true;
    const settle = async () => {
      // A 2xx with no usage at all is a billing hole, not a free turn (#264):
      // fall back to a byte estimate. A stream that ended before its final
      // usage event has its output billed at no less than the byte floor of
      // what was forwarded. Non-2xx settles at whatever we parsed (normally
      // zero) — the user shouldn't pay for an upstream error.
      let u = usage;
      if (upstream.ok) {
        const floor = estimateUsageFromBytes(requestBytes, responseBytes);
        if (usageIsEmpty(usage)) u = floor;
        else if (!usageFinal) {
          u = { ...usage, outputTokens: Math.max(usage.outputTokens, floor.outputTokens) };
        }
      }
      await admission.permit.settle("gw", u);
    };

    const contentType = upstream.headers.get("content-type") ?? "application/json";
    if (!upstream.body || !contentType.includes("text/event-stream")) {
      // Non-streaming (or error) response: buffer, meter, forward as-is.
      let text: string;
      try {
        text = await readBody(upstream, (bytes) => (responseBytes += bytes));
      } catch {
        // The upstream answered, then its body failed mid-read. It has billed
        // the operator for what it generated, so a 2xx is settled at the byte
        // floor of what arrived (non-2xx stays unbilled); the client gets a
        // 502, since a partial body is not an answer.
        if (upstream.ok) {
          usageFinal = false;
          await settle();
        }
        sendJson(res, 502, { error: "upstream_read_failed" });
        return;
      }
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
    usageFinal = false;
    const meterLine = (rawLine: string): void => {
      const line = rawLine.trim();
      if (!line.startsWith("data:")) return;
      const payload = line.slice(5).trim();
      if (!payload || payload === "[DONE]") return;
      try {
        const obj = JSON.parse(payload) as Record<string, unknown>;
        if (isObject(obj) && isFinalUsageEvent(face, obj)) usageFinal = true;
        if (face === "gemini") {
          geminiCounts = mergeGeminiUsage(geminiCounts, obj);
          usage = geminiUsageToProvider(geminiCounts);
        } else {
          usage = foldUsage(face, obj, usage);
        }
      } catch {
        /* non-JSON data line */
      }
    };
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          // The final event may arrive without a trailing newline; it is
          // usually the one that carries the usage totals.
          meterLine(carry + decoder.decode());
          break;
        }
        responseBytes += value.length;
        res.write(Buffer.from(value));
        carry += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = carry.indexOf("\n")) >= 0) {
          meterLine(carry.slice(0, nl));
          carry = carry.slice(nl + 1);
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

/**
 * One error shape for every client (#485, #487).
 *
 * Every non-2xx response on the versioned surfaces (/api/*, /chat, /events)
 * leaves as JSON `{"error": "<snake_case code>", "message": "<sentence>"}`,
 * with any route-specific fields (reason, retryAfterSec, resetAt, ok:false…)
 * kept beside them. Codes and default messages come from
 * contracts/lisa-error-codes.json, so Lisa Pocket switches on the same table
 * the server writes from.
 *
 * Routes keep writing their responses as they always did; enforceErrorShape()
 * finishes the body on its way out. That is deliberate: there are well over a
 * hundred error sites across the server and its route modules, and a guard
 * at the response is the only place that cannot be forgotten by the next one.
 */
import type http from "node:http";
import {
  LISA_ERROR_FALLBACK_BY_STATUS,
  LISA_ERROR_HTTP_STATUS,
  LISA_ERROR_MESSAGES,
} from "./error-codes.generated.js";

export { LISA_ERROR_MESSAGES, LISA_ERROR_HTTP_STATUS, LISA_ERROR_FALLBACK_BY_STATUS };

const CODE_RE = /^[a-z][a-z0-9_]*$/;
/** A legacy plain-text or free-text error becomes the message; keep it short. */
const MAX_LEGACY_MESSAGE = 300;

/** The generic code for a status whose route gave no specific one. */
export function fallbackErrorCode(status: number): string {
  return LISA_ERROR_FALLBACK_BY_STATUS[String(status)] ?? LISA_ERROR_FALLBACK_BY_STATUS.default!;
}

/** The default message for `code`, else the generic one for `status`. */
export function errorMessage(code: string, status?: number): string {
  return (
    LISA_ERROR_MESSAGES[code] ??
    (status !== undefined ? LISA_ERROR_MESSAGES[fallbackErrorCode(status)] : undefined) ??
    LISA_ERROR_MESSAGES[LISA_ERROR_FALLBACK_BY_STATUS.default!]!
  );
}

/** A complete error body: `{error, message, ...extra}`. */
export function errorBody(
  code: string,
  extra: Record<string, unknown> = {},
  message?: string,
): Record<string, unknown> {
  return { ...extra, error: code, message: message ?? errorMessage(code) };
}

function legacyMessage(text: string): string | undefined {
  const trimmed = text.trim().replace(/\s+/g, " ");
  if (!trimmed) return undefined;
  return trimmed.length > MAX_LEGACY_MESSAGE
    ? trimmed.slice(0, MAX_LEGACY_MESSAGE - 1) + "…"
    : trimmed;
}

/**
 * The contract-shaped body for an error response, or null when `body` already
 * has the shape (or is HTML for a browser, which is left alone). Pure.
 */
export function normalizeErrorPayload(
  status: number,
  contentType: string,
  body: string,
): string | null {
  const type = contentType.toLowerCase();
  if (type.includes("text/html") || type.includes("text/event-stream")) return null;
  if (type.includes("json")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      parsed = undefined;
    }
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const obj = parsed as Record<string, unknown>;
      const raw = obj.error;
      let code: string;
      let detail: string | undefined;
      if (typeof raw === "string" && CODE_RE.test(raw)) code = raw;
      else {
        code = fallbackErrorCode(status);
        // A few legacy routes put a sentence in `error`; it becomes the message.
        if (typeof raw === "string") detail = legacyMessage(raw);
      }
      const hasMessage = typeof obj.message === "string" && obj.message.trim() !== "";
      if (code === raw && hasMessage) return null;
      // The route's own sentence beats the status's generic one.
      const message = hasMessage
        ? (obj.message as string)
        : code === raw
          ? errorMessage(code, status)
          : (detail ?? errorMessage(code, status));
      const next: Record<string, unknown> = { ...obj, error: code, message };
      if (raw !== undefined && typeof raw !== "string") next.detail = raw;
      return JSON.stringify(next);
    }
    if (parsed !== undefined) return null; // a JSON array/scalar error body: not ours to reshape
  }
  // Plain text (or no body). A body that is itself a bare code is that code;
  // any other text is the message under the status's generic code.
  const text = body.trim();
  if (
    CODE_RE.test(text) &&
    text.length <= 64 &&
    (text.includes("_") || LISA_ERROR_MESSAGES[text] !== undefined)
  ) {
    return JSON.stringify({ error: text, message: errorMessage(text, status) });
  }
  const code = fallbackErrorCode(status);
  return JSON.stringify({ error: code, message: legacyMessage(text) ?? errorMessage(code) });
}

type Chunk = string | Buffer | Uint8Array | null | undefined;
type AnyFn = (...args: unknown[]) => unknown;

function chunkText(chunk: Chunk, encoding: unknown): string | null {
  if (chunk === null || chunk === undefined) return "";
  if (typeof chunk === "string") return chunk;
  if (Buffer.isBuffer(chunk)) {
    return chunk.toString(typeof encoding === "string" ? (encoding as BufferEncoding) : "utf8");
  }
  if (chunk instanceof Uint8Array) return Buffer.from(chunk).toString("utf8");
  return null;
}

/**
 * Make every error response on this request leave in the contract shape.
 * Call once, before any route writes. A 4xx/5xx head is held back until the
 * body is known (so a text/plain body can become JSON); anything streamed with
 * write() goes out untouched.
 */
export function enforceErrorShape(req: http.IncomingMessage, res: http.ServerResponse): void {
  if (req.method === "HEAD") return;
  const writeHead = res.writeHead.bind(res) as unknown as AnyFn;
  const write = res.write.bind(res) as unknown as AnyFn;
  const end = res.end.bind(res) as unknown as AnyFn;
  let held: { status: number; reason?: string } | null = null;
  // Once the body starts streaming, or the response is ending, Node's own
  // implicit writeHead calls must reach the real one.
  let passthrough = false;

  const flush = () => {
    if (!held) return;
    const { status, reason } = held;
    held = null;
    if (reason !== undefined) writeHead(status, reason);
    else writeHead(status);
  };

  res.writeHead = ((statusCode: number, ...rest: unknown[]) => {
    const reason = typeof rest[0] === "string" ? rest[0] : undefined;
    const headers = typeof rest[0] === "string" ? rest[1] : rest[0];
    if (passthrough || statusCode < 400 || res.headersSent || Array.isArray(headers)) {
      return writeHead(statusCode, ...rest);
    }
    // Merge the headers the way Node does once setHeader has been used.
    if (headers && typeof headers === "object") {
      for (const [name, value] of Object.entries(headers as Record<string, unknown>)) {
        if (value !== undefined) res.setHeader(name, value as string | number | string[]);
      }
    }
    res.statusCode = statusCode;
    held = { status: statusCode, reason };
    return res;
  }) as typeof res.writeHead;

  res.write = ((...args: unknown[]) => {
    passthrough = true;
    flush();
    return write(...args);
  }) as typeof res.write;

  res.end = ((...args: unknown[]) => {
    let [chunk, encoding, cb] = args;
    if (typeof chunk === "function") {
      cb = chunk;
      chunk = undefined;
      encoding = undefined;
    } else if (typeof encoding === "function") {
      cb = encoding;
      encoding = undefined;
    }
    const status = held?.status ?? res.statusCode;
    if (!passthrough && status >= 400 && !res.headersSent) {
      const text = chunkText(chunk as Chunk, encoding);
      const next =
        text === null
          ? null
          : normalizeErrorPayload(status, String(res.getHeader("content-type") ?? ""), text);
      if (next !== null) {
        res.setHeader("content-type", "application/json");
        res.removeHeader("content-length");
        chunk = next;
        encoding = "utf8";
      }
    }
    passthrough = true;
    flush();
    return end(chunk, encoding, cb);
  }) as typeof res.end;
}

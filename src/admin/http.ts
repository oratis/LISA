import { normalizeModelId } from "../billing/prices.js";
import type http from "node:http";
import fs from "node:fs/promises";
import crypto from "node:crypto";
import { logError } from "../log.js";
import {
  getAccount,
  ensureOtpAccount,
  verifyEmailLogin,
  revokeAccountSessions,
  validEmail,
  type AccountRecord,
} from "../web/accounts.js";
import { verifySession, mintSession } from "../web/sessions-auth.js";
import { requestEmailOtp, verifyEmailOtp, OTP_TTL_MS } from "../web/otp.js";
import { sendSignInCodeEmail } from "../web/mailer.js";
import { readCappedText, BodyTooLargeError } from "../web/http-body.js";
import { ipRateOk } from "../billing/limits.js";
import { creditExternalTransaction, IapError } from "../billing/iap.js";
import { consoleSnapshot } from "./data.js";
import {
  consoleEnabled,
  owners,
  roleFor,
  readAdminState,
  mutateAdminState,
  appendAudit,
  ConsoleError,
  requireReason,
  FEATURES,
  type AdminState,
  type Role,
} from "./store.js";

// Credit-grant limits in micro-USD ($1 = 1,000,000). The owner changes them here.
// Daily totals are per granting operator over a rolling 24 hours, counted from
// the grant records themselves (pending and completed alike).
export const OPERATOR_GRANT_MAX_MICRO_USD = 50_000_000; // $50 per grant
export const OPERATOR_GRANT_DAILY_MAX_MICRO_USD = 200_000_000; // $200 per 24 h
export const ADMIN_GRANT_MAX_MICRO_USD = 1_000_000_000; // $1,000 per grant
export const ADMIN_GRANT_DAILY_MAX_MICRO_USD = 5_000_000_000; // $5,000 per 24 h
const GRANT_WINDOW_MS = 24 * 60 * 60 * 1000;

const COOKIE = "lisa_console";
const TTL = 8 * 60 * 60 * 1000;
export const consoleSecret = (secret: string) =>
  crypto.createHmac("sha256", secret).update("lisa-console-v1").digest("hex");
export function consoleCookie(token: string): string {
  return `${COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/console; Max-Age=${token ? TTL / 1000 : 0}${process.env.LISA_EDITION === "cloud" ? "; Secure" : ""}`;
}
function cookie(req: http.IncomingMessage): string {
  try {
    return decodeURIComponent(
      (req.headers.cookie ?? "")
        .split(";")
        .map((s) => s.trim())
        .find((s) => s.startsWith(`${COOKIE}=`))
        ?.slice(COOKIE.length + 1) ?? "",
    );
  } catch {
    return "";
  }
}
function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}
function canWrite(role: Role): boolean {
  return role === "admin" || role === "operator";
}
async function body(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const origin = process.env.LISA_CONSOLE_ORIGIN ?? "https://meetlisa.ai";
  if (
    req.headers["x-lisa-console"] !== "1" ||
    (req.headers.origin && req.headers.origin !== origin) ||
    req.headers["sec-fetch-site"] === "cross-site"
  )
    throw new ConsoleError("invalid_origin", 403);
  if (!(req.headers["content-type"] ?? "").startsWith("application/json"))
    throw new ConsoleError("json_required", 415);
  req.setTimeout(10000);
  const raw = await readCappedText(req, 16384);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ConsoleError("invalid_json");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new ConsoleError("invalid_json");
  return parsed as Record<string, unknown>;
}
function text(v: unknown, max = 1000): string {
  if (typeof v !== "string" || v.length > max) throw new ConsoleError("invalid_field");
  return v.trim();
}
function revision(state: AdminState, value: unknown): void {
  if (value !== state.revision) throw new ConsoleError("version_conflict", 409);
}
function actor(acct: AccountRecord): string {
  return acct.email ?? acct.uid;
}
/** Micro-USD that `by` has granted since `since`, from the grant records. */
export function grantedSince(s: AdminState, by: string, since: number): number {
  // Records written before grants carried `at`/`actor` still have their
  // credit_requested audit entry.
  const requested = new Map<string, { actor: string; at: number }>();
  for (const a of s.audit)
    if (a.action === "credit_requested" && typeof a.detail?.id === "string")
      requested.set(a.detail.id, a);
  let total = 0;
  for (const [id, op] of Object.entries(s.operations)) {
    const meta =
      op.at !== undefined && op.actor !== undefined
        ? { actor: op.actor, at: op.at }
        : requested.get(id);
    if (meta && meta.actor === by && meta.at > since) total += op.microUSD;
  }
  return total;
}
export function csvValue(v: unknown): string {
  let s = v === null || v === undefined ? "" : String(v);
  if (/^[\s]*[=+@-]/.test(s) || /^[\t\r\n]/.test(s)) s = "'" + s;
  return '"' + s.replaceAll('"', '""') + '"';
}
export function csv(rows: Record<string, unknown>[]): string {
  const keys = rows.length ? Object.keys(rows[0]!) : [];
  return (
    "\uFEFF" +
    [
      keys.map(csvValue).join(","),
      ...rows.map((r) => keys.map((k) => csvValue(r[k])).join(",")),
    ].join("\r\n")
  );
}

async function change(acct: AccountRecord, role: Role, data: Record<string, unknown>) {
  if (!canWrite(role)) throw new ConsoleError("forbidden", 403);
  const action = text(data.action, 40),
    reason = requireReason(data.reason);
  if (action === "credit") {
    const uid = text(data.uid, 100),
      id = text(data.id, 80),
      microUSD = data.microUSD;
    if (
      !/^[a-zA-Z0-9-]{16,80}$/.test(id) ||
      typeof microUSD !== "number" ||
      !Number.isSafeInteger(microUSD) ||
      microUSD < 10000 ||
      microUSD > ADMIN_GRANT_MAX_MICRO_USD
    )
      throw new ConsoleError("invalid_credit");
    if (uid === acct.uid) throw new ConsoleError("self_grant_forbidden", 403);
    if (!(await getAccount(uid))) throw new ConsoleError("account_not_found", 404);
    const [perGrant, perDay] =
      role === "admin"
        ? [ADMIN_GRANT_MAX_MICRO_USD, ADMIN_GRANT_DAILY_MAX_MICRO_USD]
        : [OPERATOR_GRANT_MAX_MICRO_USD, OPERATOR_GRANT_DAILY_MAX_MICRO_USD];
    const operation = await mutateAdminState((s) => {
      const old = s.operations[id];
      if (old) {
        if (old.uid !== uid || old.microUSD !== microUSD || old.reason !== reason)
          throw new ConsoleError("idempotency_conflict", 409);
        // A retry of an accepted grant is neither re-counted nor re-limited.
        return old;
      }
      if (Object.keys(s.operations).length >= 2000)
        throw new ConsoleError("operations_archive_required", 409);
      if (microUSD > perGrant) throw new ConsoleError("grant_limit_exceeded", 403);
      const at = Date.now();
      if (grantedSince(s, actor(acct), at - GRANT_WINDOW_MS) + microUSD > perDay)
        throw new ConsoleError("daily_grant_limit_exceeded", 403);
      const fresh = { uid, microUSD, reason, status: "pending" as const, at, actor: actor(acct) };
      s.operations[id] = fresh;
      appendAudit(s, {
        actor: actor(acct),
        action: "credit_requested",
        target: uid,
        reason,
        detail: { id, microUSD },
      });
      return fresh;
    });
    if (operation.status !== "completed") {
      try {
        await creditExternalTransaction(uid, `admin:${id}`, "admin.grant", microUSD);
      } catch (e) {
        if (!(e instanceof IapError && e.code === "duplicate_transaction")) throw e;
      }
      await mutateAdminState((s) => {
        if (s.operations[id]?.status === "completed") return;
        s.operations[id]!.status = "completed";
        appendAudit(s, {
          actor: actor(acct),
          action: "credit_completed",
          target: uid,
          reason,
          detail: { id, microUSD },
        });
      });
    }
    return { ok: true };
  }
  if (action === "revoke_sessions") {
    if (role !== "admin") throw new ConsoleError("forbidden", 403);
    const uid = text(data.uid, 100);
    const target = await getAccount(uid);
    if (!target) throw new ConsoleError("account_not_found", 404);
    await mutateAdminState((s) =>
      appendAudit(s, {
        actor: actor(acct),
        action: "revoke_sessions_requested",
        target: uid,
        reason,
      }),
    );
    await revokeAccountSessions(uid);
    await mutateAdminState((s) =>
      appendAudit(s, {
        actor: actor(acct),
        action: "revoke_sessions_completed",
        target: uid,
        reason,
      }),
    );
    return { ok: true };
  }
  const target = typeof data.uid === "string" ? await getAccount(data.uid) : null;
  await mutateAdminState((s) => {
    revision(s, data.revision);
    if (action === "settings") {
      if (role !== "admin") throw new ConsoleError("forbidden", 403);
      if (
        typeof data.paused !== "boolean" ||
        !data.features ||
        typeof data.features !== "object" ||
        Array.isArray(data.features)
      )
        throw new ConsoleError("invalid_settings");
      const features = data.features as Record<string, unknown>;
      if (
        Object.keys(features).length !== FEATURES.length ||
        !FEATURES.every((k) => typeof features[k] === "boolean")
      )
        throw new ConsoleError("invalid_settings");
      const before = structuredClone(s.settings);
      s.settings.paused = data.paused;
      s.settings.features = features as AdminState["settings"]["features"];
      appendAudit(s, {
        actor: actor(acct),
        action,
        target: "features",
        reason,
        detail: { before, after: s.settings },
      });
    } else if (action === "model") {
      if (role !== "admin") throw new ConsoleError("forbidden", 403);
      const model = normalizeModelId(text(data.model, 120));
      if (!/^[\w./:-]+$/.test(model) || typeof data.disabled !== "boolean")
        throw new ConsoleError("invalid_model");
      s.settings.disabledModels = s.settings.disabledModels.filter(
        (m) => normalizeModelId(m) !== model,
      );
      if (data.disabled) s.settings.disabledModels.push(model);
      appendAudit(s, {
        actor: actor(acct),
        action,
        target: model,
        reason,
        detail: { disabled: data.disabled },
      });
    } else if (action === "user") {
      if (!target) throw new ConsoleError("account_not_found", 404);
      if (typeof data.suspended !== "boolean") throw new ConsoleError("invalid_field");
      const prior = s.users[target.uid] ?? { suspended: false, note: "" };
      if (data.suspended && (target.uid === acct.uid || owners().includes(target.email ?? "")))
        throw new ConsoleError("protected_admin", 409);
      if (role !== "admin" && roleFor(target, s)) throw new ConsoleError("forbidden", 403);
      s.users[target.uid] = { suspended: data.suspended, note: text(data.note, 2000) };
      appendAudit(s, {
        actor: actor(acct),
        action,
        target: target.uid,
        reason,
        detail: { before: prior, after: s.users[target.uid] },
      });
    } else if (action === "role") {
      if (role !== "admin") throw new ConsoleError("forbidden", 403);
      const email = text(data.email, 254).toLowerCase();
      if (
        !validEmail(email) ||
        !["admin", "operator", "analyst", "none"].includes(String(data.role))
      )
        throw new ConsoleError("invalid_role");
      if (owners().includes(email) || email === acct.email)
        throw new ConsoleError("protected_admin", 409);
      const before = s.roles[email] ?? null;
      if (data.role === "none") delete s.roles[email];
      else s.roles[email] = data.role as Role;
      appendAudit(s, {
        actor: actor(acct),
        action,
        target: email,
        reason,
        detail: { before, after: data.role },
      });
    } else if (action === "ticket") {
      const id = data.id ? text(data.id, 100) : crypto.randomUUID();
      const old = s.tickets.find((t) => t.id === id);
      if (!old && s.tickets.length >= 500) throw new ConsoleError("ticket_archive_required", 409);
      const uid = text(data.uid, 100);
      if (uid && !target) throw new ConsoleError("account_not_found", 404);
      const title = text(data.title, 200),
        note = text(data.note, 3000),
        status = text(data.status, 30),
        priority = text(data.priority, 30),
        assignee = text(data.assignee, 254);
      if (
        !title ||
        !["open", "in_progress", "resolved"].includes(status) ||
        !["normal", "high", "urgent"].includes(priority)
      )
        throw new ConsoleError("invalid_ticket");
      const entry = {
        id,
        uid,
        title,
        note,
        status,
        priority,
        assignee,
        createdAt: old?.createdAt ?? Date.now(),
        updatedAt: Date.now(),
      };
      s.tickets = [...s.tickets.filter((t) => t.id !== id), entry];
      appendAudit(s, {
        actor: actor(acct),
        action,
        target: id,
        reason,
        detail: { status, priority },
      });
    } else throw new ConsoleError("unknown_action");
  });
  return { ok: true };
}

export async function handleConsole(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  opts: { secret: string | null; clientIp: string },
): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://console.local");
  if (url.pathname !== "/console" && !url.pathname.startsWith("/console/")) return false;
  res.setHeader("cache-control", "private, no-store");
  res.setHeader("x-robots-tag", "noindex, nofollow");
  res.setHeader("x-content-type-options", "nosniff");
  res.setHeader("x-frame-options", "DENY");
  res.setHeader("referrer-policy", "no-referrer");
  res.setHeader(
    "content-security-policy",
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  );
  if (!consoleEnabled() || !opts.secret) {
    json(res, 404, { error: "console_unavailable" });
    return true;
  }
  try {
    if (
      req.method === "GET" &&
      ["/console", "/console/", "/console/app.js", "/console/app.css"].includes(url.pathname)
    ) {
      const asset = url.pathname.endsWith(".js")
        ? "app.js"
        : url.pathname.endsWith(".css")
          ? "app.css"
          : "index.html";
      const contents = await fs.readFile(
        new URL(`../web/assets/console/${asset}`, import.meta.url),
      );
      res.writeHead(200, {
        "content-type": asset.endsWith(".js")
          ? "text/javascript; charset=utf-8"
          : asset.endsWith(".css")
            ? "text/css; charset=utf-8"
            : "text/html; charset=utf-8",
      });
      res.end(contents);
      return true;
    }
    if (!ipRateOk(`console:${opts.clientIp}`, 120, 60000))
      throw new ConsoleError("rate_limited", 429);
    const secret = consoleSecret(opts.secret);
    if (req.method === "POST" && url.pathname === "/console/api/login") {
      if (!ipRateOk(`console-login:${opts.clientIp}`, 12, 60000))
        throw new ConsoleError("rate_limited", 429);
      const input = await body(req),
        email = text(input.email, 254).toLowerCase();
      const state = await readAdminState();
      if (!validEmail(email) || (!owners().includes(email) && !state.roles[email]))
        throw new ConsoleError("admin_access_required", 403);
      if (input.method === "request-code") {
        const minted = await requestEmailOtp(email);
        if (!minted.ok) throw new ConsoleError("otp_cooldown", 429);
        const sent = await sendSignInCodeEmail(email, minted.code, Math.round(OTP_TTL_MS / 60000));
        if (!sent.sent) throw new ConsoleError("email_unavailable", 503);
        json(res, 200, { ok: true, expiresInSec: minted.expiresInSec });
        return true;
      }
      let acct: AccountRecord | null = null;
      if (input.method === "verify-code") {
        const spent = await verifyEmailOtp(email, text(input.code, 12));
        if (!spent.ok) throw new ConsoleError("invalid_code", 401);
        acct = (await ensureOtpAccount(email)).acct;
      } else if (input.method === "password")
        acct = await verifyEmailLogin(
          email,
          typeof input.password === "string" && input.password.length <= 256 ? input.password : "",
        );
      else throw new ConsoleError("invalid_login_method");
      const role = roleFor(acct, await readAdminState());
      if (!acct || !role) throw new ConsoleError("invalid_credentials", 401);
      await mutateAdminState((s) =>
        appendAudit(s, {
          actor: actor(acct),
          action: "login",
          target: acct.uid,
          reason: "管理员登录",
        }),
      );
      res.setHeader(
        "set-cookie",
        consoleCookie(mintSession(acct.uid, secret, { sv: acct.sessionVersion, ttlMs: TTL })),
      );
      json(res, 200, { ok: true });
      return true;
    }
    const claims = verifySession(cookie(req), secret);
    const acct = claims ? await getAccount(claims.uid) : null;
    const state = await readAdminState();
    const role = roleFor(acct, state);
    if (!claims || !acct || acct.sessionVersion !== claims.sv)
      throw new ConsoleError("login_required", 401);
    if (!role) throw new ConsoleError("admin_access_required", 403);
    if (req.method === "GET" && url.pathname === "/console/api/me") {
      json(res, 200, {
        uid: acct.uid,
        email: acct.email,
        role,
        owners: owners(),
        environment: process.env.K_SERVICE ? "PRODUCTION" : "LOCAL TEST",
      });
      return true;
    }
    if (req.method === "POST" && url.pathname === "/console/api/logout") {
      await body(req);
      res.setHeader("set-cookie", consoleCookie(""));
      json(res, 200, { ok: true });
      return true;
    }
    if (req.method === "POST" && url.pathname === "/console/api/action") {
      json(res, 200, await change(acct, role, await body(req)));
      return true;
    }
    if (
      req.method === "GET" &&
      ["/console/api/snapshot", "/console/api/export"].includes(url.pathname)
    ) {
      if (!ipRateOk(`console-report:${acct.uid}`, 20, 60000))
        throw new ConsoleError("rate_limited", 429);
      const days = Number(url.searchParams.get("days") ?? 30);
      if (![7, 30, 90].includes(days)) throw new ConsoleError("invalid_range");
      const data = await consoleSnapshot(days);
      if (url.pathname.endsWith("export")) {
        const dataset = url.searchParams.get("dataset") ?? "daily";
        if (!["daily", "users", "payments", "usage", "audit"].includes(dataset))
          throw new ConsoleError("invalid_dataset");
        const rows = data[
          dataset as "daily" | "users" | "payments" | "usage" | "audit"
        ] as unknown as Record<string, unknown>[];
        await mutateAdminState((s) =>
          appendAudit(s, {
            actor: actor(acct),
            action: "export",
            target: dataset,
            reason: "导出运营报表",
            detail: { days, rows: rows.length },
          }),
        );
        res.writeHead(200, {
          "content-type": "text/csv; charset=utf-8",
          "content-disposition": `attachment; filename="lisa-${dataset}-${days}d.csv"`,
        });
        res.end(csv(rows));
      } else json(res, 200, data);
      return true;
    }
    throw new ConsoleError("not_found", 404);
  } catch (e) {
    if (e instanceof BodyTooLargeError) {
      res.setHeader("connection", "close");
      json(res, 413, { error: "body_too_large" });
    } else if (e instanceof ConsoleError) json(res, e.status, { error: e.code });
    else {
      logError(`[console] request failed: ${e instanceof Error ? e.name : "unknown"}`);
      json(res, 503, { error: "data_unavailable" });
    }
  }
  return true;
}

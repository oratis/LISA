/**
 * Server-side funnel events for the hosted edition — the three baselines the
 * commercialization plan needs before it sets any target: first-login success,
 * first-task completion and payment success.
 *
 * What this is NOT: client telemetry. Nothing here runs in the Mac edition or
 * in any client, nothing is sent anywhere, and no third party is involved. The
 * hosted server appends a line to a file under its own data directory when an
 * account event it already handles happens.
 *
 *  - Hosted edition only (`isCloud()`); a no-op everywhere else.
 *  - Pseudonymous: the uid is replaced by a one-way hash; no email, no content,
 *    no model input or output.
 *  - Best-effort: never throws and never blocks the request it describes.
 *  - One file per UTC day per process
 *    (`<global home>/analytics/events-YYYY-MM-DD.<instance>.jsonl`), so two
 *    instances never append to the same object on the GCS FUSE mount.
 *
 * `lisa billing funnel` reads the directory back into the baseline figures.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isCloud } from "../edition.js";
import { lisaGlobalHome } from "../paths.js";
import { logError } from "../log.js";

export type FunnelEventName =
  | "auth_succeeded"
  | "auth_failed"
  | "account_created"
  | "chat_turn_completed"
  | "admission_denied"
  | "purchase_started"
  | "purchase_credited"
  | "purchase_failed"
  | "refund";

export type FunnelProps = Record<string, string | number | boolean>;

export interface FunnelRecord {
  at: number;
  event: FunnelEventName;
  /** One-way hash of the uid; absent when the event has no account. */
  account?: string;
  props?: FunnelProps;
}

const INSTANCE = `${(process.env.K_REVISION ?? "local").replace(/[^A-Za-z0-9_-]/g, "_")}-${process.pid}-${crypto.randomBytes(3).toString("hex")}`;

/** The pseudonymous account key: stable per uid, not reversible to it. */
export function accountKey(uid: string): string {
  return crypto.createHash("sha256").update(`lisa-funnel:${uid}`).digest("hex").slice(0, 16);
}

export function funnelDir(): string {
  return path.join(lisaGlobalHome(), "analytics");
}

/** Record one event (hosted edition only). Never throws. */
export function recordFunnel(
  event: FunnelEventName,
  opts: { uid?: string | null; props?: FunnelProps } = {},
  env: NodeJS.ProcessEnv = process.env,
  now: number = Date.now(),
): void {
  if (!isCloud(env)) return;
  const record: FunnelRecord = {
    at: now,
    event,
    ...(opts.uid ? { account: accountKey(opts.uid) } : {}),
    ...(opts.props && Object.keys(opts.props).length ? { props: opts.props } : {}),
  };
  const day = new Date(now).toISOString().slice(0, 10);
  const file = path.join(funnelDir(), `events-${day}.${INSTANCE}.jsonl`);
  fs.promises
    .mkdir(path.dirname(file), { recursive: true })
    .then(() => fs.promises.appendFile(file, JSON.stringify(record) + "\n"))
    .catch((err: unknown) => logError(`[funnel] append failed: ${(err as Error).message}`));
}

/** Routes whose outcome is read from the response status once it finishes. */
export type FunnelRoute =
  | { kind: "auth"; method: "apple" | "google" | "password" | "register" | "otp" }
  | { kind: "iap" }
  | { kind: "stripe_checkout" };

export function funnelRouteFor(method: string | undefined, url: string): FunnelRoute | null {
  if (method !== "POST") return null;
  const pathname = url.split("?")[0];
  switch (pathname) {
    case "/api/auth/apple":
      return { kind: "auth", method: "apple" };
    case "/api/auth/google":
      return { kind: "auth", method: "google" };
    case "/api/auth/login":
      return { kind: "auth", method: "password" };
    case "/api/auth/register":
      return { kind: "auth", method: "register" };
    case "/api/auth/otp/verify":
      return { kind: "auth", method: "otp" };
    case "/api/billing/iap":
      return { kind: "iap" };
    case "/api/billing/stripe/checkout":
      return { kind: "stripe_checkout" };
    default:
      return null;
  }
}

/** Turn a finished route's status into its funnel event. */
export function recordFunnelOutcome(
  route: FunnelRoute,
  status: number,
  env: NodeJS.ProcessEnv = process.env,
  now: number = Date.now(),
): void {
  const ok = status >= 200 && status < 300;
  if (route.kind === "auth") {
    recordFunnel(
      ok ? "auth_succeeded" : "auth_failed",
      { props: { method: route.method, status } },
      env,
      now,
    );
  } else if (route.kind === "iap") {
    recordFunnel(
      ok ? "purchase_credited" : "purchase_failed",
      { props: { source: "iap", status } },
      env,
      now,
    );
  } else if (ok) {
    recordFunnel("purchase_started", { props: { source: "stripe" } }, env, now);
  }
}

/** Read every event at or after `sinceMs` from `dir`. Unreadable lines are skipped. */
export function readFunnel(dir: string, sinceMs: number): FunnelRecord[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const sinceDay = new Date(sinceMs).toISOString().slice(0, 10);
  const out: FunnelRecord[] = [];
  for (const name of names.sort()) {
    const m = /^events-(\d{4}-\d{2}-\d{2})\..+\.jsonl$/.exec(name);
    if (!m || m[1]! < sinceDay) continue;
    for (const line of fs.readFileSync(path.join(dir, name), "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const rec = JSON.parse(line) as FunnelRecord;
        if (typeof rec.at === "number" && typeof rec.event === "string" && rec.at >= sinceMs)
          out.push(rec);
      } catch {
        /* torn line from a crash mid-append */
      }
    }
  }
  return out.sort((a, b) => a.at - b.at);
}

export interface FunnelSummary {
  /** Per sign-in method: successes and failures. */
  auth: Record<string, { succeeded: number; failed: number }>;
  accountsCreated: number;
  /** Accounts created in the window that completed a chat turn within 24h of creation. */
  activatedWithin24h: number;
  chatTurns: number;
  admissionsDenied: Record<string, number>;
  /** Per payment source (`iap`, `stripe`). */
  purchases: Record<string, { started: number; credited: number; failed: number }>;
  refunds: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export function summarizeFunnel(records: readonly FunnelRecord[]): FunnelSummary {
  const s: FunnelSummary = {
    auth: {},
    accountsCreated: 0,
    activatedWithin24h: 0,
    chatTurns: 0,
    admissionsDenied: {},
    purchases: {},
    refunds: 0,
  };
  const created = new Map<string, number>();
  const firstTurn = new Map<string, number>();
  for (const r of records) {
    const prop = (key: string): string => String(r.props?.[key] ?? "unknown");
    switch (r.event) {
      case "auth_succeeded":
      case "auth_failed": {
        const m = (s.auth[prop("method")] ??= { succeeded: 0, failed: 0 });
        if (r.event === "auth_succeeded") m.succeeded++;
        else m.failed++;
        break;
      }
      case "account_created":
        s.accountsCreated++;
        if (r.account && !created.has(r.account)) created.set(r.account, r.at);
        break;
      case "chat_turn_completed":
        s.chatTurns++;
        if (r.account && !firstTurn.has(r.account)) firstTurn.set(r.account, r.at);
        break;
      case "admission_denied":
        s.admissionsDenied[prop("reason")] = (s.admissionsDenied[prop("reason")] ?? 0) + 1;
        break;
      case "purchase_started":
      case "purchase_credited":
      case "purchase_failed": {
        const p = (s.purchases[prop("source")] ??= { started: 0, credited: 0, failed: 0 });
        if (r.event === "purchase_started") p.started++;
        else if (r.event === "purchase_credited") p.credited++;
        else p.failed++;
        break;
      }
      case "refund":
        s.refunds++;
        break;
    }
  }
  for (const [account, at] of created) {
    const turn = firstTurn.get(account);
    if (turn !== undefined && turn >= at && turn - at <= DAY_MS) s.activatedWithin24h++;
  }
  return s;
}

function rate(num: number, den: number): string {
  return den === 0 ? "n/a" : `${((100 * num) / den).toFixed(1)}% (${num}/${den})`;
}

/** The baseline report `lisa billing funnel` prints. */
export function formatFunnel(s: FunnelSummary, days: number): string {
  const lines = [`LISA Cloud funnel, last ${days} day(s)`];
  let ok = 0;
  let all = 0;
  for (const [method, m] of Object.entries(s.auth).sort()) {
    ok += m.succeeded;
    all += m.succeeded + m.failed;
    lines.push(`  sign-in ${method.padEnd(9)} ${rate(m.succeeded, m.succeeded + m.failed)}`);
  }
  lines.push(`  sign-in success   ${rate(ok, all)}`);
  lines.push(`  accounts created  ${s.accountsCreated}`);
  lines.push(`  first task ≤24h   ${rate(s.activatedWithin24h, s.accountsCreated)}`);
  lines.push(`  chat turns        ${s.chatTurns}`);
  const denied = Object.entries(s.admissionsDenied)
    .sort()
    .map(([k, v]) => `${k}=${v}`)
    .join(", ");
  lines.push(`  admissions denied ${denied || "none"}`);
  const iap = s.purchases.iap ?? { started: 0, credited: 0, failed: 0 };
  const stripe = s.purchases.stripe ?? { started: 0, credited: 0, failed: 0 };
  lines.push(`  in-app purchases  ${rate(iap.credited, iap.credited + iap.failed)} credited`);
  lines.push(`  Stripe checkouts  ${rate(stripe.credited, stripe.started)} paid`);
  lines.push(`  refunds           ${s.refunds}`);
  return lines.join("\n");
}

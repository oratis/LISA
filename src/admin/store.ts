import { normalizeModelId } from "../billing/prices.js";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { lisaGlobalHome } from "../paths.js";
import { firestoreEnabled, getDoc, casUpdate } from "../cloud/firestore.js";
import { logError } from "../log.js";
import type { AccountRecord } from "../web/accounts.js";

export const FEATURES = [
  "chat",
  "voice",
  "uploads",
  "gateway",
  "knowledge",
  "tasks",
  "reflection",
  "connectors",
  "checkout",
] as const;
export type Feature = (typeof FEATURES)[number];
export type Role = "admin" | "operator" | "analyst";
export interface AuditEntry {
  id: string;
  at: number;
  actor: string;
  action: string;
  target: string;
  reason: string;
  detail?: Record<string, unknown>;
}
export interface AdminState {
  schema: 1;
  revision: number;
  roles: Record<string, Role>;
  users: Record<string, { suspended: boolean; note: string }>;
  settings: { paused: boolean; features: Record<Feature, boolean>; disabledModels: string[] };
  tickets: {
    id: string;
    uid: string;
    title: string;
    note: string;
    priority: string;
    status: string;
    createdAt: number;
    updatedAt: number;
    assignee: string;
  }[];
  operations: Record<
    string,
    {
      uid: string;
      microUSD: number;
      reason: string;
      status: "pending" | "completed";
      // Absent on grants recorded before per-operator limits existed.
      at?: number;
      actor?: string;
    }
  >;
  audit: AuditEntry[];
}
export class ConsoleError extends Error {
  constructor(
    public code: string,
    public status = 400,
  ) {
    super(code);
  }
}
export function consoleEnabled(): boolean {
  return process.env.LISA_CONSOLE_ENABLED === "1";
}
export function owners(): string[] {
  return (process.env.LISA_ADMIN_EMAILS ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}
export function emptyState(): AdminState {
  return {
    schema: 1,
    revision: 0,
    roles: {},
    users: {},
    settings: {
      paused: false,
      features: Object.fromEntries(FEATURES.map((k) => [k, true])) as Record<Feature, boolean>,
      disabledModels: [],
    },
    tickets: [],
    operations: {},
    audit: [],
  };
}
function object(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}
export function parseState(v: unknown): AdminState {
  if (
    !object(v) ||
    v.schema !== 1 ||
    !Number.isSafeInteger(v.revision) ||
    !object(v.roles) ||
    !object(v.users) ||
    !object(v.settings) ||
    !object(v.settings.features) ||
    typeof v.settings.paused !== "boolean" ||
    !Array.isArray(v.settings.disabledModels) ||
    !v.settings.disabledModels.every((s) => typeof s === "string") ||
    !FEATURES.every(
      (k) => typeof (v.settings as AdminState["settings"]).features[k] === "boolean",
    ) ||
    !Array.isArray(v.tickets) ||
    !Array.isArray(v.audit) ||
    !object(v.operations) ||
    !Object.values(v.roles).every((r) => ["admin", "operator", "analyst"].includes(String(r))) ||
    !Object.values(v.users).every(
      (u) => object(u) && typeof u.suspended === "boolean" && typeof u.note === "string",
    )
  )
    throw new ConsoleError("admin_store_unavailable", 503);
  const validAudit = (a: unknown) =>
    object(a) &&
    ["id", "actor", "action", "target", "reason"].every((k) => typeof a[k] === "string") &&
    Number.isSafeInteger(a.at);
  const validTicket = (t: unknown) =>
    object(t) &&
    ["id", "uid", "title", "note", "assignee"].every((k) => typeof t[k] === "string") &&
    ["open", "in_progress", "resolved"].includes(String(t.status)) &&
    ["normal", "high", "urgent"].includes(String(t.priority)) &&
    Number.isSafeInteger(t.createdAt) &&
    Number.isSafeInteger(t.updatedAt);
  const validOperation = (o: unknown) =>
    object(o) &&
    typeof o.uid === "string" &&
    typeof o.reason === "string" &&
    Number.isSafeInteger(o.microUSD) &&
    Number(o.microUSD) > 0 &&
    ["pending", "completed"].includes(String(o.status)) &&
    (o.at === undefined || Number.isSafeInteger(o.at)) &&
    (o.actor === undefined || typeof o.actor === "string");
  if (
    Number(v.revision) < 0 ||
    !v.audit.every(validAudit) ||
    !v.tickets.every(validTicket) ||
    !Object.values(v.operations).every(validOperation)
  )
    throw new ConsoleError("admin_store_unavailable", 503);
  return v as unknown as AdminState;
}
const file = () => path.join(lisaGlobalHome(), "admin", "state.json");
export async function readAdminState(): Promise<AdminState> {
  if (firestoreEnabled()) {
    const doc = await getDoc("lisa-global/admin");
    return doc ? parseState(doc.data) : emptyState();
  }
  try {
    return parseState(JSON.parse(await fs.readFile(file(), "utf8")));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return emptyState();
    throw new ConsoleError("admin_store_unavailable", 503);
  }
}
// File mode is supported only by the existing single-instance deployment.
// Serialize mutations in-process (GCS FUSE does not support hard-link locks).
let tail: Promise<unknown> = Promise.resolve();
export async function mutateAdminState<T>(fn: (s: AdminState) => T): Promise<T> {
  if (firestoreEnabled())
    return casUpdate("lisa-global/admin", (current) => {
      const s = current ? parseState(current) : emptyState();
      const result = fn(s);
      s.revision++;
      return { next: s as unknown as Record<string, unknown>, result };
    }).finally(invalidatePolicy);
  const job = tail
    .catch(() => {})
    .then(async () => {
      const s = await readAdminState();
      const result = fn(s);
      s.revision++;
      await fs.mkdir(path.dirname(file()), { recursive: true, mode: 0o700 });
      const temporary = `${file()}.${crypto.randomUUID()}.tmp`;
      await fs.writeFile(temporary, JSON.stringify(s), { mode: 0o600 });
      await fs.rename(temporary, file());
      return result;
    })
    .finally(invalidatePolicy);
  tail = job;
  return job;
}

// ── Hot-path policy ─────────────────────────────────────────────────────────
// Tenant session checks, inference admission and feature switches consult the
// admin state on every authenticated request. They read a small derived policy
// cached for POLICY_TTL_MS, so other instances' changes apply within that time
// and this process's own writes apply immediately. A read or parse failure must
// not sign every tenant out: the last good policy keeps serving, and before any
// good read there are no admin restrictions at all. The console itself keeps
// reading the full document uncached and fails closed.
export const POLICY_TTL_MS = 5000;
interface Policy {
  suspended: ReadonlySet<string>;
  paused: boolean;
  features: Readonly<Record<Feature, boolean>>;
  disabledModels: readonly string[];
}
// Keyed by the storage location, which is fixed in production.
let policyCache: { key: string; value: Policy | null; fetchedAt: number } | null = null;
let policyLoad: { key: string; promise: Promise<Policy | null> } | null = null;
let policyGeneration = 0;
function policyKey(): string {
  return firestoreEnabled() ? "firestore:lisa-global/admin" : file();
}
function invalidatePolicy(): void {
  policyGeneration++;
  // Keep the value: it is still the last good one if the next read fails.
  if (policyCache) policyCache.fetchedAt = -Infinity;
  policyLoad = null;
}
/** Test seam: behave as if the cache TTL had elapsed. */
export function _expireAdminPolicyForTests(): void {
  if (policyCache) policyCache.fetchedAt = -Infinity;
  policyLoad = null;
}
async function loadPolicy(key: string, last: Policy | null): Promise<Policy | null> {
  const generation = policyGeneration;
  let value: Policy | null;
  try {
    const s = await readAdminState();
    value = {
      suspended: new Set(
        Object.entries(s.users)
          .filter(([, u]) => u.suspended)
          .map(([uid]) => uid),
      ),
      paused: s.settings.paused,
      features: { ...s.settings.features },
      disabledModels: s.settings.disabledModels.map((m) => normalizeModelId(m)),
    };
  } catch (e) {
    const why = e instanceof Error ? e.message : "unknown";
    value = last;
    logError(
      last
        ? `[console] admin state unreadable (${why}); keeping the last good admin policy`
        : `[console] ADMIN STATE UNREADABLE (${why}) and no good copy yet: suspensions, ` +
            `feature switches, pause and model blocks are NOT being enforced`,
    );
  }
  // A write by this process during the read makes the result stale at once.
  policyCache = {
    key,
    value,
    fetchedAt: generation === policyGeneration ? Date.now() : -Infinity,
  };
  return value;
}
async function adminPolicy(): Promise<Policy | null> {
  const key = policyKey();
  const cached = policyCache?.key === key ? policyCache : null;
  if (cached && Date.now() - cached.fetchedAt < POLICY_TTL_MS) return cached.value;
  if (policyLoad?.key === key) return policyLoad.promise;
  const load = { key, promise: loadPolicy(key, cached?.value ?? null) };
  policyLoad = load;
  void load.promise.finally(() => {
    if (policyLoad === load) policyLoad = null;
  });
  return load.promise;
}
export function roleFor(acct: AccountRecord | null, state: AdminState): Role | null {
  // Apple aliases are not ownership claims on arbitrary email addresses.
  if (
    !acct?.verified ||
    !acct.email ||
    !["email", "google"].includes(acct.kind) ||
    state.users[acct.uid]?.suspended
  )
    return null;
  const email = acct.email.toLowerCase();
  return owners().includes(email) ? "admin" : (state.roles[email] ?? null);
}
export function appendAudit(s: AdminState, entry: Omit<AuditEntry, "id" | "at">): void {
  s.audit.push({ id: crypto.randomUUID(), at: Date.now(), ...entry });
  // Atomic with the mutation. Never silently discard security history.
  if (s.audit.length > 4000) throw new ConsoleError("audit_archive_required", 409);
}
export function requireReason(v: unknown): string {
  if (typeof v !== "string" || v.trim().length < 3 || v.length > 500)
    throw new ConsoleError("reason_required");
  return v.trim();
}
export async function adminAccountAllowed(uid: string): Promise<boolean> {
  if (!consoleEnabled()) return true;
  return !(await adminPolicy())?.suspended.has(uid);
}
export async function inferencePolicy(
  uid: string,
  model?: string,
): Promise<{ ok: true } | { ok: false; status: number; body: Record<string, unknown> }> {
  if (!consoleEnabled()) return { ok: true };
  const policy = await adminPolicy();
  if (!policy) return { ok: true };
  if (policy.suspended.has(uid))
    return { ok: false, status: 403, body: { error: "account_suspended" } };
  if (policy.paused) return { ok: false, status: 503, body: { error: "service_paused" } };
  if (model && policy.disabledModels.includes(normalizeModelId(model)))
    return { ok: false, status: 403, body: { error: "model_disabled" } };
  return { ok: true };
}
export function routeFeature(method: string, url: string): Feature | null {
  const p = url.split("?")[0] ?? "";
  if (p === "/chat" && method === "POST") return "chat";
  if (/^\/api\/(voice|audio)\//.test(p)) return "voice";
  if (/^\/api\/(upload|attachment)/.test(p)) return "uploads";
  if (/^\/(gw\/|v1\/|api\/gateway)/.test(p)) return "gateway";
  if (/^\/api\/kb(?:\/|$)/.test(p)) return "knowledge";
  if (/^\/api\/tasks(?:\/|$)/.test(p)) return "tasks";
  if (p === "/reflect" || p === "/internal/autonomy/sweep") return "reflection";
  if (/^\/api\/(connectors|github|google|slack|notion|linear)(?:\/|$)/.test(p)) return "connectors";
  // Never block already-paid IAP fulfillment, refunds or payment webhooks.
  if (p === "/api/billing/stripe/checkout") return "checkout";
  return null;
}
export async function featureAllowed(method: string, url: string): Promise<boolean> {
  if (!consoleEnabled()) return true;
  const feature = routeFeature(method, url);
  return !feature || ((await adminPolicy())?.features[feature] ?? true);
}

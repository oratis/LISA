/**
 * Firestore REST client — the multi-instance state backend
 * (docs/PLAN_ACCOUNTS_BILLING_v1.0.md §6.7, milestone B9).
 *
 * Zero dependencies: documents are read/written through Firestore's REST API,
 * authenticated with the Cloud Run service account's ADC token from the
 * metadata server. Everything is OFF unless `LISA_FIRESTORE=1` — the file
 * backends keep working exactly as before under min=max=1.
 *
 * Concurrency model: no client-side transactions; every mutation goes through
 * `casUpdate` — read the doc (fields + updateTime), apply the pure mutation,
 * commit with a `currentDocument` precondition (updateTime, or exists:false
 * for creates), retry on contention. That gives compare-and-swap semantics
 * with plain REST, which is all the account/balance/tx-index/lease state
 * needs.
 *
 * Env: LISA_FIRESTORE=1 to enable; LISA_FIRESTORE_PROJECT overrides the
 * project id (default: the metadata server's). Documents live under the
 * `(default)` database, collection paths chosen by the callers.
 */

function truthy(v: string | undefined): boolean {
  const s = (v ?? "").trim().toLowerCase();
  return s === "1" || s === "true" || s === "yes" || s === "on";
}

export function firestoreEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return truthy(env.LISA_FIRESTORE);
}

// ── ADC token + project id (metadata server; cached) ────────────────────────
const METADATA_BASE = "http://metadata.google.internal/computeMetadata/v1";
let tokenCache: { token: string; expiresAt: number } | null = null;
let projectCache: string | null = null;

async function adcToken(fetchFn: typeof fetch): Promise<string> {
  if (tokenCache && Date.now() < tokenCache.expiresAt - 60_000) return tokenCache.token;
  const res = await fetchFn(`${METADATA_BASE}/instance/service-accounts/default/token`, {
    headers: { "Metadata-Flavor": "Google" },
  });
  if (!res.ok) throw new Error(`metadata token fetch failed (${res.status})`);
  const body = (await res.json()) as { access_token: string; expires_in: number };
  tokenCache = { token: body.access_token, expiresAt: Date.now() + body.expires_in * 1000 };
  return body.access_token;
}

async function projectId(fetchFn: typeof fetch): Promise<string> {
  const env = process.env.LISA_FIRESTORE_PROJECT?.trim();
  if (env) return env;
  if (projectCache) return projectCache;
  const res = await fetchFn(`${METADATA_BASE}/project/project-id`, {
    headers: { "Metadata-Flavor": "Google" },
  });
  if (!res.ok) throw new Error(`metadata project fetch failed (${res.status})`);
  projectCache = (await res.text()).trim();
  return projectCache;
}

/** Test seam. */
export function _resetFirestoreCachesForTests(): void {
  tokenCache = null;
  projectCache = null;
}

// ── JSON ⇄ Firestore value codec (pure) ─────────────────────────────────────
type FsValue = Record<string, unknown>;

export function toFsValue(v: unknown): FsValue {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === "boolean") return { booleanValue: v };
  if (typeof v === "number") {
    return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  }
  if (typeof v === "string") return { stringValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(toFsValue) } };
  if (typeof v === "object") {
    const fields: Record<string, FsValue> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (val === undefined) continue;
      fields[k] = toFsValue(val);
    }
    return { mapValue: { fields } };
  }
  return { nullValue: null };
}

export function fromFsValue(v: FsValue): unknown {
  if ("nullValue" in v) return null;
  if ("booleanValue" in v) return v.booleanValue;
  if ("integerValue" in v) return Number(v.integerValue);
  if ("doubleValue" in v) return v.doubleValue;
  if ("stringValue" in v) return v.stringValue;
  if ("timestampValue" in v) return v.timestampValue;
  if ("arrayValue" in v) {
    const arr = (v.arrayValue as { values?: FsValue[] }).values ?? [];
    return arr.map(fromFsValue);
  }
  if ("mapValue" in v) {
    return fromFsFields(((v.mapValue as { fields?: Record<string, FsValue> }).fields ?? {}));
  }
  return null;
}

export function toFsFields(obj: Record<string, unknown>): Record<string, FsValue> {
  const out: Record<string, FsValue> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined) continue;
    out[k] = toFsValue(v);
  }
  return out;
}

export function fromFsFields(fields: Record<string, FsValue>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) out[k] = fromFsValue(v);
  return out;
}

// ── document ops ────────────────────────────────────────────────────────────
export interface FsDoc {
  data: Record<string, unknown>;
  updateTime: string;
}

export class FirestoreError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = "FirestoreError";
  }
}

async function base(fetchFn: typeof fetch): Promise<{ url: string; headers: Record<string, string> }> {
  const [token, project] = await Promise.all([adcToken(fetchFn), projectId(fetchFn)]);
  return {
    url: `https://firestore.googleapis.com/v1/projects/${project}/databases/(default)/documents`,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
  };
}

/** Read a document (`col/doc[/col/doc…]`). Null when it doesn't exist. */
export async function getDoc(path: string, fetchFn: typeof fetch = fetch): Promise<FsDoc | null> {
  const b = await base(fetchFn);
  const res = await fetchFn(`${b.url}/${path}`, { headers: b.headers });
  if (res.status === 404) return null;
  if (!res.ok) throw new FirestoreError(res.status, `get ${path} failed`);
  const body = (await res.json()) as { fields?: Record<string, FsValue>; updateTime?: string };
  return { data: fromFsFields(body.fields ?? {}), updateTime: body.updateTime ?? "" };
}

/**
 * Write a document with an optional precondition. `precondition`:
 *  - {exists:false}   create-only (fails 409/412 if present)
 *  - {updateTime}     CAS against the version read earlier
 *  - undefined        unconditional set
 */
export async function setDoc(
  path: string,
  data: Record<string, unknown>,
  precondition?: { exists?: boolean; updateTime?: string },
  fetchFn: typeof fetch = fetch,
): Promise<void> {
  const b = await base(fetchFn);
  const parts = path.split("/");
  const name = `projects/${await projectId(fetchFn)}/databases/(default)/documents/${path}`;
  void parts;
  const write: Record<string, unknown> = {
    update: { name, fields: toFsFields(data) },
  };
  if (precondition) {
    write.currentDocument =
      precondition.updateTime !== undefined
        ? { updateTime: precondition.updateTime }
        : { exists: precondition.exists ?? false };
  }
  const res = await fetchFn(`${b.url.replace(/\/documents$/, "/documents:commit")}`, {
    method: "POST",
    headers: b.headers,
    body: JSON.stringify({ writes: [write] }),
  });
  if (!res.ok) throw new FirestoreError(res.status, `commit ${path} failed (${res.status})`);
}

export async function deleteDoc(path: string, fetchFn: typeof fetch = fetch): Promise<void> {
  const b = await base(fetchFn);
  const res = await fetchFn(`${b.url}/${path}`, { method: "DELETE", headers: b.headers });
  if (!res.ok && res.status !== 404) throw new FirestoreError(res.status, `delete ${path} failed`);
}

/** Contention statuses worth retrying: CAS conflict / aborted. */
function isContention(e: unknown): boolean {
  return e instanceof FirestoreError && (e.status === 409 || e.status === 412 || e.status === 429);
}

/**
 * Read-modify-write with compare-and-swap semantics. `fn` gets the current
 * data (null if absent) and returns the next data (return null to leave the
 * doc untouched). Retries contention with a small backoff.
 */
export async function casUpdate<T>(
  path: string,
  fn: (current: Record<string, unknown> | null) => { next: Record<string, unknown> | null; result: T },
  fetchFn: typeof fetch = fetch,
  attempts = 5,
): Promise<T> {
  for (let i = 0; ; i++) {
    const doc = await getDoc(path, fetchFn);
    const { next, result } = fn(doc?.data ?? null);
    if (next === null) return result;
    try {
      await setDoc(path, next, doc ? { updateTime: doc.updateTime } : { exists: false }, fetchFn);
      return result;
    } catch (e) {
      if (!isContention(e) || i >= attempts - 1) throw e;
      await new Promise((r) => setTimeout(r, 50 * (i + 1) + Math.floor(Math.random() * 50)));
    }
  }
}

// ── per-uid turn lease (cross-instance serialization) ───────────────────────
export interface LeaseHandle {
  path: string;
  owner: string;
}

/**
 * Acquire `leases/{key}` for `ttlMs`. Returns a handle, or null when another
 * live owner holds it. Expired leases are taken over via CAS.
 */
export async function acquireLease(
  key: string,
  owner: string,
  ttlMs: number,
  now: number = Date.now(),
  fetchFn: typeof fetch = fetch,
): Promise<LeaseHandle | null> {
  const path = `lisa-leases/${key}`;
  try {
    return await casUpdate<LeaseHandle | null>(
      path,
      (current) => {
        const expiresAt = typeof current?.expiresAt === "number" ? current.expiresAt : 0;
        const heldBy = typeof current?.owner === "string" ? current.owner : "";
        if (current && expiresAt > now && heldBy !== owner) {
          return { next: null, result: null }; // held by a live other owner
        }
        return { next: { owner, expiresAt: now + ttlMs }, result: { path, owner } };
      },
      fetchFn,
      3,
    );
  } catch {
    return null; // contention beyond retries == busy
  }
}

/**
 * Push a held lease's expiry out by `ttlMs` (#272). A turn can legitimately run
 * far longer than one TTL (chat SSE runs under `--timeout 3600`), so the holder
 * heartbeats instead of the TTL being raised to cover the worst case — a
 * crashed holder still frees the lease within one TTL. Returns false when we no
 * longer own it (took too long, someone else took over): the caller stops
 * renewing rather than stealing it back.
 */
/**
 * Renew a held turn lease. Returns:
 *   "held"  — we still own it and pushed the expiry out;
 *   "lost"  — someone else owns it now (or it's gone) → stop renewing;
 *   "error" — a transient failure (network / CAS contention). We DON'T know
 *             ownership was lost, so the caller must keep beating; the lease
 *             expiry is the real backstop. Conflating this with "lost" (the old
 *             boolean did) let a single blip stop the heartbeat and strand the
 *             lease, so a peer took it over and double-ran the account.
 */
export async function renewLease(
  handle: LeaseHandle,
  ttlMs: number,
  now: number = Date.now(),
  fetchFn: typeof fetch = fetch,
): Promise<"held" | "lost" | "error"> {
  try {
    return await casUpdate<"held" | "lost">(
      handle.path,
      (current) => {
        if (!current || current.owner !== handle.owner) return { next: null, result: "lost" };
        return { next: { owner: handle.owner, expiresAt: now + ttlMs }, result: "held" };
      },
      fetchFn,
      2,
    );
  } catch {
    return "error"; // transient; next heartbeat retries, expiry is the backstop
  }
}

/** Release a held lease (best-effort; expiry is the backstop). */
export async function releaseLease(handle: LeaseHandle, fetchFn: typeof fetch = fetch): Promise<void> {
  try {
    await casUpdate(
      handle.path.replace(/^lisa-leases\//, "lisa-leases/"),
      (current) => {
        if (!current || current.owner !== handle.owner) return { next: null, result: undefined };
        return { next: { owner: "", expiresAt: 0 }, result: undefined };
      },
      fetchFn,
      2,
    );
  } catch {
    // expiry will clean up
  }
}

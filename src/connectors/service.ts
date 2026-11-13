/** Shared durable lifecycle for reviewed, local-owner, read-only connectors. */
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { withFileLock } from "../soul/lock.js";
import type { SecretStore } from "../warden/secrets.js";
import type { ToolDefinition } from "../types.js";
import { ConnectorError, type CredentialAccess, type ReadonlyDriver } from "./types.js";

export const CONNECTOR_STATES = [
  "waiting",
  "authorizing",
  "selecting",
  "ready",
  "resuming",
  "completed",
  "cancelled",
  "failed",
  "expired",
] as const;
type Status = (typeof CONNECTOR_STATES)[number];
export interface ConnectionRequestView<A, R> {
  id: string;
  sessionId: string;
  status: Status;
  createdAt: number;
  expiresAt: number;
  account?: A;
  resources: R[];
  userCode?: string;
  authorizationUrl?: string;
  error?: string;
  connected: boolean;
}
interface Request<A, R> extends Omit<ConnectionRequestView<A, R>, "connected"> {
  prompt: string;
  connectionId?: string;
  stagedSecret?: string;
  stagedConnectionId?: string;
  attempts: number;
  auth?: { id: string; pid: number; startedAt: number };
}
interface Connection<A, R> {
  id: string;
  account: A;
  resources: R[];
  secret: string;
}
interface State<A, R> {
  version: 2;
  requests: Request<A, R>[];
  connection?: Connection<A, R>;
}
export interface ConnectorResume<A, R> {
  request: ConnectionRequestView<A, R> & { prompt: string };
  tools: ToolDefinition[];
  signal: AbortSignal;
  provider: string;
  /** Commits transcript and completion together under the request lock. */
  commit: (persist: () => Promise<void>) => Promise<void>;
}
export interface ConnectorOptions<A, R> {
  home: string;
  driver: ReadonlyDriver<A, R>;
  secrets: SecretStore;
  resume: (run: ConnectorResume<A, R>) => Promise<void>;
  changed: (sessionId: string) => void;
  now?: () => number;
  /** Upper bound on best-effort upstream revocation during disconnect (tests shorten it). */
  revokeTimeoutMs?: number;
}
const terminal = (s: Status) => ["completed", "cancelled", "expired"].includes(s);
const idOK = (s: unknown): s is string => typeof s === "string" && /^[a-zA-Z0-9_-]{1,100}$/.test(s);
function validate<A, R>(value: unknown, driver: ReadonlyDriver<A, R>): State<A, R> {
  const s = value as State<A, R>;
  const accountOK = driver.validAccount;
  const reposOK = (r: R[]) => Array.isArray(r) && r.length <= 30 && r.every(driver.validResource);
  if (
    !s ||
    s.version !== 2 ||
    !Array.isArray(s.requests) ||
    s.requests.length > 100 ||
    new Set(s.requests.map((r) => r?.id)).size !== s.requests.length ||
    s.requests.some(
      (r) =>
        !r ||
        !idOK(r.id) ||
        !idOK(r.sessionId) ||
        !CONNECTOR_STATES.includes(r.status) ||
        typeof r.prompt !== "string" ||
        r.prompt.length > 32_000 ||
        !Number.isFinite(r.createdAt) ||
        !Number.isFinite(r.expiresAt) ||
        !Number.isInteger(r.attempts) ||
        r.attempts < 0 ||
        r.attempts > 3 ||
        !reposOK(r.resources) ||
        (r.account !== undefined && !accountOK(r.account)) ||
        (r.connectionId !== undefined && !idOK(r.connectionId)) ||
        (r.stagedSecret !== undefined &&
          (!idOK(r.stagedConnectionId) ||
            r.stagedSecret !== `${driver.id}/${r.stagedConnectionId}`)) ||
        (r.stagedConnectionId !== undefined && (!idOK(r.stagedConnectionId) || !r.stagedSecret)) ||
        (r.auth !== undefined &&
          (!idOK(r.auth.id) ||
            !Number.isSafeInteger(r.auth.pid) ||
            r.auth.pid <= 0 ||
            !Number.isFinite(r.auth.startedAt))) ||
        (r.authorizationUrl !== undefined && !driver.validAuthorizationUrl?.(r.authorizationUrl)) ||
        (r.userCode !== undefined && !/^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(r.userCode)) ||
        (r.error !== undefined && !/^[a-z_]{1,100}$/.test(r.error)),
    ) ||
    (s.connection !== undefined &&
      (!s.connection ||
        !idOK(s.connection.id) ||
        s.connection.secret !== `${driver.id}/${s.connection.id}` ||
        !accountOK(s.connection.account) ||
        !reposOK(s.connection.resources) ||
        s.connection.resources.length === 0))
  ) {
    throw new ConnectorError("connector_state_corrupt");
  }
  return s;
}

export class ReadonlyConnector<A, R> {
  private readonly dir: string;
  private readonly now: () => number;
  private readonly jobs = new Map<string, { abort: AbortController; promise: Promise<void> }>();
  private stopped = false;
  private timer?: NodeJS.Timeout;
  private draining?: Promise<void>;
  constructor(private readonly options: ConnectorOptions<A, R>) {
    this.dir = path.join(options.home, "connectors", options.driver.id);
    this.now = options.now ?? Date.now;
  }
  private async state<T>(fn: (s: State<A, R>) => Promise<T> | T, write = true): Promise<T> {
    await fs.mkdir(this.dir, { recursive: true, mode: 0o700 });
    await fs.chmod(this.dir, 0o700);
    return withFileLock(path.join(this.dir, "state.lock"), async () => {
      const file = path.join(this.dir, "state.json");
      let state: State<A, R>;
      try {
        if ((await fs.stat(file)).size > 4_000_000)
          throw new ConnectorError("connector_state_corrupt");
        const raw = JSON.parse(await fs.readFile(file, "utf8")) as State<A, R> & {
          version: number;
        };
        if (Number(raw.version) === 1 && this.options.driver.id === "github") {
          const legacy = raw as unknown as {
            version: number;
            requests: Array<Record<string, unknown>>;
            connection?: Record<string, unknown>;
          };
          for (const request of legacy.requests) {
            request.resources = request.repositories;
            delete request.repositories;
          }
          if (legacy.connection) {
            legacy.connection.resources = legacy.connection.repositories;
            delete legacy.connection.repositories;
          }
          legacy.version = 2;
          validate(legacy, this.options.driver);
          try {
            await fs.copyFile(file, `${file}.v1.bak`, fs.constants.COPYFILE_EXCL);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
          }
        }
        state = validate(raw, this.options.driver);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT")
          state = { version: 2, requests: [] };
        else throw new ConnectorError("connector_state_corrupt");
      }
      const result = await fn(state);
      if (write) {
        validate(state, this.options.driver);
        const tmp = `${file}.${randomUUID()}.tmp`;
        try {
          const handle = await fs.open(tmp, "wx", 0o600);
          try {
            await handle.writeFile(JSON.stringify(state));
            await handle.sync();
          } finally {
            await handle.close();
          }
          await fs.rename(tmp, file);
        } finally {
          await fs.rm(tmp, { force: true });
        }
      }
      return result;
    });
  }
  private find(s: State<A, R>, id: string) {
    const r = s.requests.find((r) => r.id === id);
    if (!r) throw new ConnectorError("request_not_found");
    return r;
  }
  private view(r: Request<A, R>, s: State<A, R>): ConnectionRequestView<A, R> {
    const connected =
      !["authorizing", "selecting"].includes(r.status) &&
      !!r.connectionId &&
      s.connection?.id === r.connectionId;
    return {
      id: r.id,
      sessionId: r.sessionId,
      status: r.status,
      createdAt: r.createdAt,
      expiresAt: r.expiresAt,
      account: connected ? s.connection!.account : r.account,
      resources: connected ? s.connection!.resources : r.resources,
      userCode: r.userCode,
      authorizationUrl: r.authorizationUrl,
      error: r.error,
      connected,
    };
  }
  async list(sessionId: string): Promise<ConnectionRequestView<A, R>[]> {
    if (!idOK(sessionId)) throw new ConnectorError("invalid_session");
    return this.state(
      (s) => s.requests.filter((r) => r.sessionId === sessionId).map((r) => this.view(r, s)),
      false,
    );
  }
  async create(sessionId: string, prompt: string): Promise<ConnectionRequestView<A, R>> {
    if (!idOK(sessionId) || !prompt.trim() || prompt.length > 32_000)
      throw new ConnectorError("invalid_request");
    const view = await this.state((s) => {
      // Retain a bounded card history; active requests are never silently evicted.
      s.requests = s.requests.filter(
        (r) => !terminal(r.status) || r.createdAt > this.now() - 7 * 86400_000,
      );
      while (s.requests.length >= 100) {
        const i = s.requests.findIndex((r) => terminal(r.status));
        if (i < 0) throw new ConnectorError("too_many_connection_requests");
        s.requests.splice(i, 1);
      }
      const r: Request<A, R> = {
        id: randomUUID(),
        sessionId,
        prompt,
        createdAt: this.now(),
        expiresAt: this.now() + 24 * 3600_000,
        status: s.connection ? "ready" : "waiting",
        resources: s.connection?.resources ?? [],
        account: s.connection?.account,
        connectionId: s.connection?.id,
        attempts: 0,
      };
      s.requests.push(r);
      return this.view(r, s);
    });
    this.options.changed(sessionId);
    this.kick();
    return view;
  }
  /** A new user turn supersedes unfinished work; never resume an obsolete instruction. */
  async cancelSession(sessionId: string) {
    const ids = await this.state(
      (s) =>
        s.requests.filter((r) => r.sessionId === sessionId && !terminal(r.status)).map((r) => r.id),
      false,
    );
    for (const id of ids) await this.cancel(id);
  }
  async cancel(id: string) {
    const sid = await this.state(async (s) => {
      const r = this.find(s, id);
      if (!terminal(r.status)) {
        r.status = "cancelled";
        delete r.userCode;
        delete r.authorizationUrl;
        delete r.auth;
        if (r.stagedSecret) await this.options.secrets.remove(r.stagedSecret);
        delete r.stagedSecret;
        delete r.stagedConnectionId;
      }
      return r.sessionId;
    });
    this.jobs.get(id)?.abort.abort();
    this.options.changed(sid);
  }
  async authorize(id: string, mode: string, accountId?: string) {
    if (this.jobs.size >= 4 && !this.jobs.has(id)) throw new ConnectorError("connector_busy");
    if (!this.options.driver.authModes.includes(mode))
      throw new ConnectorError("invalid_authorization_mode");
    const attempt = await this.state(async (s) => {
      const r = this.find(s, id);
      if (r.status === "authorizing" || (r.status === "selecting" && mode === "existing"))
        return undefined;
      if (!["waiting", "failed", "selecting"].includes(r.status))
        throw new ConnectorError("request_not_authorizable");
      if (r.expiresAt <= this.now()) throw new ConnectorError("request_expired");
      if (r.stagedSecret) await this.options.secrets.remove(r.stagedSecret);
      delete r.stagedSecret;
      delete r.stagedConnectionId;
      r.status = "authorizing";
      delete r.error;
      delete r.userCode;
      delete r.authorizationUrl;
      r.auth = { id: randomUUID(), pid: process.pid, startedAt: this.now() };
      return r.auth.id;
    });
    if (!attempt) return;
    await this.jobs.get(id)?.promise;
    this.job(id, async (signal) => {
      const result = await this.options.driver.authorize(
        mode,
        signal,
        (value) => {
          if (value.userCode && !/^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(value.userCode)) return;
          if (
            value.authorizationUrl &&
            !this.options.driver.validAuthorizationUrl?.(value.authorizationUrl)
          )
            return;
          void this.state((s) => {
            const r = this.find(s, id);
            if (r.status === "authorizing" && r.auth?.id === attempt) {
              r.userCode = value.userCode;
              r.authorizationUrl = value.authorizationUrl;
            }
            return r.sessionId;
          })
            .then((sid) => this.options.changed(sid))
            .catch(() => {});
        },
        accountId,
      );
      const sid = await this.state(async (s) => {
        const r = this.find(s, id);
        if (r.status !== "authorizing" || r.auth?.id !== attempt || signal.aborted)
          return r.sessionId;
        if (!this.options.driver.validAccount(result.account))
          throw new ConnectorError("connector_invalid_response");
        const secret = `${this.options.driver.id}/${attempt}`;
        await this.options.secrets.set(secret, result.token);
        r.stagedSecret = secret;
        r.stagedConnectionId = attempt;
        r.account = result.account;
        r.resources = [];
        r.status = "selecting";
        delete r.userCode;
        delete r.authorizationUrl;
        delete r.auth;
        return r.sessionId;
      });
      this.options.changed(sid);
    });
  }
  private credentials(secret: string): CredentialAccess {
    return {
      use: async (work) =>
        withFileLock(
          path.join(this.dir, `${secret.split("/")[1]}.credential.lock`),
          async () => {
            const token = await this.options.secrets.get(secret);
            if (!token) throw new ConnectorError(this.options.driver.reauthorizationCode);
            return work(token, async (value) => {
              await this.state(async (s) => {
                if (
                  s.connection?.secret !== secret &&
                  !s.requests.some((r) => r.stagedSecret === secret && r.status === "selecting")
                )
                  throw new ConnectorError("connection_not_granted");
                await this.options.secrets.set(secret, value);
              });
            });
          },
          // A metadata batch can run for the whole five-minute continuation.
          // Never steal its credential lock while that bounded read is still alive.
          { staleMs: 10 * 60_000, timeoutMs: 90_000 },
        ),
    };
  }
  /** Read the staged grant inside the caller's state lock. */
  private async staged(r: Request<A, R>) {
    if (r.status !== "selecting" || !r.stagedSecret || !r.account || r.expiresAt <= this.now())
      throw new ConnectorError("request_not_selecting");
    const token = await this.options.secrets.get(r.stagedSecret);
    if (!token) throw new ConnectorError(this.options.driver.reauthorizationCode);
    return {
      credentials: this.credentials(r.stagedSecret),
      account: r.account,
      secret: r.stagedSecret,
    };
  }
  async resources(id: string, page: number, signal: AbortSignal) {
    const { credentials } = await this.state((s) => this.staged(this.find(s, id)), false);
    return this.options.driver.resources(credentials, page, signal);
  }
  async confirm(id: string, names: unknown, signal: AbortSignal) {
    if (
      !Array.isArray(names) ||
      names.length === 0 ||
      names.length > 30 ||
      !names.every(this.options.driver.validResourceName)
    )
      throw new ConnectorError("invalid_resources");
    const staged = await this.state(async (s) => {
      const r = this.find(s, id);
      if (["ready", "resuming", "completed"].includes(r.status)) return;
      return this.staged(r);
    }, false);
    if (!staged) return; // double click / replay never widens an existing grant
    const { credentials, account, secret } = staged;
    const actual = await this.options.driver.account(credentials, signal);
    if (this.options.driver.accountId(actual) !== this.options.driver.accountId(account))
      throw new ConnectorError("connector_account_changed");
    const repos: R[] = [];
    for (const name of [...new Set(names)])
      repos.push(await this.options.driver.resource(credentials, name, signal));
    if (!repos.every(this.options.driver.validResource))
      throw new ConnectorError("connector_invalid_response");
    const sid = await this.state(async (s) => {
      const r = this.find(s, id);
      if (["ready", "resuming", "completed"].includes(r.status)) return r.sessionId;
      if (
        r.status !== "selecting" ||
        r.stagedSecret !== secret ||
        !r.stagedConnectionId ||
        r.expiresAt <= this.now()
      )
        throw new ConnectorError("request_not_selecting");
      if (s.connection) {
        const old = s.connection;
        for (const other of s.requests)
          if (other.connectionId === old.id && !terminal(other.status)) other.status = "cancelled";
        await this.options.secrets.remove(old.secret);
      }
      s.connection = {
        id: r.stagedConnectionId,
        account: actual,
        resources: repos,
        secret: r.stagedSecret,
      };
      r.connectionId = r.stagedConnectionId;
      r.account = actual;
      r.resources = repos;
      r.status = "ready";
      r.attempts = 0;
      delete r.stagedSecret;
      delete r.stagedConnectionId;
      return r.sessionId;
    });
    this.options.changed(sid);
    this.kick();
  }
  async disconnect() {
    const revoke = this.options.driver.revoke?.bind(this.options.driver);
    const tokens: string[] = [];
    // Read for upstream revocation only; a failed read must never keep a local secret.
    const take = async (secret: string) => {
      if (revoke)
        try {
          const token = await this.options.secrets.get(secret);
          if (token) tokens.push(token);
        } catch {
          /* best-effort */
        }
      await this.options.secrets.remove(secret);
    };
    const sessions = await this.state(async (s) => {
      if (s.connection) await take(s.connection.secret);
      delete s.connection;
      for (const r of s.requests) {
        if (!terminal(r.status)) r.status = "cancelled";
        if (r.stagedSecret) await take(r.stagedSecret);
        delete r.stagedSecret;
        delete r.stagedConnectionId;
        delete r.userCode;
        delete r.authorizationUrl;
        delete r.auth;
      }
      return [...new Set(s.requests.map((r) => r.sessionId))];
    });
    for (const job of this.jobs.values()) job.abort.abort();
    sessions.forEach(this.options.changed);
    // The local delete above is already durable; revocation is bounded and its failure ignored.
    if (revoke && tokens.length) {
      // A referenced timer, not AbortSignal.timeout(): that one is unref'd, so
      // in a short-lived process (CLI, test) the event loop could empty before
      // the bound fires and the await would never settle. Bounded even when a
      // driver ignores the signal.
      const controller = new AbortController();
      let timer: NodeJS.Timeout | undefined;
      const expired = new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          controller.abort(new ConnectorError("revoke_timeout"));
          resolve();
        }, this.options.revokeTimeoutMs ?? 5_000);
      });
      try {
        await Promise.race([
          Promise.allSettled(tokens.map(async (token) => revoke(token, controller.signal))),
          expired,
        ]);
      } finally {
        clearTimeout(timer);
      }
    }
  }
  async retry(id: string) {
    await this.state((s) => {
      const r = this.find(s, id);
      if (
        r.status !== "failed" ||
        r.attempts >= 3 ||
        r.expiresAt <= this.now() ||
        r.connectionId !== s.connection?.id
      )
        throw new ConnectorError("request_cannot_retry");
      r.status = "ready";
      delete r.error;
    });
    this.kick();
  }
  private job(id: string, work: (signal: AbortSignal) => Promise<void>) {
    if (this.stopped || this.jobs.has(id)) return;
    const abort = new AbortController();
    const promise = work(abort.signal)
      .catch(async (error) => {
        if (this.stopped) return; // restart recovers the durable ready/resuming state
        const sid = await this.state((s) => {
          const r = this.find(s, id);
          if (!terminal(r.status)) {
            r.status = "failed";
            r.error = error instanceof ConnectorError ? error.code : "connector_failed";
            delete r.userCode;
            delete r.authorizationUrl;
          }
          return r.sessionId;
        });
        this.options.changed(sid);
      })
      .catch(() => {})
      .finally(() => {
        this.jobs.delete(id);
      });
    this.jobs.set(id, { abort, promise });
  }
  private tool(id: string): ToolDefinition {
    return {
      ...this.options.driver.tool,
      execute: async (input, ctx) => {
        const { connection, token, credentials } = await this.state(async (s) => {
          const r = this.find(s, id);
          if (
            r.status !== "resuming" ||
            !s.connection ||
            s.connection.id !== r.connectionId ||
            r.expiresAt <= this.now() ||
            ctx.signal.aborted
          )
            throw new ConnectorError("connection_not_granted");
          const token = await this.options.secrets.get(s.connection.secret);
          return {
            connection: s.connection,
            token,
            credentials: this.credentials(s.connection.secret),
          };
        }, false);
        try {
          if (!token) throw new ConnectorError(this.options.driver.reauthorizationCode);
          const output = await this.options.driver.read(
            credentials,
            connection.account,
            connection.resources,
            input,
            ctx.signal,
          );
          return JSON.parse(JSON.stringify(output).split(token).join("[redacted]")) as unknown;
        } catch (error) {
          if (
            error instanceof ConnectorError &&
            error.code === this.options.driver.reauthorizationCode
          ) {
            const sessions = await this.state(async (s) => {
              if (s.connection?.id !== connection.id) return [];
              await this.options.secrets.remove(s.connection.secret);
              delete s.connection;
              return s.requests
                .filter((r) => r.connectionId === connection.id && !terminal(r.status))
                .map((r) => {
                  r.status = "failed";
                  r.error = this.options.driver.reauthorizationCode;
                  return r.sessionId;
                });
            });
            sessions.forEach(this.options.changed);
          }
          throw error;
        }
      },
    };
  }
  async start() {
    // Interrupted interactive auth requires a new click, never a silent OAuth restart.
    await this.state((s) => {
      for (const r of s.requests)
        if (r.status === "authorizing") {
          let alive = false;
          if (r.auth) {
            try {
              process.kill(r.auth.pid, 0);
              alive = true;
            } catch {
              /* dead owner */
            }
          }
          if (!alive || !r.auth || this.now() - r.auth.startedAt > 10 * 60_000) {
            r.status = "waiting";
            delete r.userCode;
            delete r.authorizationUrl;
            delete r.auth;
          }
        }
    });
    this.timer = setInterval(() => this.kick(), 5000);
    this.timer.unref();
    this.kick();
  }
  private kick() {
    if (this.stopped || this.draining) return;
    this.draining = this.drain()
      .catch(() => {})
      .finally(() => {
        this.draining = undefined;
      });
  }
  private async drain() {
    const runnable = await this.state(async (s) => {
      for (const r of s.requests)
        if (!terminal(r.status) && r.expiresAt <= this.now()) {
          r.status = "expired";
          delete r.userCode;
          delete r.authorizationUrl;
          if (r.stagedSecret) await this.options.secrets.remove(r.stagedSecret);
          delete r.stagedSecret;
          delete r.stagedConnectionId;
          this.jobs.get(r.id)?.abort.abort();
        }
      return s.requests
        .filter((r) => r.status === "ready" || r.status === "resuming")
        .map((r) => r.id);
    });
    for (const id of runnable.slice(0, 2))
      this.job(id, async (signal) => {
        let acquired = false;
        try {
          await withFileLock(
            path.join(this.dir, `${id}.run.lock`),
            async () => {
              acquired = true;
              const request = await this.state((s) => {
                const r = this.find(s, id);
                if (!["ready", "resuming"].includes(r.status)) return null;
                if (r.attempts >= 3) throw new ConnectorError("resume_attempts_exhausted");
                r.status = "resuming";
                r.attempts++;
                return { ...this.view(r, s), prompt: r.prompt };
              });
              if (!request) return;
              this.options.changed(request.sessionId);
              const deadline = AbortSignal.any([signal, AbortSignal.timeout(5 * 60_000)]);
              await this.options.resume({
                request,
                provider: this.options.driver.id,
                tools: [this.tool(id)],
                signal: deadline,
                commit: async (persist) => {
                  await this.state(async (s) => {
                    const r = this.find(s, id);
                    if (
                      r.status !== "resuming" ||
                      deadline.aborted ||
                      s.connection?.id !== r.connectionId
                    )
                      throw new ConnectorError(r.error ?? "request_cancelled");
                    await persist();
                    r.status = "completed";
                    delete r.error;
                  });
                  this.options.changed(request.sessionId);
                },
              });
            },
            { staleMs: 10 * 60_000, timeoutMs: 1000 },
          );
        } catch (error) {
          // Another server owns the lease. It alone may transition this request.
          if (!acquired && (error as Error).message.startsWith("timed out acquiring lock")) return;
          throw error;
        }
      });
  }
  async stop() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    await this.draining;
    for (const job of this.jobs.values()) job.abort.abort();
    const ownJobs = [...this.jobs.keys()];
    await Promise.allSettled([...this.jobs.values()].map((job) => job.promise));
    if (ownJobs.length)
      await this.state((s) => {
        for (const r of s.requests)
          if (ownJobs.includes(r.id) && r.status === "authorizing" && r.auth?.pid === process.pid) {
            r.status = "waiting";
            delete r.auth;
            delete r.userCode;
            delete r.authorizationUrl;
          }
      }).catch(() => {});
  }
}

/** Public lifecycle surface, independent of a provider's account/resource shape. */
export type ConnectorService = Pick<
  ReadonlyConnector<unknown, unknown>,
  keyof ReadonlyConnector<unknown, unknown>
>;

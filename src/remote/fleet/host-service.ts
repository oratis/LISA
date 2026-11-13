import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as wait } from "node:timers/promises";
import {
  type Approval,
  type ApprovalOutcome,
  type ClaudeRunner,
  type ClaudeSession,
} from "./claude.js";
import {
  digest,
  FleetError,
  HOST_API,
  requiredText,
  uuid,
  type FleetGrant,
  type FleetPeer,
} from "./types.js";

interface Workspace {
  id: string;
  name: string;
  root: string;
  inode: string;
}
interface RunRow {
  id: string;
  host: string;
  device: string;
  workspace: string;
  epoch: string;
  state: string;
  result: string;
  pending: string | null;
  created: number;
  /** Process group of the run's agent and when it was launched, once it has one. */
  pgid: number | null;
  started: number | null;
  /** The backend process that launched it. */
  backend: number | null;
}
interface Orphan {
  id: string;
  pgid: number;
  started: number;
}
export interface FleetHostOptions {
  /** `kill(id, 0)`: whether a process exists, or a process group for a negative id. */
  exists?: (id: number) => boolean;
  /** When the process with this id started (ms since the epoch), or undefined if unknown. */
  startedAt?: (pid: number) => number | undefined;
  /** How long a leftover agent gets between SIGTERM and SIGKILL. */
  stopGraceMs?: number;
}
type Body = Record<string, unknown>;
type EventType =
  | "turn_started"
  | "approval_requested"
  | "approval_resolved"
  | "tool_blocked"
  | "turn_completed"
  | "turn_failed"
  | "cancel_requested"
  | "run_ended"
  | "outcome_unknown"
  | "owner_released"
  | "orphan_released"
  | "history_started";
const ACTIVE = "('running','waiting','approval','cancelling')";
// Timeline bounds. A long run drops its oldest entries and reports the gap.
const MAX_EVENTS = 500,
  MAX_PAGE = 100,
  MAX_BLOCKED_PER_TURN = 20,
  PROMPT_EXCERPT = 500,
  RESULT_EXCERPT = 4000;
function inside(parent: string, entry: string) {
  return entry === parent || entry.startsWith(parent.endsWith("/") ? parent : parent + "/");
}
/**
 * Mac volumes are normally case- and normalization-insensitive: /Users/me/Project
 * and /users/me/project are one directory. Boundary checks compare folded paths,
 * which errs toward refusing on the rare case-sensitive volume.
 */
function fold(p: string) {
  return p.normalize("NFC").toLowerCase();
}
function within(parent: string, entry: string) {
  return inside(fold(parent), fold(entry));
}
/** Workspace-relative when inside the workspace, so a card never needs the host's layout. */
function target(root: string, value: unknown): string {
  if (typeof value !== "string") return "";
  const file = path.resolve(root, value);
  return (inside(root, file) ? path.relative(root, file) || "." : file).slice(0, 512);
}
/** A usable process or group id. Never 0 or 1: kill(0) and kill(-1) reach far more than one run. */
function processId(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 1 ? value : undefined;
}
function exists(id: number): boolean {
  try {
    process.kill(id, 0);
    return true;
  } catch (err) {
    // Only ESRCH confirms absence. An inaccessible process or group still holds the slot.
    return (err as NodeJS.ErrnoException).code !== "ESRCH";
  }
}
/** `ps` reports start times to the second; the launch is recorded right after spawn. */
const LAUNCH_TOLERANCE_MS = 10_000;

/** When a process started, from `ps` (macOS and Linux), or undefined if unknown. */
function processStartedAt(pid: number): number | undefined {
  try {
    const out = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
      env: { ...process.env, LC_ALL: "C" },
      timeout: 2000,
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
    const at = Date.parse(out);
    return Number.isFinite(at) ? at : undefined;
  } catch {
    return undefined;
  }
}

function signalGroup(pgid: number, signal: NodeJS.Signals) {
  try {
    process.kill(-pgid, signal);
  } catch {
    /* already gone */
  }
}
function inode(root: string) {
  const st = fs.statSync(root, { bigint: true });
  if (!st.isDirectory()) throw new FleetError(400, "directory_required");
  return st.dev + ":" + st.ino;
}

export class FleetHostService {
  private readonly db: DatabaseSync;
  private readonly epoch = crypto.randomUUID();
  private readonly sessions = new Map<string, ClaudeSession>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly turns = new Map<string, number>();
  private closing = false;
  private closed = false;
  private drained!: () => void;
  private readonly stopped = new Promise<void>((resolve) => (this.drained = resolve));
  private readonly exists: (id: number) => boolean;
  private readonly startedAt: (pid: number) => number | undefined;
  private readonly stopGraceMs: number;
  /** Settles once agents left running by an earlier backend have been dealt with. */
  readonly recovered: Promise<void>;
  constructor(
    private readonly home: string,
    private readonly runner: ClaudeRunner,
    options: FleetHostOptions = {},
  ) {
    this.exists = options.exists ?? exists;
    this.startedAt = options.startedAt ?? processStartedAt;
    this.stopGraceMs = options.stopGraceMs ?? 1500;
    const dir = path.join(home, "fleet");
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path.join(dir, "runs.sqlite"));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=3000;
      CREATE TABLE IF NOT EXISTS workspaces(id TEXT PRIMARY KEY,name TEXT,root TEXT UNIQUE,inode TEXT);
      CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY,host TEXT,device TEXT,workspace TEXT,epoch TEXT,state TEXT,result TEXT,pending TEXT,created INTEGER,pgid INTEGER,started INTEGER,backend INTEGER);
      CREATE TABLE IF NOT EXISTS ops(host TEXT,device TEXT,id TEXT,hash TEXT,run TEXT,action TEXT,at INTEGER,status TEXT,PRIMARY KEY(host,device,id));
      CREATE TABLE IF NOT EXISTS events(run TEXT NOT NULL,seq INTEGER NOT NULL,at INTEGER NOT NULL,type TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(run,seq)) WITHOUT ROWID;`);
    // A ledger from before process tracking gains the columns. Its runs record no
    // process group, so after a restart they still wait for the owner to check.
    const columns = new Set(
      this.db
        .prepare("PRAGMA table_info(runs)")
        .all()
        .map((c) => String(c.name)),
    );
    for (const column of ["pgid", "started", "backend"])
      if (!columns.has(column)) this.db.exec(`ALTER TABLE runs ADD COLUMN ${column} INTEGER`);
    const live: Orphan[] = [];
    this.tx(() => {
      // A run recorded before the timeline existed starts from its verifiable state.
      for (const r of this.db
        .prepare("SELECT id,state FROM runs WHERE id NOT IN (SELECT run FROM events)")
        .all())
        this.record(String(r.id), "history_started", { state: r.state });
      // An earlier backend owned these processes. Say so once and never relaunch.
      for (const r of this.db
        .prepare(`SELECT id,pgid,started,backend FROM runs WHERE epoch!=? AND state IN ${ACTIVE}`)
        .all(this.epoch)) {
        const id = String(r.id);
        const last = this.db
          .prepare("SELECT type FROM events WHERE run=? ORDER BY seq DESC LIMIT 1")
          .get(id);
        if (last?.type !== "outcome_unknown") this.record(id, "outcome_unknown");
        // The agent's slot is freed only when this backend can tell what became of it.
        // Without a recorded group, or while another live backend on this ledger owns
        // the run, the owner checks the machine instead (ownerStop).
        const pgid = processId(r.pgid),
          backend = processId(r.backend);
        if (!pgid || typeof r.started !== "number") continue;
        if (backend && backend !== process.pid && this.exists(backend)) continue;
        const orphan = { id, pgid, started: r.started };
        if (!this.groupAlive(orphan)) this.releaseOrphan(id, "exited");
        else if (this.launchedAsRecorded(orphan)) live.push(orphan);
        // Otherwise the group id now belongs to something started at another
        // time: ids are reused within a boot. It is not ours to signal, so the
        // owner checks the machine instead, as before (ownerStop).
      }
    });
    this.recovered = Promise.all(live.map((o) => this.stopOrphan(o))).then(() => undefined);
  }
  /**
   * Whether the group's leader is the agent this ledger launched: it started
   * within a few seconds of the recorded launch. Checked before any signal, so
   * a reused id never gets an unrelated process group killed.
   */
  private launchedAsRecorded(o: Orphan) {
    const at = this.startedAt(o.pgid);
    return at !== undefined && Math.abs(at - o.started) <= LAUNCH_TOLERANCE_MS;
  }
  /** Whether the agent's process group survives. A reboot since its launch means it cannot. */
  private groupAlive(o: Orphan) {
    return Date.now() - os.uptime() * 1000 < o.started && this.exists(-o.pgid);
  }
  private async stopOrphan(o: Orphan) {
    const gone = async (ms: number) => {
      const end = Date.now() + ms;
      while (this.groupAlive(o)) {
        if (Date.now() >= end) return false;
        await wait(50);
      }
      return true;
    };
    signalGroup(o.pgid, "SIGTERM");
    if (!(await gone(this.stopGraceMs))) {
      signalGroup(o.pgid, "SIGKILL");
      if (!(await gone(1000))) return; // Keep the slot for the owner to verify.
    }
    // Nobody awaits this in production, so it must not reject. If the ledger is
    // closed or busy, the next backend finds the group gone and frees the slot.
    try {
      if (!this.closed) this.tx(() => this.releaseOrphan(o.id, "stopped"));
    } catch {
      /* retried on the next start */
    }
  }
  /** Free the slot of a run whose agent outlived its backend. The outcome stays unknown. */
  private releaseOrphan(id: string, how: "exited" | "stopped") {
    // The owner may have released it in the meantime.
    if (!this.db.prepare(`SELECT 1 FROM runs WHERE id=? AND state IN ${ACTIVE}`).get(id)) return;
    this.closePending(id, "cancelled");
    this.db.prepare("UPDATE runs SET state='unknown',pending=NULL WHERE id=?").run(id);
    this.record(id, "orphan_released", { process: how });
  }
  /** A state change and the timeline entry describing it commit together. */
  private tx<T>(fn: () => T): T {
    if (this.db.isTransaction) return fn();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const value = fn();
      this.db.exec("COMMIT");
      return value;
    } catch (err) {
      if (this.db.isTransaction) this.db.exec("ROLLBACK");
      throw err;
    }
  }
  /** Append inside the caller's transaction. Sequence numbers are dense per run. */
  private record(run: string, type: EventType, data: Record<string, unknown> = {}) {
    const seq =
      Number(this.db.prepare("SELECT MAX(seq) AS n FROM events WHERE run=?").get(run)?.n ?? 0) + 1;
    this.db
      .prepare("INSERT INTO events VALUES(?,?,?,?,?)")
      .run(run, seq, Date.now(), type, JSON.stringify(data));
    if (seq > MAX_EVENTS)
      this.db.prepare("DELETE FROM events WHERE run=? AND seq<=?").run(run, seq - MAX_EVENTS);
  }
  /** A request that is still open when its run stops was never answered. */
  private closePending(run: string, outcome: ApprovalOutcome | "cancelled") {
    const pending = this.db.prepare("SELECT pending FROM runs WHERE id=?").get(run)?.pending;
    if (typeof pending === "string")
      this.record(run, "approval_resolved", {
        turn: this.turns.get(run) ?? 0,
        approvalId: (JSON.parse(pending) as Approval).id,
        outcome,
      });
  }
  workspaces(): Workspace[] {
    return this.db
      .prepare("SELECT * FROM workspaces ORDER BY name")
      .all() as unknown as Workspace[];
  }
  register(name: unknown, directory: unknown) {
    const value = requiredText(directory, 2048);
    if (!path.isAbsolute(value)) throw new FleetError(400, "absolute_directory_required");
    let root: string;
    try {
      // The native call also returns each component's on-disk spelling.
      root = fs.realpathSync.native(value);
    } catch {
      throw new FleetError(400, "directory_unavailable");
    }
    const label = requiredText(name, 64).trim();
    const userHome = fs.realpathSync.native(os.homedir());
    const protectedHome = fs.realpathSync.native(this.home);
    // Exclude system roots, home itself, dot directories, and any overlap with the control plane.
    if (
      root.split("/").filter(Boolean).length < 3 ||
      root.split("/").some((s) => s.startsWith(".")) ||
      within(root, userHome) ||
      within(root, protectedHome) ||
      within(protectedHome, root) ||
      ["/System", "/Library", "/usr", "/bin", "/sbin", "/etc", "/private/etc", "/opt"].some((p) =>
        within(p, root),
      )
    )
      throw new FleetError(400, "choose_project_directory");
    const workspaces = this.workspaces();
    const existing = workspaces.find((w) => fold(w.root) === fold(root));
    const token = inode(root);
    if (existing && existing.inode !== token) throw new FleetError(409, "workspace_replaced");
    if (
      !existing &&
      (workspaces.length >= 32 ||
        workspaces.some((w) => within(root, w.root) || within(w.root, root)))
    )
      throw new FleetError(409, "workspace_overlap_or_limit");
    const id = existing?.id ?? crypto.randomUUID();
    this.db
      .prepare(
        "INSERT INTO workspaces VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name",
      )
      .run(id, label, root, token);
    return { id, name: label };
  }
  private getRun(peer: FleetPeer, id: string): RunRow {
    const r = this.db
      .prepare("SELECT * FROM runs WHERE id=? AND host=? AND device=?")
      .get(id, peer.hostId, peer.deviceId) as unknown as RunRow | undefined;
    if (!r || !peer.workspaces.includes(r.workspace)) throw new FleetError(404, "run_not_found");
    return r;
  }
  private view(r: RunRow) {
    const unknown =
      r.epoch !== this.epoch && ["running", "waiting", "approval", "cancelling"].includes(r.state);
    const tip = this.db
      .prepare("SELECT seq,at FROM events WHERE run=? ORDER BY seq DESC LIMIT 1")
      .get(r.id);
    return {
      id: r.id,
      workspaceId: r.workspace,
      hostId: r.host,
      state: unknown ? "unknown" : r.state,
      result: r.result,
      approval: !unknown && r.pending ? (JSON.parse(r.pending) as Approval) : null,
      createdAt: r.created,
      updatedAt: Number(tip?.at ?? r.created),
      lastSeq: Number(tip?.seq ?? 0),
    };
  }
  /** One read returns the current run and the entries after the caller's cursor. */
  private timeline(peer: FleetPeer, id: string, query: URLSearchParams) {
    const run = this.getRun(peer, id);
    const span = this.db
      .prepare("SELECT MIN(seq) AS first,MAX(seq) AS last FROM events WHERE run=?")
      .get(id);
    const firstSeq = Number(span?.first ?? 0),
      lastSeq = Number(span?.last ?? 0),
      asked = Math.max(0, Math.trunc(Number(query.get("after"))) || 0),
      // A cursor ahead of this ledger belongs to a different history. Start over.
      reset = asked > lastSeq,
      after = reset ? 0 : asked,
      limit = Math.min(Math.max(Math.trunc(Number(query.get("limit"))) || MAX_PAGE, 1), MAX_PAGE);
    const events = this.db
      .prepare("SELECT seq,at,type,data FROM events WHERE run=? AND seq>? ORDER BY seq LIMIT ?")
      .all(id, after, limit)
      .map((e) => ({
        ...(JSON.parse(String(e.data)) as Record<string, unknown>),
        seq: Number(e.seq),
        at: Number(e.at),
        type: String(e.type),
      }));
    return {
      run: this.view(run),
      events,
      firstSeq,
      lastSeq,
      // Entries between the cursor and the oldest retained one were dropped.
      gap: after < firstSeq - 1,
      reset,
      more: (events.at(-1)?.seq ?? lastSeq) < lastSeq,
    };
  }
  read(peer: FleetPeer, route: string): unknown {
    if (route === HOST_API + "/capabilities")
      return {
        version: 1,
        features: ["run-events"],
        hostId: peer.hostId,
        instanceId: this.epoch,
        control: peer.control,
        unavailable: this.runner.reason(),
        workspaces: this.workspaces()
          .filter((w) => peer.workspaces.includes(w.id))
          .map(({ id, name }) => ({ id, name })),
      };
    if (route === HOST_API + "/runs") {
      const all = this.db
        .prepare("SELECT * FROM runs WHERE host=? AND device=? ORDER BY created DESC LIMIT 20")
        .all(peer.hostId, peer.deviceId) as unknown as RunRow[];
      return {
        runs: all.filter((r) => peer.workspaces.includes(r.workspace)).map((r) => this.view(r)),
      };
    }
    const [pathname = "", query = ""] = route.split("?");
    if (pathname.endsWith("/events"))
      return this.timeline(peer, uuid(pathname.split("/").at(-2)), new URLSearchParams(query));
    const id = uuid(route.split("/").at(-1));
    if (route === HOST_API + "/operations/" + id) {
      const row = this.db
        .prepare("SELECT run, status FROM ops WHERE host=? AND device=? AND id=?")
        .get(peer.hostId, peer.deviceId, id);
      if (!row) throw new FleetError(404, "operation_not_found");
      const run = this.getRun(peer, String(row.run));
      return { operationId: id, status: row.status, run: this.view(run) };
    }
    return { run: this.view(this.getRun(peer, id)) };
  }
  mutate(peer: FleetPeer, route: string, body: Body): unknown {
    const op = uuid(body.operationId);
    const workspaceId = uuid(body.workspaceId);
    if (body.hostId !== peer.hostId || !peer.control || !peer.workspaces.includes(workspaceId))
      throw new FleetError(403, "control_denied");
    const start = route === HOST_API + "/runs";
    const action = start ? "start" : route.split("/").at(-1)!;
    const runId = start ? op : uuid(route.split("/").at(-2));
    let text: string | undefined, approvalId: string | undefined;
    if (action === "start" || action === "messages") text = requiredText(body.text, 16000);
    if (action === "decisions") {
      approvalId = uuid(body.approvalId);
      if (typeof body.allow !== "boolean") throw new FleetError(400, "boolean_decision_required");
    }
    const hash = digest(JSON.stringify([route, workspaceId, text, approvalId, body.allow]));
    const workspace = this.workspaces().find((w) => w.id === workspaceId);
    if (!workspace) throw new FleetError(404, "workspace_not_found");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.db
        .prepare("SELECT hash FROM ops WHERE host=? AND device=? AND id=?")
        .get(peer.hostId, peer.deviceId, op);
      if (existing) {
        if (existing.hash !== hash) throw new FleetError(409, "operation_conflict");
        this.db.exec("COMMIT");
        return this.read(peer, HOST_API + "/operations/" + op);
      }
      if (action !== "cancel") {
        let valid = false;
        try {
          valid =
            fs.realpathSync.native(workspace.root) === workspace.root &&
            inode(workspace.root) === workspace.inode;
        } catch {
          /* moved */
        }
        if (!valid) throw new FleetError(409, "workspace_replaced");
      }
      if (start) {
        const reason = this.runner.reason();
        if (reason) throw new FleetError(503, reason);
        if (
          this.sessions.size ||
          this.db
            .prepare(
              "SELECT 1 FROM runs WHERE state IN ('running','waiting','approval','cancelling') LIMIT 1",
            )
            .get()
        )
          throw new FleetError(409, "host_busy");
        this.db
          .prepare(
            "INSERT INTO runs(id,host,device,workspace,epoch,state,result,pending,created,backend) VALUES(?,?,?,?,?,'running','',NULL,?,?)",
          )
          .run(runId, peer.hostId, peer.deviceId, workspaceId, this.epoch, Date.now(), process.pid);
        this.record(runId, "turn_started", { turn: 1, prompt: text!.slice(0, PROMPT_EXCERPT) });
      } else {
        const r = this.getRun(peer, runId);
        if (r.workspace !== workspaceId || !this.sessions.has(runId))
          throw new FleetError(409, "run_not_active");
        if (r.state === "cancelling") throw new FleetError(409, "run_stopping");
        if (action === "messages" && r.state !== "waiting")
          throw new FleetError(409, "turn_in_progress");
        if (
          action === "decisions" &&
          (r.state !== "approval" || !r.pending || JSON.parse(r.pending).id !== approvalId)
        )
          throw new FleetError(409, "stale_approval");
      }
      if (
        action !== "cancel" &&
        Number(this.db.prepare("SELECT COUNT(*) AS n FROM ops").get()?.n) >= 50000
      )
        throw new FleetError(507, "receipt_capacity");
      this.db
        .prepare("INSERT INTO ops VALUES(?,?,?,?,?,?,?,'unknown')")
        .run(peer.hostId, peer.deviceId, op, hash, runId, action, Date.now());
      this.db.exec("COMMIT");
    } catch (err) {
      if (this.db.isTransaction) this.db.exec("ROLLBACK");
      throw err;
    }

    // Never repeat an external side effect after this point. A crash leaves an
    // unknown receipt, durably paired with the original run and payload hash.
    try {
      if (start) {
        let blocked = 0;
        this.turns.set(runId, 1);
        const turn = () => this.turns.get(runId) ?? 0;
        const launched = Date.now();
        const session = this.runner.start(workspace.root, {
          approval: (a, closed) =>
            this.tx(() => {
              const applied = this.db
                .prepare("UPDATE runs SET pending=?,state=? WHERE id=? AND state!='cancelling'")
                .run(a ? JSON.stringify(a) : null, a ? "approval" : "running", runId).changes;
              if (!applied) return;
              // The card shows the tool and its target. Full input stays on the run view.
              if (a)
                this.record(runId, "approval_requested", {
                  turn: turn(),
                  approvalId: a.id,
                  tool: a.tool,
                  target: target(workspace.root, a.input.file_path),
                  expiresAt: a.expiresAt,
                });
              else if (closed)
                this.record(runId, "approval_resolved", {
                  turn: turn(),
                  approvalId: closed.id,
                  outcome: closed.outcome,
                });
            }),
          blocked: (tool, file) => {
            if (++blocked <= MAX_BLOCKED_PER_TURN)
              this.tx(() =>
                this.record(runId, "tool_blocked", {
                  turn: turn(),
                  tool,
                  target: target(workspace.root, file),
                }),
              );
          },
          result: (value, error) => {
            this.tx(() => {
              this.closePending(runId, "withdrawn");
              const applied = this.db
                .prepare(
                  "UPDATE runs SET result=?,state=?,pending=NULL WHERE id=? AND state!='cancelling'",
                )
                .run(value, error ? "failed" : "waiting", runId).changes;
              if (applied)
                this.record(runId, error ? "turn_failed" : "turn_completed", {
                  turn: turn(),
                  result: value.slice(-RESULT_EXCERPT),
                  ...(value.length > RESULT_EXCERPT ? { truncated: true } : {}),
                  ...(blocked ? { blocked } : {}),
                });
            });
            blocked = 0;
            if (error) this.sessions.get(runId)?.cancel();
          },
          exit: (err) => {
            this.sessions.delete(runId);
            clearTimeout(this.timers.get(runId));
            this.timers.delete(runId);
            this.tx(() => {
              this.closePending(runId, "cancelled");
              this.db
                .prepare(
                  `UPDATE runs SET pending=NULL,state=CASE WHEN state='cancelling' THEN 'cancelled' WHEN state='waiting' AND ?='' THEN 'completed' ELSE 'failed' END,
              result=CASE WHEN result='' THEN ? ELSE result END WHERE id=?`,
                )
                .run(err, err || "claude_closed", runId);
              const state = this.db.prepare("SELECT state FROM runs WHERE id=?").get(runId)?.state;
              // A stopped process exits non-zero. Only a failure needs its cause.
              this.record(runId, "run_ended", {
                state,
                ...(state === "failed" ? { reason: err || "claude_closed" } : {}),
              });
            });
            this.turns.delete(runId);
            this.finishShutdown();
          },
        });
        this.sessions.set(runId, session);
        // A later backend uses this to stop or release the agent if this one dies first.
        const pgid = processId(session.pid);
        if (pgid)
          this.db.prepare("UPDATE runs SET pgid=?,started=? WHERE id=?").run(pgid, launched, runId);
        const timer = setTimeout(() => this.stopRun(runId, "timeout"), 60 * 60_000);
        timer.unref();
        this.timers.set(runId, timer);
        session.send(text!);
      } else if (action === "messages") {
        this.sessions.get(runId)!.send(text!);
        const next = (this.turns.get(runId) ?? 0) + 1;
        this.turns.set(runId, next);
        this.tx(() => {
          this.db.prepare("UPDATE runs SET state='running' WHERE id=?").run(runId);
          this.record(runId, "turn_started", {
            turn: next,
            prompt: text!.slice(0, PROMPT_EXCERPT),
          });
        });
      } else if (action === "decisions")
        this.sessions.get(runId)!.decide(approvalId!, body.allow === true);
      else if (action === "cancel") this.stopRun(runId, "controller");
      else throw new FleetError(400, "unknown_action");
      this.db
        .prepare("UPDATE ops SET status='accepted' WHERE host=? AND device=? AND id=?")
        .run(peer.hostId, peer.deviceId, op);
    } catch (err) {
      if (start) {
        // With a process, its exit closes the run. Without one, nothing else will.
        const session = this.sessions.get(runId);
        this.tx(() => {
          this.db
            .prepare("UPDATE runs SET state='failed',result='claude_launch_failed' WHERE id=?")
            .run(runId);
          if (session)
            this.record(runId, "turn_failed", { turn: 1, result: "claude_launch_failed" });
          else this.record(runId, "run_ended", { state: "failed", reason: "claude_launch_failed" });
        });
        if (!session) this.turns.delete(runId);
        else session.cancel();
      }
      throw err;
    }
    return this.read(peer, HOST_API + "/operations/" + op);
  }
  /**
   * The owner revoked a device, narrowed its workspaces or took away control. Its
   * agents outside what it may still control stop now, instead of running on
   * where the device can no longer see or cancel them.
   */
  enforceGrant(deviceId: string, grant: FleetGrant | undefined) {
    for (const id of [...this.sessions.keys()]) {
      const r = this.db.prepare("SELECT device,workspace FROM runs WHERE id=?").get(id);
      if (r?.device !== deviceId) continue;
      if (!grant?.control || !grant.workspaces.includes(String(r.workspace)))
        this.stopRun(id, "revoked");
    }
  }
  /** Remote control was switched off on this Mac. No remote agent keeps running. */
  stopRemoteRuns() {
    for (const id of [...this.sessions.keys()]) this.stopRun(id, "policy");
  }
  private stopRun(
    id: string,
    by: "controller" | "owner" | "timeout" | "shutdown" | "revoked" | "policy",
  ) {
    this.tx(() => {
      this.closePending(id, "cancelled");
      const applied = this.db
        .prepare(
          "UPDATE runs SET state='cancelling',pending=NULL WHERE id=? AND state!='cancelling'",
        )
        .run(id).changes;
      if (applied) this.record(id, "cancel_requested", { by });
    });
    this.sessions.get(id)?.cancel();
  }
  ownerRuns() {
    const rows = this.db
      .prepare(`SELECT * FROM runs WHERE state IN ${ACTIVE} ORDER BY created`)
      .all() as unknown as RunRow[];
    return rows.map((r) => ({ id: r.id, workspaceId: r.workspace, state: this.view(r).state }));
  }
  ownerStop(id: string, confirmed: boolean) {
    if (this.sessions.has(id)) this.stopRun(id, "owner");
    else if (confirmed) {
      // The local owner checked the machine after an unclean backend shutdown.
      // Preserve the uncertain outcome and its receipt while releasing the slot.
      const released = this.tx(() => {
        const orphan = this.db
          .prepare(`SELECT 1 FROM runs WHERE id=? AND epoch!=? AND state IN ${ACTIVE}`)
          .get(id, this.epoch);
        if (!orphan) return false;
        this.closePending(id, "cancelled");
        this.db.prepare("UPDATE runs SET state='unknown',pending=NULL WHERE id=?").run(id);
        this.record(id, "owner_released");
        return true;
      });
      if (!released) throw new FleetError(409, "run_not_unknown");
    } else throw new FleetError(409, "verify_previous_process_exited");
    return { ok: true };
  }
  private finishShutdown() {
    if (this.closing && !this.closed && !this.sessions.size) {
      this.closed = true;
      this.db.close();
      this.drained();
    }
  }
  /** Stop every agent. Settles once their processes have exited and the ledger is closed. */
  shutdown(): Promise<void> {
    this.closing = true;
    for (const id of this.sessions.keys()) this.stopRun(id, "shutdown");
    this.finishShutdown();
    return this.stopped;
  }
}

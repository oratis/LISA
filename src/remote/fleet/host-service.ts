import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { type Approval, type ClaudeRunner, type ClaudeSession } from "./claude.js";
import { digest, FleetError, HOST_API, requiredText, uuid, type FleetPeer } from "./types.js";

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
}
type Body = Record<string, unknown>;
function inside(parent: string, entry: string) {
  return entry === parent || entry.startsWith(parent.endsWith("/") ? parent : parent + "/");
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
  private closing = false;
  private closed = false;
  constructor(
    private readonly home: string,
    private readonly runner: ClaudeRunner,
  ) {
    const dir = path.join(home, "fleet");
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path.join(dir, "runs.sqlite"));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=3000;
      CREATE TABLE IF NOT EXISTS workspaces(id TEXT PRIMARY KEY,name TEXT,root TEXT UNIQUE,inode TEXT);
      CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY,host TEXT,device TEXT,workspace TEXT,epoch TEXT,state TEXT,result TEXT,pending TEXT,created INTEGER);
      CREATE TABLE IF NOT EXISTS ops(host TEXT,device TEXT,id TEXT,hash TEXT,run TEXT,action TEXT,at INTEGER,status TEXT,PRIMARY KEY(host,device,id));`);
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
      root = fs.realpathSync(value);
    } catch {
      throw new FleetError(400, "directory_unavailable");
    }
    const label = requiredText(name, 64).trim();
    const userHome = fs.realpathSync(os.homedir());
    const protectedHome = fs.realpathSync(this.home);
    // Exclude system roots, home itself, dot directories, and any overlap with the control plane.
    if (
      root.split("/").filter(Boolean).length < 3 ||
      root.split("/").some((s) => s.startsWith(".")) ||
      inside(root, userHome) ||
      inside(root, protectedHome) ||
      inside(protectedHome, root) ||
      ["/System", "/Library", "/usr", "/bin", "/sbin", "/etc", "/private/etc", "/opt"].some((p) =>
        inside(p, root),
      )
    )
      throw new FleetError(400, "choose_project_directory");
    const workspaces = this.workspaces();
    const existing = workspaces.find((w) => w.root === root);
    const token = inode(root);
    if (existing && existing.inode !== token) throw new FleetError(409, "workspace_replaced");
    if (
      !existing &&
      (workspaces.length >= 32 ||
        workspaces.some((w) => inside(root, w.root) || inside(w.root, root)))
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
    return {
      id: r.id,
      workspaceId: r.workspace,
      hostId: r.host,
      state: unknown ? "unknown" : r.state,
      result: r.result,
      approval: !unknown && r.pending ? (JSON.parse(r.pending) as Approval) : null,
      createdAt: r.created,
    };
  }
  read(peer: FleetPeer, route: string): unknown {
    if (route === HOST_API + "/capabilities")
      return {
        version: 1,
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
            fs.realpathSync(workspace.root) === workspace.root &&
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
          .prepare("INSERT INTO runs VALUES(?,?,?,?,?,'running','',NULL,?)")
          .run(runId, peer.hostId, peer.deviceId, workspaceId, this.epoch, Date.now());
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
        const session = this.runner.start(workspace.root, {
          approval: (a) =>
            this.db
              .prepare("UPDATE runs SET pending=?,state=? WHERE id=? AND state!='cancelling'")
              .run(a ? JSON.stringify(a) : null, a ? "approval" : "running", runId),
          result: (value, error) => {
            this.db
              .prepare(
                "UPDATE runs SET result=?,state=?,pending=NULL WHERE id=? AND state!='cancelling'",
              )
              .run(value, error ? "failed" : "waiting", runId);
            if (error) this.sessions.get(runId)?.cancel();
          },
          exit: (err) => {
            this.sessions.delete(runId);
            clearTimeout(this.timers.get(runId));
            this.timers.delete(runId);
            this.db
              .prepare(
                `UPDATE runs SET pending=NULL,state=CASE WHEN state='cancelling' THEN 'cancelled' WHEN state='waiting' AND ?='' THEN 'completed' ELSE 'failed' END,
              result=CASE WHEN result='' THEN ? ELSE result END WHERE id=?`,
              )
              .run(err, err || "claude_closed", runId);
            this.finishShutdown();
          },
        });
        this.sessions.set(runId, session);
        const timer = setTimeout(() => this.stopRun(runId), 60 * 60_000);
        timer.unref();
        this.timers.set(runId, timer);
        session.send(text!);
      } else if (action === "messages") {
        this.sessions.get(runId)!.send(text!);
        this.db.prepare("UPDATE runs SET state='running' WHERE id=?").run(runId);
      } else if (action === "decisions")
        this.sessions.get(runId)!.decide(approvalId!, body.allow === true);
      else if (action === "cancel") this.stopRun(runId);
      else throw new FleetError(400, "unknown_action");
      this.db
        .prepare("UPDATE ops SET status='accepted' WHERE host=? AND device=? AND id=?")
        .run(peer.hostId, peer.deviceId, op);
    } catch (err) {
      if (start) {
        this.sessions.get(runId)?.cancel();
        this.db
          .prepare("UPDATE runs SET state='failed',result='claude_launch_failed' WHERE id=?")
          .run(runId);
      }
      throw err;
    }
    return this.read(peer, HOST_API + "/operations/" + op);
  }
  private stopRun(id: string) {
    this.db.prepare("UPDATE runs SET state='cancelling',pending=NULL WHERE id=?").run(id);
    this.sessions.get(id)?.cancel();
  }
  ownerRuns() {
    const rows = this.db
      .prepare(
        "SELECT * FROM runs WHERE state IN ('running','waiting','approval','cancelling') ORDER BY created",
      )
      .all() as unknown as RunRow[];
    return rows.map((r) => ({ id: r.id, workspaceId: r.workspace, state: this.view(r).state }));
  }
  ownerStop(id: string, confirmed: boolean) {
    if (this.sessions.has(id)) this.stopRun(id);
    else if (confirmed) {
      // The local owner checked the machine after an unclean backend shutdown.
      // Preserve the uncertain outcome and its receipt while releasing the slot.
      const updated = this.db
        .prepare(
          "UPDATE runs SET state='unknown',pending=NULL WHERE id=? AND epoch!=? AND state IN ('running','waiting','approval','cancelling')",
        )
        .run(id, this.epoch);
      if (!updated.changes) throw new FleetError(409, "run_not_unknown");
    } else throw new FleetError(409, "verify_previous_process_exited");
    return { ok: true };
  }
  private finishShutdown() {
    if (this.closing && !this.closed && !this.sessions.size) {
      this.closed = true;
      this.db.close();
    }
  }
  shutdown() {
    this.closing = true;
    for (const id of this.sessions.keys()) this.stopRun(id);
    this.finishShutdown();
  }
}

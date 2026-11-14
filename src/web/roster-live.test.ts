/**
 * Live roster + PTY attach contracts on the REAL web server (#490):
 *  - an `agent_session_update` SSE row is serialized exactly like the REST
 *    roster row for the same session (Pocket replaces its row with it);
 *  - attaching to a PTY agent that already exited gets the snapshot, the
 *    normal end frame, and a closed stream — not pings forever.
 *
 * Own file because it pins the agent sources through LISA_HOME/agents.json
 * before the server module loads: only a fake roster source (no observer
 * touches the real ~/.claude or ~/.codex).
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { AgentSession } from "../integrations/types.js";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lisa-roster-live-"));
process.env.LISA_HOME = TMP;
process.env.CLAUDE_HOME = path.join(TMP, "claude");
process.env.LISA_SOUL_GIT = "0";
process.env.LISA_MAIL_POLL_MINUTES = "0";
process.env.LISA_LOG_FORMAT = "text";
process.env.LISA_PTY_AGENTS = "1";
for (const k of [
  "LISA_EDITION",
  "LISA_WEB_TOKEN",
  "LISA_LOG_FILE",
  "K_SERVICE",
  "LISA_MODEL_FALLBACK",
  "LISA_MANAGED_SESSION",
  "LISA_BASE_URL",
  "LISA_PROVIDER",
]) {
  delete process.env[k];
}
fs.writeFileSync(
  path.join(TMP, "agents.json"),
  JSON.stringify({
    integrations: { "claude-code": { enabled: false }, "test-roster": { enabled: true } },
  }),
);

// An observe-only claude row carrying the server-internal jsonlPath — the two
// fields the old SSE row got wrong (leaked jsonlPath, dropped resumable).
const row: AgentSession = {
  agent: "claude-code",
  sessionId: "roster-live-test-session",
  project: "proj",
  cwd: "/work/proj",
  state: "waiting",
  stateReason: "end_turn",
  lastMtime: Date.parse("2026-11-13T10:00:00.000Z"),
  jsonlPath: path.join(TMP, "claude", "projects", "proj", "roster-live-test-session.jsonl"),
};
let emitRow: ((s: AgentSession) => void) | null = null;
const { registerIntegration } = await import("../integrations/registry.js");
registerIntegration("test-roster", () => ({
  agent: "test-roster",
  async start(emit) {
    emitRow = emit;
  },
  list: () => [row],
  async stop() {},
}));

const { startWebServer } = await import("./server.js");
const { ptyRegistry } = await import("../agents/pty.js");
type PtyModuleLike = import("../agents/pty.js").PtyModuleLike;

const server = await startWebServer({
  port: 0,
  host: "127.0.0.1",
  tools: [],
  model: "claude-sonnet-4-6",
  thinking: false,
  reflect: true,
  idleMinutes: 0,
  hooks: [],
});
const port = (server.address() as AddressInfo).port;

after(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  fs.rmSync(TMP, { recursive: true, force: true });
});

function get(urlPath: string): Promise<{ status: number; type: string; text: string }> {
  return new Promise((resolve, reject) => {
    http
      .get({ host: "127.0.0.1", port, path: urlPath, agent: false }, (res) => {
        let text = "";
        res.on("data", (c: Buffer) => (text += c.toString("utf8")));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, type: res.headers["content-type"] ?? "", text }),
        );
      })
      .on("error", reject);
  });
}

/** `data:` JSON frames of an SSE body (comments such as `: ping` dropped). */
function frames(body: string): Array<Record<string, unknown>> {
  return body
    .split("\n\n")
    .map((f) =>
      f
        .split("\n")
        .filter((l) => l.startsWith("data: "))
        .map((l) => l.slice(6))
        .join("\n"),
    )
    .filter(Boolean)
    .map((d) => JSON.parse(d) as Record<string, unknown>);
}

/**
 * Read an SSE stream until `done(frames)` holds, or until the server closes
 * it. Rejects after `ms` — a stream that never ends is exactly the bug.
 */
function readSse(
  urlPath: string,
  done: (fs: Array<Record<string, unknown>>) => boolean,
  ms = 3000,
  onOpen: () => void = () => {},
): Promise<{ frames: Array<Record<string, unknown>>; closedByServer: boolean; raw: string }> {
  return new Promise((resolve, reject) => {
    let raw = "";
    const req = http.get({ host: "127.0.0.1", port, path: urlPath, agent: false }, (res) => {
      assert.equal(res.statusCode, 200);
      assert.match(res.headers["content-type"] ?? "", /text\/event-stream/);
      onOpen();
      res.on("data", (c: Buffer) => {
        raw += c.toString("utf8");
        const complete = raw.slice(0, raw.lastIndexOf("\n\n") + 2);
        const parsed = frames(complete);
        if (done(parsed)) {
          clearTimeout(timer);
          req.destroy();
          resolve({ frames: parsed, closedByServer: false, raw });
        }
      });
      res.on("end", () => {
        clearTimeout(timer);
        resolve({ frames: frames(raw), closedByServer: true, raw });
      });
    });
    req.on("error", (e) => {
      if ((e as NodeJS.ErrnoException).code !== "ECONNRESET") reject(e);
    });
    const timer = setTimeout(() => {
      req.destroy();
      reject(new Error(`stream ${urlPath} still open after ${ms}ms:\n${raw}`));
    }, ms);
  });
}

async function until(check: () => boolean, ms = 3000): Promise<void> {
  const t0 = Date.now();
  while (!check()) {
    if (Date.now() - t0 > ms) throw new Error("condition timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** A fake node-pty: drive output/exit by hand. */
function fakePty() {
  let onData: ((d: string) => void) | null = null;
  let onExit: ((e: { exitCode: number }) => void) | null = null;
  const module: PtyModuleLike = {
    spawn: () => ({
      onData: (cb) => (onData = cb),
      onExit: (cb) => (onExit = cb),
      write: () => {},
      kill: () => {},
    }),
  };
  return {
    module,
    emitData: (s: string) => onData?.(s),
    emitExit: (code: number) => onExit?.({ exitCode: code }),
  };
}

test("an agent_session_update SSE row equals the REST roster row for the same session", async () => {
  await until(() => emitRow !== null); // the hub attaches observers in the background
  const update = { ...row, state: "working" as const, stateReason: "tool_use" };
  const sse = readSse(
    "/events",
    (fs) => fs.some((f) => f.type === "agent_session_update" && f.sessionId === row.sessionId),
    3000,
    // Emit once the subscription is open, so the broadcast reaches it.
    () =>
      setTimeout(() => {
        Object.assign(row, update);
        emitRow!(row);
      }, 50),
  );
  const { frames: got } = await sse;
  const event = got.find(
    (f) => f.type === "agent_session_update" && f.sessionId === row.sessionId,
  )!;
  const { type: _type, ...sseRow } = event;

  const rest = await get("/api/agents/sessions");
  assert.equal(rest.status, 200);
  const restRow = (
    JSON.parse(rest.text) as { sessions: Array<{ sessionId: string }> }
  ).sessions.find((s) => s.sessionId === row.sessionId);
  assert.ok(restRow, "the REST roster lists the session");

  assert.deepEqual(sseRow, restRow);
  assert.equal("jsonlPath" in sseRow, false, "the absolute transcript path never reaches the wire");
  assert.equal(sseRow.resumable, true, "an idle observe-only claude row stays adoptable");
  assert.equal(sseRow.lastMtime, "2026-11-13T10:00:00.000Z");
  assert.equal(sseRow.state, "working");
});

test("attaching to a PTY agent that already exited: snapshot, end frame, closed", async () => {
  const f = fakePty();
  const view = await ptyRegistry.start({
    agent: "claude",
    task: "go",
    cwd: TMP,
    cli: "claude",
    ptyModule: f.module,
  });
  f.emitData("all done here");
  f.emitExit(0);
  assert.equal(ptyRegistry.get(view.id)?.view().state, "done");

  const r = await readSse(`/api/agents/pty/${view.id}/stream`, () => false);
  assert.equal(r.closedByServer, true, "the server must close the stream");
  assert.deepEqual(r.frames, [
    { type: "snapshot", text: "all done here" },
    { type: "end", state: "done" },
  ]);
  assert.doesNotMatch(r.raw, /: ping/);
});

test("a live attach ends with the same end frame when the agent exits", async () => {
  const f = fakePty();
  const view = await ptyRegistry.start({
    agent: "codex",
    task: "go",
    cwd: TMP,
    cli: "codex",
    ptyModule: f.module,
  });
  const r = await readSse(
    `/api/agents/pty/${view.id}/stream`,
    () => false,
    3000,
    () =>
      setTimeout(() => {
        f.emitData("working…");
        f.emitExit(0);
      }, 50),
  );
  assert.equal(r.closedByServer, true);
  assert.deepEqual(r.frames, [
    { type: "snapshot", text: "" },
    { type: "chunk", text: "working…" },
    { type: "end", state: "done" },
  ]);
});

test("an unknown PTY id answers a JSON 404 on stream / output", async () => {
  for (const urlPath of ["/api/agents/pty/nope/stream", "/api/agents/pty/nope/output"]) {
    const r = await get(urlPath);
    assert.equal(r.status, 404, urlPath);
    assert.match(r.type, /application\/json/);
    const body = JSON.parse(r.text) as { ok: boolean; error: string; message: string };
    assert.equal(body.ok, false);
    assert.equal(body.error, "unknown_session");
    assert.equal(typeof body.message, "string");
  }
});

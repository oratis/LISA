// Run paired, source-pinned real-model trials. See --help for usage.
import { execFileSync, fork } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { renameSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfigEnv } from "../../../src/env.js";
import type { Observation, Request, Scenario } from "./worker.js";

interface Fixture extends Scenario {
  kind: "correction" | "grounding";
  required: string[];
  stale: string[];
  unsupported: string[];
  unchanged?: boolean;
  rubric: string;
}
type Arm = "left" | "right";
function option(key: string, fallback?: string) {
  const value = process.argv.find((a) => a.startsWith("--" + key + "="))?.slice(key.length + 3);
  if (value) return value;
  if (fallback !== undefined) return fallback;
  throw new Error("Missing --" + key);
}
if (process.argv.includes("--help")) {
  console.log(
    "run.ts --fixtures=FILE --output=NEW.json --left=CHECKOUT --right=CHECKOUT [--model=claude-sonnet-4-6] [--jobs=2] [--cases=id1,id2]",
  );
  process.exit(0);
}
const idPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const fixtureText = await fs.readFile(option("fixtures"), "utf8");
const all: Fixture[] = JSON.parse(fixtureText);
const caseIds = new Set<string>();
for (const f of all) {
  if (
    !idPattern.test(f.id) ||
    caseIds.has(f.id) ||
    !["user", "memory"].includes(f.store) ||
    !["correction", "grounding"].includes(f.kind) ||
    typeof f.before !== "string" ||
    f.sessions.length < 2 ||
    !f.rubric?.trim()
  )
    throw new Error("Invalid scenario");
  caseIds.add(f.id);
  const ids = new Set<string>();
  for (const session of f.sessions) {
    if (
      !idPattern.test(session.id) ||
      ids.has(session.id) ||
      (session.origin !== undefined && !["legacy", "owner", "channel"].includes(session.origin)) ||
      session.turns.length < 2 ||
      session.turns.some(
        (t) => !["user", "assistant"].includes(t.role) || typeof t.content !== "string",
      )
    ) {
      throw new Error("Invalid session in " + f.id);
    }
    ids.add(session.id);
  }
  for (const expression of [...f.required, ...f.stale, ...f.unsupported])
    new RegExp(expression, "im");
}
const selected = option("cases", "").split(",").filter(Boolean);
if (selected.some((id) => !caseIds.has(id))) throw new Error("Unknown --cases value");
const fixtures = all.filter((f) => !selected.length || selected.includes(f.id));
const jobs = Number(option("jobs", "2"));
if (!fixtures.length || fixtures.length > 32 || !Number.isInteger(jobs) || jobs < 1 || jobs > 4)
  throw new Error("Choose 1–32 cases and 1–4 workers");
const roots = { left: path.resolve(option("left")), right: path.resolve(option("right")) };
function sourceCommit(root: string) {
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  const dirty = git(
    "status",
    "--porcelain",
    "--untracked-files=all",
    "--",
    "src",
    "package-lock.json",
    "package.json",
  );
  if (dirty) throw new Error("Commit changes to the measured source before running a trial");
  return git("rev-parse", "HEAD");
}
const commits = { left: sourceCommit(roots.left), right: sourceCommit(roots.right) };
const model = option("model", "claude-sonnet-4-6");
const sessionFormat = option("sessions", "legacy");
if (!["legacy", "native"].includes(sessionFormat)) throw new Error("Invalid --sessions format");
const anchor = Date.now();
const output = path.resolve(option("output"));

function grade(f: Fixture, result: Observation) {
  const combined = result.after.user + "\n" + result.after.memory;
  const matches = (pattern: string, text: string) => new RegExp(pattern, "im").test(text);
  const missing = f.required.filter((p) => !matches(p, result.after[f.store]));
  const stale = f.stale.filter((p) => matches(p, combined));
  const unsupported = f.unsupported.filter((p) => matches(p, combined));
  const unexpectedChange =
    !!f.unchanged &&
    (result.before.user !== result.after.user || result.before.memory !== result.after.memory);
  return {
    passed:
      !result.error && !missing.length && !stale.length && !unsupported.length && !unexpectedChange,
    missing,
    stale,
    unsupported,
    unexpectedChange,
  };
}

const worker = fileURLToPath(new URL("./worker.ts", import.meta.url));
async function measure(request: Request): Promise<Observation> {
  // Set the operator home before any measured module loads or resolves paths.
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "lisa-holdout-"));
  try {
    return await new Promise<Observation>((resolve, reject) => {
      const child = fork(worker, [], {
        execArgv: ["--import", "tsx"],
        env: { ...process.env, LISA_HOME: home, LISA_MODEL_FALLBACK: "" },
        stdio: ["ignore", "ignore", "ignore", "ipc"],
      });
      const timeout = setTimeout(() => child.kill("SIGKILL"), 210_000);
      child.once("error", reject);
      child.once("exit", (code) => {
        clearTimeout(timeout);
        reject(new Error("Worker exited without a trial result (exit " + code + ")"));
      });
      child.on("message", (msg: { result?: Observation; fatal?: string }) => {
        if (msg.result) resolve(msg.result);
        else reject(new Error("Trial setup or capture failed: " + msg.fatal));
      });
      child.send(request);
    });
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
}

// The operator's configured gateway is used only for authentication and routing.
// Transcripts, checkpoints, revisions and fleet recaps are all from fresh homes.
loadConfigEnv();
const rows: (Observation & {
  id: string;
  arm: Arm;
  kind: string;
  store: Scenario["store"];
  grade: ReturnType<typeof grade>;
})[] = [];
const header = {
  fixtureSha256: createHash("sha256").update(fixtureText).digest("hex"),
  commits,
  model,
  startedAt: new Date(anchor).toISOString(),
  selected: fixtures.map((f) => f.id),
  jobs,
  syntheticData: true,
  sessionFormat,
};
const ledger = {
  ...header,
  complete: false,
  results: rows,
  infrastructureFailures: [] as { id: string; arm: Arm; reason: string; usage: null }[],
};
await fs.mkdir(path.dirname(output), { recursive: true });
await fs.writeFile(output, JSON.stringify(ledger, null, 2) + "\n", { flag: "wx" });
function save() {
  const tmp = output + ".pending-" + process.pid;
  writeFileSync(tmp, JSON.stringify(ledger, null, 2) + "\n");
  renameSync(tmp, output);
}
let next = 0;
let stopped = false;
let knownTokens = 0;
async function lane() {
  while (!stopped && next < fixtures.length) {
    const f = fixtures[next++]!;
    const order: Arm[] = all.indexOf(f) % 2 ? ["right", "left"] : ["left", "right"];
    for (const arm of order) {
      if (stopped) return;
      try {
        if (knownTokens >= 300_000) throw new Error("Known-token budget reached");
        const scenario = { id: f.id, store: f.store, before: f.before, sessions: f.sessions };
        const result = await measure({
          root: roots[arm],
          scenario,
          model,
          anchor,
          nativeSessions: sessionFormat === "native",
        });
        const grading = grade(f, result);
        const tokens = result.calls.reduce(
          (sum, c) => sum + Object.values(c.usage ?? {}).reduce((a, b) => a + b, 0),
          0,
        );
        knownTokens += tokens;
        rows.push({ id: f.id, arm, kind: f.kind, store: f.store, ...result, grade: grading });
        console.log(
          JSON.stringify({
            id: f.id,
            arm,
            passed: grading.passed,
            knownTokens: tokens,
            error: result.error,
          }),
        );
        if (result.error && result.error !== "MalformedReflection") stopped = true;
      } catch (error) {
        stopped = true;
        ledger.infrastructureFailures.push({
          id: f.id,
          arm,
          reason: (error as Error).message,
          usage: null,
        });
      }
      save();
    }
  }
}
await Promise.all(Array.from({ length: Math.min(jobs, fixtures.length) }, lane));
ledger.complete = !stopped && rows.length === 2 * fixtures.length;
save();
if (!ledger.complete)
  throw new Error(
    "Incomplete batch; retain its observations and retry the affected cases under a new output name",
  );

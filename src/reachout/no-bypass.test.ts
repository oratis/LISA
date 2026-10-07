/**
 * "Every proactive delivery goes through reachOut(); going around it is a
 * defect" (charter §8). This is a source-level guard for the senders that have
 * been moved behind the gate: a new direct push or a new ungated
 * `idle_message` broadcast fails here instead of shipping.
 *
 * It is deliberately narrow. It covers the notification paths the gate owns
 * today (idle note, advisor digest, mail digest, mail alert, KB brief). Agent
 * done/error/permission pushes and billing alerts are operational events that
 * are not routed through the gate yet — see KNOWN_UNGATED below.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "node_modules" && entry.name !== "assets") sourceFiles(full, out);
    } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      out.push(full);
    }
  }
  return out;
}

const rel = (file: string): string => path.relative(SRC, file).split(path.sep).join("/");

/** PushBridge entry points that carry a proactive message to the user's phone. */
const GATED_PUSH_CALL = /\.(onIdleMessage|onMailDigest|onKbBrief|onMailImportant)\(/;

/**
 * Operational pushes that are NOT behind the gate yet. Listed so the gap is
 * explicit and so adding another one is a conscious edit of this list.
 */
const KNOWN_UNGATED = ["onAgentUpdate", "onBillingAnomaly"];

test("the gated push entry points are only ever called as a reachOut push transport", () => {
  const offenders: string[] = [];
  for (const file of sourceFiles(SRC)) {
    const name = rel(file);
    if (name === "web/push.ts") continue; // the definitions themselves
    const lines = fs.readFileSync(file, "utf8").split("\n");
    lines.forEach((line, i) => {
      if (!GATED_PUSH_CALL.test(line)) return;
      if (line.trim().startsWith("//") || line.trim().startsWith("*")) return;
      const prev = (lines[i - 1] ?? "").trim();
      const asTransport = /push:\s*\(\)\s*=>/.test(line) || /push:\s*\(\)\s*=>$/.test(prev);
      if (!asTransport) offenders.push(`${name}:${i + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(
    offenders,
    [],
    "a proactive push bypasses the reach-out gate — pass it as the `push` transport of reachOut()",
  );
});

test("the server's `idle_message` broadcasts all come from inside the gate", () => {
  const lines = fs.readFileSync(path.join(SRC, "web", "server.ts"), "utf8").split("\n");
  const offenders: string[] = [];
  let seen = 0;
  lines.forEach((line, i) => {
    if (!/type:\s*"idle_message"/.test(line)) return;
    seen++;
    // Inside a gate transport the event carries the ledger id of the decision.
    const window = lines.slice(i, i + 8).join("\n");
    if (!/reachOutId:\s*n\.id/.test(window)) offenders.push(`web/server.ts:${i + 1}`);
  });
  assert.ok(seen >= 5, `expected the five gated senders, found ${seen} idle_message broadcast(s)`);
  assert.deepEqual(offenders, [], "an idle_message is broadcast without going through reachOut()");
});

test("nothing outside the gate's own transport uses PushBridge.notify", () => {
  const offenders: string[] = [];
  for (const file of sourceFiles(SRC)) {
    const name = rel(file);
    if (name === "web/push.ts" || name === "reachout/deliver.ts") continue;
    const text = fs.readFileSync(file, "utf8");
    if (/pushBridge\.notify\(/.test(text)) offenders.push(name);
  }
  assert.deepEqual(offenders, []);
});

test("the ungated operational pushes are exactly the known two", () => {
  const push = fs.readFileSync(path.join(SRC, "web", "push.ts"), "utf8");
  const publicEntryPoints = [...push.matchAll(/^ {2}(on[A-Z]\w+)\(/gm)].map((m) => m[1]!);
  const gated = ["onIdleMessage", "onMailDigest", "onKbBrief", "onMailImportant"];
  assert.deepEqual(
    publicEntryPoints.filter((n) => !gated.includes(n)).sort(),
    [...KNOWN_UNGATED].sort(),
    "a new PushBridge entry point was added — route it through reachOut() or list it as known-ungated",
  );
});

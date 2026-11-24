import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, describe, test } from "node:test";
import { homeScope } from "../paths.js";
import { provenanceTool } from "../tools/provenance.js";
import { handleWardenApi } from "../web/warden-api.js";
import { appendAudit } from "./audit.js";
import { modelProviderFamily, runCrossFamilyReview } from "./cross-family.js";
import { WardenInbox } from "./inbox.js";
import { FileApprovalInboxStore, MemoryApprovalInboxStore } from "./inbox-store.js";
import { resolveChatWorkspaceRoot } from "./paths.js";
import { queryProvenance } from "./provenance.js";
import { createWardenSession } from "./session.js";
import {
  SignedApprovalVerifier,
  registerApprover,
  revokeApprover,
  signApprovalChallenge,
} from "./signed-approval.js";
import type { ActionRequest } from "./types.js";

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "lisa-warden-hardening-")));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

function makeHome(name: string): string {
  const dir = path.join(TMP, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function sampleRequest(overrides: Partial<ActionRequest> = {}): ActionRequest {
  return {
    id: "act_test",
    at: new Date().toISOString(),
    uid: null,
    surface: "local-web",
    origin: { kind: "chat", id: "conv-1" },
    tool: "bash",
    category: "exec",
    targets: ["/tmp/project"],
    dataClasses: [],
    digest: "sha256:abc123",
    preview: "bash(ls)",
    sandboxed: true,
    tainted: false,
    ...overrides,
  };
}

describe("resolveChatWorkspaceRoot", () => {
  test("fails closed on broad workspaces when no safe configured workspace is provided", () => {
    const fakeHome = path.join(TMP, "user-home");
    const fakeLisa = path.join(fakeHome, ".lisa");
    fs.mkdirSync(fakeLisa, { recursive: true });

    const rootRes = resolveChatWorkspaceRoot("/", {
      homeDir: fakeHome,
      lisaHomes: [fakeLisa],
      configuredRoot: "",
    });
    assert.equal(rootRes.confined, false);

    const homeRes = resolveChatWorkspaceRoot(fakeHome, {
      homeDir: fakeHome,
      lisaHomes: [fakeLisa],
      configuredRoot: "",
    });
    assert.equal(homeRes.confined, false);

    // Rejects a configured root inside Lisa's own home.
    const insideLisa = resolveChatWorkspaceRoot("/", {
      homeDir: fakeHome,
      lisaHomes: [fakeLisa],
      configuredRoot: path.join(fakeLisa, "workspace"),
    });
    assert.equal(insideLisa.confined, false);

    // Accepts a dedicated workspace outside Lisa's home.
    const dedicated = path.join(fakeHome, "LisaWorkspace");
    fs.mkdirSync(dedicated, { recursive: true });
    const ok = resolveChatWorkspaceRoot("/", {
      homeDir: fakeHome,
      lisaHomes: [fakeLisa],
      configuredRoot: dedicated,
    });
    assert.equal(ok.confined, true);
    assert.equal(ok.workspaceRoot, fs.realpathSync(dedicated));
  });
});

describe("cross-family review gate", () => {
  test("classifies model provider families deterministically", () => {
    assert.equal(modelProviderFamily("claude-sonnet-4-6"), "anthropic");
    assert.equal(modelProviderFamily("gpt-5.4"), "openai");
    assert.equal(modelProviderFamily("o3-mini"), "openai");
    assert.equal(modelProviderFamily("gemini-3.1-pro-preview"), "google");
    assert.equal(modelProviderFamily("deepseek-reasoner"), "deepseek");
    assert.equal(modelProviderFamily("custom-local-llm"), "other");
  });

  test("fails closed when reviewer is in the same or unknown model family", async () => {
    const req = sampleRequest();
    const same = await runCrossFamilyReview(req, {
      executionModel: "claude-sonnet-4-6",
      reviewer: {
        model: "claude-opus-4-6",
        review: async () => ({ verdict: "allow" }),
      },
    });
    assert.equal(same.verdict, "ask");
    assert.equal(same.ruleId, "system:cross-family-same-family");

    const unknown = await runCrossFamilyReview(req, {
      executionModel: "claude-sonnet-4-6",
      reviewer: {
        model: "local-mystery-model",
        review: async () => ({ verdict: "allow" }),
      },
    });
    assert.equal(unknown.verdict, "ask");
    assert.equal(unknown.ruleId, "system:cross-family-same-family");
  });

  test("fails closed on timeout or reviewer error", async () => {
    const req = sampleRequest();
    const timedOut = await runCrossFamilyReview(req, {
      executionModel: "claude-sonnet-4-6",
      timeoutMs: 60,
      reviewer: {
        model: "gemini-3.1-pro-preview",
        review: () => new Promise(() => {}),
      },
    });
    assert.equal(timedOut.verdict, "ask");
    assert.equal(timedOut.ruleId, "system:cross-family-timeout");

    const errored = await runCrossFamilyReview(req, {
      executionModel: "claude-sonnet-4-6",
      reviewer: {
        model: "gpt-5.4",
        review: async () => {
          throw new Error("upstream unavailable");
        },
      },
    });
    assert.equal(errored.verdict, "ask");
    assert.equal(errored.ruleId, "system:cross-family-error");
  });

  test("is strictly monotonic inside WardenSession (tightens allow -> deny/ask, never loosens deny)", async () => {
    const home = makeHome("cross-family-session");
    const ws = makeHome("cross-family-ws");
    const inbox = new WardenInbox({ store: new MemoryApprovalInboxStore() });

    let reviewCalls = 0;
    const session = createWardenSession({
      surface: "local-web",
      uid: null,
      origin: { kind: "chat", id: "conv-cf" },
      sandboxMode: "workspace-write",
      workspaceRoot: ws,
      inbox,
      home,
      log: () => {},
      crossFamilyReview: {
        executionModel: "claude-sonnet-4-6",
        reviewer: {
          model: "gemini-3.1-pro-preview",
          review: async () => {
            reviewCalls++;
            return { verdict: "deny", reason: "Suspicious write target." };
          },
        },
      },
    });

    // Benign read does NOT invoke cross-family reviewer.
    const readOutcome = await session.decide("read", { path: path.join(ws, "a.txt") });
    assert.equal(readOutcome.decision.allow, true);
    assert.equal(reviewCalls, 0);

    // Confined workspace write would be allowed by default policy; reviewer tightens to deny.
    const writeOutcome = await session.decide("write", {
      path: path.join(ws, "notes.txt"),
      content: "hello",
    });
    assert.equal(reviewCalls, 1);
    assert.equal(writeOutcome.decision.allow, false);
    assert.equal(writeOutcome.verdict.verdict, "deny");
    assert.equal(writeOutcome.verdict.ruleId, "system:cross-family-review");

    // Protected path is denied by base policy: reviewer cannot loosen it and isn't called.
    const protectedOutcome = await session.decide("write", {
      path: path.join(home, "warden", "rules.json"),
      content: "{}",
    });
    assert.equal(protectedOutcome.decision.allow, false);
    assert.equal(protectedOutcome.verdict.ruleId, "system:warden-state-protected");
    assert.equal(reviewCalls, 1);
  });
});

describe("Ed25519 challenge-bound signed approvals and pluggable inbox store", () => {
  test("verifies valid signed approval and rejects tampered, expired, revoked, missing, and replayed signatures", async () => {
    const home = makeHome("signed-approvals");
    const kp = crypto.generateKeyPairSync("ed25519");
    const pubPem = kp.publicKey.export({ type: "spki", format: "pem" }).toString();
    const approver = await registerApprover(
      { id: "mac-keychain-1", label: "MacBook", publicKeyPem: pubPem },
      home,
    );

    let nowMs = 1_700_000_000_000;
    const store = new FileApprovalInboxStore();
    const verifier = new SignedApprovalVerifier();
    const inbox = new WardenInbox({
      store,
      requireSignedApprovals: true,
      signatureVerifier: verifier,
      now: () => nowMs,
    });

    const req = sampleRequest();
    let queuedNonce = "";
    let queuedId = "";
    let queuedExpiresAt = 0;

    const pendingPromise = inbox.request(req, {
      home,
      reason: "Test signed approval",
      payload: { command: "ls" },
      onQueued: (item) => {
        queuedId = item.id;
        queuedNonce = item.challengeNonce ?? "";
        queuedExpiresAt = Date.parse(item.expiresAt);
      },
    });
    await new Promise((r) => setTimeout(r, 10));
    assert.ok(queuedId);
    assert.ok(queuedNonce.length >= 32);

    // 1. Missing signature fails closed when requireSignedApprovals is true.
    const missing = await inbox.resolve(null, queuedId, {
      approve: true,
      digest: req.digest,
      scope: "once",
    });
    assert.equal(missing.ok, false);
    if (!missing.ok) assert.equal(missing.error, "signature_required");

    // 2. Tampered signature (signed wrong scope) fails closed.
    const wrongScopeSig = signApprovalChallenge(
      {
        approvalId: queuedId,
        digest: req.digest,
        scope: "always",
        nonce: queuedNonce,
        expiresAt: queuedExpiresAt,
        approverId: approver.id,
      },
      kp.privateKey,
    );
    const tampered = await inbox.resolve(null, queuedId, {
      approve: true,
      digest: req.digest,
      scope: "once",
      signature: wrongScopeSig,
    });
    assert.equal(tampered.ok, false);
    if (!tampered.ok) assert.equal(tampered.error, "invalid_signature");

    // 3. Valid signature succeeds once.
    const validSig = signApprovalChallenge(
      {
        approvalId: queuedId,
        digest: req.digest,
        scope: "once",
        nonce: queuedNonce,
        expiresAt: queuedExpiresAt,
        approverId: approver.id,
      },
      kp.privateKey,
    );
    const ok = await inbox.resolve(null, queuedId, {
      approve: true,
      digest: req.digest,
      scope: "once",
      signature: validSig,
    });
    assert.equal(ok.ok, true);
    if (ok.ok) assert.equal(ok.approverId, approver.id);
    const outcome = await pendingPromise;
    assert.equal(outcome.approved, true);

    // 4. Replaying the exact same nonce against verifier fails closed.
    const replay = await verifier.verify({
      home,
      approvalId: queuedId,
      digest: req.digest,
      scope: "once",
      expectedNonce: queuedNonce,
      expiresAt: queuedExpiresAt,
      signature: validSig,
      now: nowMs,
    });
    assert.equal(replay.ok, false);
    if (!replay.ok) assert.equal(replay.error, "signature_replayed");

    // 5. Single-consumption durable claim in FileApprovalInboxStore rejects duplicate claim.
    const secondClaim = await store.claimResolution(home, {
      id: queuedId,
      verdict: "approved",
      at: nowMs + 1,
    });
    assert.equal(secondClaim, false);

    // 6. Revoked approver is rejected on new challenges.
    assert.equal(await revokeApprover(approver.id, home, nowMs + 2), true);
    const revokedCheck = await verifier.verify({
      home,
      approvalId: "apr_other",
      digest: req.digest,
      scope: "once",
      expectedNonce: "b".repeat(64),
      expiresAt: nowMs + 60_000,
      signature: signApprovalChallenge(
        {
          approvalId: "apr_other",
          digest: req.digest,
          scope: "once",
          nonce: "b".repeat(64),
          expiresAt: nowMs + 60_000,
          approverId: approver.id,
        },
        kp.privateKey,
      ),
      now: nowMs + 3,
    });
    assert.equal(revokedCheck.ok, false);
    if (!revokedCheck.ok) assert.equal(revokedCheck.error, "approver_revoked");

    // 7. Expired challenge is rejected.
    nowMs = queuedExpiresAt + 10;
    const expiredCheck = await verifier.verify({
      home,
      approvalId: "apr_exp",
      digest: req.digest,
      scope: "once",
      expectedNonce: "c".repeat(64),
      expiresAt: queuedExpiresAt,
      signature: validSig,
      now: nowMs,
    });
    assert.equal(expiredCheck.ok, false);
    if (!expiredCheck.ok) assert.equal(expiredCheck.error, "expired");
  });
});

describe("Warden provenance tool and HTTP API", () => {
  test("traces tainted persistent writes back to external sources and enforces tenant isolation", async () => {
    const homeA = makeHome("prov-home-a");
    const homeB = makeHome("prov-home-b");

    await appendAudit(
      {
        at: "2026-11-24T01:00:00.000Z",
        kind: "decision",
        requestId: "req_fetch",
        origin: "chat",
        originId: "sess-1",
        tool: "web_fetch",
        category: "read",
        targets: ["https://untrusted.example/page"],
        preview: "web_fetch(https://untrusted.example/page)",
        verdict: "allow",
        tainted: false,
      },
      homeA,
    );
    await appendAudit(
      {
        at: "2026-11-24T01:00:05.000Z",
        kind: "decision",
        requestId: "req_mem",
        origin: "chat",
        originId: "sess-1",
        tool: "memory",
        category: "self",
        targets: ["MEMORY.md"],
        preview: "memory(append) token=[REDACTED]",
        verdict: "allow",
        tainted: true,
      },
      homeA,
    );
    await appendAudit(
      {
        at: "2026-11-24T01:00:10.000Z",
        kind: "decision",
        requestId: "req_kb",
        origin: "chat",
        originId: "sess-2",
        tool: "kb_write",
        category: "self",
        targets: ["wiki/clean.md"],
        preview: "kb_write(wiki/clean.md)",
        verdict: "allow",
        tainted: false,
      },
      homeA,
    );
    // Separate tenant home should never appear in homeA queries.
    await appendAudit(
      {
        at: "2026-11-24T01:00:15.000Z",
        kind: "decision",
        requestId: "req_other_tenant",
        origin: "chat",
        originId: "sess-b",
        tool: "memory",
        category: "self",
        targets: ["MEMORY.md"],
        preview: "tenant B secret",
        verdict: "allow",
        tainted: true,
      },
      homeB,
    );

    const report = await queryProvenance({ home: homeA, taintedOnly: true });
    assert.equal(report.totalWritesScanned, 2);
    assert.equal(report.taintedWritesScanned, 1);
    assert.equal(report.records.length, 1);
    assert.equal(report.records[0]!.tool, "memory");
    assert.equal(report.records[0]!.linkedSources.length, 1);
    assert.equal(report.records[0]!.linkedSources[0]!.tool, "web_fetch");

    // Provenance builtin tool scopes strictly to current homeScope.
    const toolOut = await homeScope.run(homeA, () =>
      provenanceTool.execute(
        { tainted_only: true },
        { cwd: homeA, signal: new AbortController().signal, log: () => {} },
      ),
    );
    const parsedTool = JSON.parse(toolOut);
    assert.equal(parsedTool.records.length, 1);
    assert.equal(parsedTool.records[0].requestId, "req_mem");
    assert.ok(!toolOut.includes("tenant B secret"));

    // HTTP endpoint GET /api/warden/provenance honors host/CSRF check and scoping.
    const inbox = new WardenInbox({ store: new MemoryApprovalInboxStore() });
    const server = http.createServer((req, res) => {
      void handleWardenApi(req, res, req.url ?? "/", {
        inbox,
        uid: null,
        home: homeA,
        allowApproval: true,
        loopbackTrust: true,
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const addr = server.address() as { port: number };
      const res = await fetch(`http://127.0.0.1:${addr.port}/api/warden/provenance?taintedOnly=1`);
      assert.equal(res.status, 200);
      const body = (await res.json()) as { records: Array<{ requestId: string }> };
      assert.equal(body.records.length, 1);
      assert.equal(body.records[0]!.requestId, "req_mem");
    } finally {
      server.close();
    }
  });
});

describe("Warden autonomy invariant for idle/heartbeat surfaces", () => {
  test("origin.kind=autonomy allows read/self and denies external writes without blocking", async () => {
    const home = makeHome("autonomy-warden");
    const ws = makeHome("autonomy-ws");
    const inbox = new WardenInbox({ store: new MemoryApprovalInboxStore() });
    const session = createWardenSession({
      surface: "local-web",
      uid: null,
      origin: { kind: "autonomy", id: "idle" },
      sandboxMode: "workspace-write",
      workspaceRoot: ws,
      inbox,
      home,
      log: () => {},
    });

    const selfWrite = await session.decide("soul_journal", { entry: "quiet reflection" });
    assert.equal(selfWrite.decision.allow, true);

    const extExec = await session.decide("bash", { command: "rm -rf /tmp/foo" });
    assert.equal(extExec.decision.allow, false);
    assert.equal(extExec.verdict.ruleId, "system:autonomy-read-only");
    assert.equal(inbox.size, 0);
  });
});

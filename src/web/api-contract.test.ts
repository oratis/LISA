import fs from "node:fs";
import { expressionCatalog, resolveExpression } from "../expressions/catalog.js";
import type http from "node:http";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { AgentSession } from "../integrations/types.js";
import { toDispatchView } from "../integrations/dispatch-ledger.js";
import {
  LISA_API_VERSION,
  LISA_API_VERSION_HEADER,
  agentSessionsResponse,
  apiAgentSession,
  applyApiVersionHeader,
  isVersionedApiSurface,
  lisaSessionsResponse,
} from "./api-contract.js";

interface Schema {
  $ref?: string;
  type?: string | string[];
  const?: unknown;
  enum?: unknown[];
  required?: string[];
  properties?: Record<string, Schema>;
  items?: Schema;
  additionalProperties?: boolean;
  minimum?: number;
  format?: string;
}

interface OpenApiContract {
  openapi: string;
  info: { version: string };
  "x-lisa-api-major": number;
  "x-lisa-version-header": string;
  components: { schemas: Record<string, Schema> };
}

const contractPath = fileURLToPath(
  new URL("../../contracts/lisa-api-v1.openapi.json", import.meta.url),
);
const contract = JSON.parse(fs.readFileSync(contractPath, "utf8")) as OpenApiContract;

function resolveSchema(schema: Schema): Schema {
  if (!schema.$ref) return schema;
  const prefix = "#/components/schemas/";
  assert.ok(schema.$ref.startsWith(prefix), `unsupported ref ${schema.$ref}`);
  const resolved = contract.components.schemas[schema.$ref.slice(prefix.length)];
  assert.ok(resolved, `missing schema ${schema.$ref}`);
  return resolved;
}

function schemaErrors(schemaInput: Schema, value: unknown, path = "$"): string[] {
  const schema = resolveSchema(schemaInput);
  const errors: string[] = [];
  if (schema.const !== undefined && value !== schema.const) {
    errors.push(`${path} must equal ${JSON.stringify(schema.const)}`);
  }
  if (schema.enum && !schema.enum.includes(value)) {
    errors.push(`${path} is not in enum`);
  }
  const allowedTypes = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
  if (allowedTypes.length > 0) {
    const actual =
      value === null
        ? "null"
        : Array.isArray(value)
          ? "array"
          : Number.isInteger(value)
            ? "integer"
            : typeof value;
    // JSON Schema: every integer is also a "number".
    const numberOk = actual === "integer" && allowedTypes.includes("number");
    if (!allowedTypes.includes(actual) && !numberOk) {
      return [`${path} expected ${allowedTypes.join("|")}, got ${actual}`];
    }
  }
  if (typeof value === "number" && schema.minimum !== undefined && value < schema.minimum) {
    errors.push(`${path} must be >= ${schema.minimum}`);
  }
  if (
    schema.format === "date-time" &&
    typeof value === "string" &&
    Number.isNaN(Date.parse(value))
  ) {
    errors.push(`${path} is not a date-time`);
  }
  if (Array.isArray(value) && schema.items) {
    value.forEach((item, index) => {
      errors.push(...schemaErrors(schema.items!, item, `${path}[${index}]`));
    });
  }
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    for (const key of schema.required ?? []) {
      if (!(key in record)) errors.push(`${path}.${key} is required`);
    }
    for (const [key, child] of Object.entries(schema.properties ?? {})) {
      if (key in record) errors.push(...schemaErrors(child, record[key], `${path}.${key}`));
    }
    if (schema.additionalProperties === false) {
      const known = new Set(Object.keys(schema.properties ?? {}));
      for (const key of Object.keys(record)) {
        if (!known.has(key)) errors.push(`${path}.${key} is not allowed`);
      }
    }
  }
  return errors;
}

function assertContract(schemaName: string, value: unknown): void {
  const schema = contract.components.schemas[schemaName];
  assert.ok(schema, `missing contract schema ${schemaName}`);
  const wireValue = JSON.parse(JSON.stringify(value)) as unknown;
  assert.deepEqual(schemaErrors(schema, wireValue), []);
}

describe("API contract source and generated constants", () => {
  test("OpenAPI is the single source of the shared major/header", () => {
    assert.equal(contract.openapi, "3.1.0");
    assert.equal(contract["x-lisa-api-major"], Number(LISA_API_VERSION));
    assert.equal(contract.info.version.split(".", 1)[0], LISA_API_VERSION);
    assert.equal(contract["x-lisa-version-header"], LISA_API_VERSION_HEADER);
  });

  test("all external API and SSE surfaces are versioned", () => {
    for (const url of [
      "/api/agents/sessions",
      "/api/dispatch/status?id=a",
      "/chat",
      "/events?token=x",
    ]) {
      assert.equal(isVersionedApiSurface(url), true);
    }
    assert.equal(isVersionedApiSurface("/"), false);
    assert.equal(isVersionedApiSurface("/assets/lisa/idle.png"), false);
  });

  test("response header is installed before route handling", () => {
    const headers = new Map<string, string>();
    const response = {
      headersSent: false,
      setHeader(name: string, value: string) {
        headers.set(name, value);
      },
    } as unknown as http.ServerResponse;
    applyApiVersionHeader("/api/island/ping", response);
    assert.equal(headers.get(LISA_API_VERSION_HEADER), LISA_API_VERSION);
  });
});

describe("actual server DTOs conform to OpenAPI v1", () => {
  test("conversation expressions and shared preferences match the additive v1 contract", () => {
    for (const asset of expressionCatalog) {
      const expression = resolveExpression({
        version: 1,
        id: "message-1",
        assetId: asset.id,
        format: "animated",
      });
      assertContract("ConversationExpression", expression);
      assertContract("SSEEvent", { type: "expression", expression });
    }
    assertContract("ExpressionPreferences", { display: "auto", frequency: "restrained" });
  });
  test("Google cards expose scope and account without credential handles", () => {
    const card = {
      id: "request-1",
      sessionId: "session-1",
      status: "selecting",
      createdAt: 1,
      expiresAt: 2,
      account: { id: "123", email: "fixture@example.com" },
      resources: [{ id: "INBOX", name: "Inbox", access: "metadata" }],
      connected: false,
    };
    assertContract("ConnectorRequestsResponse", { requests: [card] });
    assertContract("ConnectorConnectionChangedEvent", {
      type: "connector_connection_changed",
      sessionId: "session-1",
      provider: "gmail",
    });
    const schema = contract.components.schemas.ConnectorRequest!;
    assert.ok(schemaErrors(schema, { ...card, credentialRef: "private" }).length > 0);
    assert.ok(schemaErrors(schema, { ...card, accessToken: "private" }).length > 0);
  });
  test("Linear cards and events expose only account and selected teams", () => {
    const card = {
      id: "request-1",
      sessionId: "session-1",
      status: "selecting",
      createdAt: 1,
      expiresAt: 2,
      connected: false,
      account: {
        id: "00000000-0000-4000-8000-000000000001",
        name: "Fixture",
        email: "fixture@example.com",
      },
      resources: [{ id: "00000000-0000-4000-8000-000000000002", name: "Team", access: "team" }],
    };
    assertContract("ConnectorRequestsResponse", { requests: [card] });
    assertContract("ConnectorConnectionChangedEvent", {
      type: "connector_connection_changed",
      sessionId: "session-1",
      provider: "linear",
    });
    assert.ok(
      schemaErrors(contract.components.schemas.ConnectorRequest!, {
        ...card,
        refreshToken: "private",
      }).length > 0,
    );
  });
  test("GitHub cards exclude credentials and retain stable lifecycle fields", () => {
    const request = {
      id: "request-1",
      sessionId: "session-1",
      status: "selecting",
      createdAt: 1,
      expiresAt: 2,
      account: { id: 12, login: "octocat" },
      repositories: [],
      connected: false,
    };
    assertContract("GitHubRequestsResponse", { requests: [request] });
    assertContract("GitHubConnectionChangedEvent", {
      type: "github_connection_changed",
      sessionId: "session-1",
    });
    const schema = contract.components.schemas.GitHubConnectionRequest!;
    assert.ok(schemaErrors(schema, { ...request, token: "forbidden" }).length > 0);
    assert.ok(schemaErrors(schema, { ...request, status: "silently_authorized" }).length > 0);
  });
  test("agent session serializer emits date-time strings and resumable state", () => {
    const sessions: AgentSession[] = [
      {
        agent: "claude-code",
        sessionId: "s1",
        project: "lisa",
        state: "waiting",
        stateReason: "end_turn",
        lastMtime: Date.parse("2026-07-26T10:00:00.000Z"),
        activity: {
          turnCount: 2,
          lastTools: ["Read"],
          filesTouched: ["src/web/server.ts"],
          tokens: { input: 10, output: 5 },
        },
      },
    ];
    const response = agentSessionsResponse(sessions, new Set());
    assert.equal(response.sessions[0]?.resumable, true);
    assertContract("SessionsResponse", response);
  });

  test("agent session serializer strips the server-internal jsonlPath", () => {
    const response = agentSessionsResponse(
      [
        {
          agent: "claude-code",
          sessionId: "s1",
          project: "lisa",
          state: "working",
          stateReason: "tool_use",
          lastMtime: Date.parse("2026-08-08T10:00:00.000Z"),
          jsonlPath: "/Users/someone/.claude/projects/x/s1.jsonl",
        },
      ],
      new Set(["s1"]),
    );
    assert.ok(!JSON.stringify(response).includes(".claude/projects"));
    assertContract("SessionsResponse", response);
  });

  test("the SSE roster row is the REST row: agent_session_update conforms too (#490)", () => {
    const session: AgentSession = {
      agent: "claude-code",
      sessionId: "s2",
      project: "lisa",
      state: "waiting",
      stateReason: "end_turn",
      lastMtime: Date.parse("2026-08-08T10:00:00.000Z"),
      jsonlPath: "/Users/someone/.claude/projects/x/s2.jsonl",
    };
    const row = apiAgentSession(session, () => false);
    assert.deepEqual(row, agentSessionsResponse([session], new Set()).sessions[0]);
    assert.equal("jsonlPath" in row, false);
    assert.equal(row.resumable, true);
    assertContract("AgentSession", row);
    assertContract("SSEEvent", { type: "agent_session_update", ...row });
    // The liveness check is only consulted for an observe-only claude row.
    let asked = 0;
    apiAgentSession({ ...session, controllable: "pty" }, () => (asked++, false));
    apiAgentSession({ ...session, agent: "codex" }, () => (asked++, false));
    assert.equal(asked, 0);
  });

  test("lisa session serializer strips the on-disk path (LisaSessionsResponse)", () => {
    const response = lisaSessionsResponse([
      {
        id: "20260808-001950-d50b69",
        path: "/Users/someone/.lisa/sessions/20260808-001950-d50b69.jsonl",
        startedAt: "2026-08-08T00:19:50.000Z",
        cwd: "/work/lisa",
        model: "claude-fable-5",
        messageCount: 4,
        lastUserMessage: "switch it",
        firstUserMessage: "restyle the shell",
      },
    ]);
    assert.ok(!JSON.stringify(response).includes(".lisa/sessions"));
    assertContract("LisaSessionsResponse", response);
    assertContract("LisaSessionMutation", { ok: true, id: "20260808-001950-d50b69" });
  });

  test("dispatch and island/error/event fixtures conform", () => {
    const dispatch = toDispatchView(
      {
        id: "42-example",
        agent: "codex",
        pid: 42,
        cwd: "/work/lisa",
        task: "review",
        startedAt: Date.parse("2026-07-26T10:00:00.000Z"),
      },
      true,
    );
    assertContract("DispatchListResponse", { dispatches: [dispatch] });
    assertContract("DispatchStatus", { ok: true, ...dispatch, tail: "done" });
    assertContract("IslandPing", {
      online: true,
      mood: "focused",
      has_unread_idle_message: false,
      last_idle_message_at: null,
      last_idle_message_text: null,
      current_desire: "ship safely",
      uptime_sec: 30,
    });
    assertContract("ErrorResponse", { error: "rate_limited", retryAfterSec: 60 });
    assertContract("SSEEvent", { type: "agent_session_update", ...dispatch });
  });

  test("session refresh and auth/me expiry match the account-session contract (#484)", () => {
    assertContract("SessionRefreshResponse", {
      token: "s1.payload.mac",
      expiresAt: 1_700_000_000_000,
    });
    assertContract("AuthMe", {
      signedIn: true,
      uid: "em-1",
      kind: "email",
      appleUserId: null,
      email: "fixture@example.com",
      verified: true,
      plan: "free",
      sessionExpiresAt: 1_700_000_000_000,
    });
    assertContract("AuthMe", { signedIn: false });
    const refresh = contract.components.schemas.SessionRefreshResponse!;
    assert.ok(schemaErrors(refresh, { token: "x" }).length > 0, "expiresAt is required");
  });

  test("sign-out answers match the contract (#493)", () => {
    assertContract("LogoutResponse", { ok: true, revoked: true });
    assertContract("LogoutResponse", { ok: true, revoked: false });
    assertContract("LogoutAllResponse", { ok: true });
    const logout = contract.components.schemas.LogoutResponse!;
    assert.ok(schemaErrors(logout, { ok: true }).length > 0, "revoked is required");
  });

  test("reve dream-log fixtures conform (W9)", async () => {
    const os = await import("node:os");
    const nodePath = await import("node:path");
    const prev = { home: process.env.LISA_HOME, git: process.env.LISA_SOUL_GIT };
    const home = fs.mkdtempSync(nodePath.join(os.tmpdir(), "lisa-reve-contract-"));
    process.env.LISA_HOME = home;
    process.env.LISA_SOUL_GIT = "0";
    try {
      const { withDream } = await import("../reve/record.js");
      const { listDreams, readDream, readDreamsSince } = await import("../reve/store.js");
      const { requestReconsider, listReconsiderRequests } = await import("../reve/reconsider.js");
      const { revertDream, RevertConflictError } = await import("../reve/revert.js");
      const { metricsSeries } = await import("../reve/metrics.js");
      const { appendMemory } = await import("../memory/store.js");
      const soul = await import("../soul/store.js");
      fs.mkdirSync(nodePath.join(home, "memory"), { recursive: true });
      fs.writeFileSync(nodePath.join(home, "memory", "MEMORY.md"), "- tea\n");
      const page = nodePath.join(home, "kb", "wiki", "tea.md");
      fs.mkdirSync(nodePath.dirname(page), { recursive: true });
      fs.writeFileSync(page, "# Tea\n");
      await withDream({ trigger: "idle" }, async () => {
        await appendMemory("memory", "coffee");
        fs.writeFileSync(page, "# Tea and coffee\n");
        await soul.writeIdentity("I am Lisa.");
        await soul.applyEmotionDelta({ emotion: "joy", delta: 0.2, trigger: "t", maxEvents: 5 });
      });
      const listing = await listDreams(5);
      assertContract("ReveDreamListResponse", { ...listing, pendingReconsider: 0 });
      const id = listing.dreams[0]!.id;
      const request = await requestReconsider(id, "really?");
      assertContract("ReveReconsiderResponse", { ok: true, request });
      assertContract("ReveReconsiderListResponse", { requests: await listReconsiderRequests() });
      {
        // A claimed note (shown to a running pass), then the acknowledged one.
        const { beginDream } = await import("../reve/record.js");
        const { takeReconsiderBlock } = await import("../reve/reconsider.js");
        const pass = await beginDream({ trigger: "reflect" });
        await pass.run(() => takeReconsiderBlock());
        const claimed = await listReconsiderRequests();
        assert.equal(claimed[0]!.status, "claimed");
        assertContract("ReveReconsiderListResponse", { requests: claimed });
        await pass.end();
        assertContract("ReveReconsiderListResponse", { requests: await listReconsiderRequests() });
      }
      assertContract("ReveDreamResponse", {
        dream: await readDream(id),
        reconsider: await listReconsiderRequests(id),
      });
      fs.writeFileSync(page, "# Tea, edited later\n");
      await assert.rejects(revertDream(id, { parts: ["kb"] }), (err: unknown) => {
        assert.ok(err instanceof RevertConflictError);
        assertContract("ReveRevertConflict", {
          error: "revert_conflict",
          conflicts: err.conflicts,
        });
        return true;
      });
      const reverted = await revertDream(id, { parts: ["memory", "kb"], force: true });
      assertContract("ReveRevertResponse", { ok: true, ...reverted });
      // A memory file past the store cap: the one conflict force cannot override.
      const memoryFull: import("../reve/revert.js").RevertConflict = {
        path: "memory/MEMORY.md",
        reason: "memory_full",
      };
      assertContract("ReveRevertConflict", { error: "revert_conflict", conflicts: [memoryFull] });
      const now = new Date();
      assertContract(
        "ReveMetricsSeries",
        metricsSeries(await readDreamsSince(now.getTime() - 86_400_000), { days: 2, now }),
      );
    } finally {
      if (prev.home === undefined) delete process.env.LISA_HOME;
      else process.env.LISA_HOME = prev.home;
      if (prev.git === undefined) delete process.env.LISA_SOUL_GIT;
      else process.env.LISA_SOUL_GIT = prev.git;
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test("incompatible server changes fail validation", () => {
    const bad = {
      sessions: [
        {
          agent: "codex",
          sessionId: "s",
          project: "lisa",
          state: "teleporting",
          stateReason: "",
          lastMtime: 123,
        },
      ],
    };
    const schema = contract.components.schemas.SessionsResponse;
    assert.ok(schema);
    const errors = schemaErrors(schema, bad);
    assert.ok(errors.some((error) => error.includes("enum")));
    assert.ok(errors.some((error) => error.includes("expected string")));
  });
});

describe("memory sovereignty DTOs conform to OpenAPI v1", () => {
  test("entries list, entry mutation and forget report match their schemas", async () => {
    const os = await import("node:os");
    const path = await import("node:path");
    const previous = process.env.LISA_HOME;
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "lisa-contract-mem-"));
    process.env.LISA_HOME = home;
    try {
      fs.mkdirSync(path.join(home, "memory"), { recursive: true });
      fs.writeFileSync(path.join(home, "memory", "MEMORY.md"), "# Notes\n- likes tea\nprose\n");
      const { appendMemoryEntry, listMemoryEntries } = await import("../memory/entries.js");
      const { forget } = await import("../sovereignty/forget.js");
      const entry = await appendMemoryEntry("user", "prefers mornings");
      assertContract("MemoryEntryResponse", { entry });
      assertContract("MemoryEntriesResponse", { stores: await listMemoryEntries() });
      assertContract("MemoryEntryDeleteResponse", { ok: true, id: entry.id });
      assertContract("ForgetResponse", { report: await forget("likes tea", { dryRun: true }) });
      assertContract("ForgetResponse", { report: await forget("likes tea") });
    } finally {
      if (previous === undefined) delete process.env.LISA_HOME;
      else process.env.LISA_HOME = previous;
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

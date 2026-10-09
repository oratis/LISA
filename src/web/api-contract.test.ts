import fs from "node:fs";
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

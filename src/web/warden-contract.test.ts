/**
 * The Warden surface as native clients will consume it: the OpenAPI contract
 * names every route, the real DTOs satisfy the schemas' required fields, and
 * the web client renders cards without ever parsing a preview as HTML.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test } from "node:test";
import { MAIN_CLIENT_JS } from "./lisa-client.js";
import { WardenInbox } from "../warden/inbox.js";
import { createGrants } from "../warden/grants.js";
import { auditDecision, readAudit } from "../warden/audit.js";
import type { ActionRequest, WardenEvent } from "../warden/types.js";

interface Schema {
  required?: string[];
  properties?: Record<string, unknown>;
}
interface Contract {
  paths: Record<string, Record<string, { operationId?: string }>>;
  components: { schemas: Record<string, Schema> };
}

const contract = JSON.parse(
  fs.readFileSync(
    fileURLToPath(new URL("../../contracts/lisa-api-v1.openapi.json", import.meta.url)),
    "utf8",
  ),
) as Contract;

function assertSatisfies(schemaName: string, value: Record<string, unknown>): void {
  const schema = contract.components.schemas[schemaName];
  assert.ok(schema, `missing schema ${schemaName}`);
  for (const key of schema.required ?? []) {
    assert.ok(value[key] !== undefined, `${schemaName}.${key} is required but absent`);
  }
  for (const key of Object.keys(value)) {
    if (value[key] === undefined) continue;
    assert.ok(schema.properties?.[key], `${schemaName} does not document "${key}"`);
  }
}

const req: ActionRequest = {
  id: "act_1",
  at: new Date().toISOString(),
  uid: null,
  surface: "local-web",
  origin: { kind: "task", id: "t1" },
  taskId: "t1",
  tool: "github",
  method: "pr_comment",
  connector: "github",
  category: "publish",
  targets: ["o/r"],
  dataClasses: ["pii"],
  purpose: "reply to review",
  digest: "a".repeat(64),
  preview: 'github(action="pr_comment")',
  sandboxed: false,
  tainted: false,
};

describe("warden API contract", () => {
  test("every Warden route is in the OpenAPI contract", () => {
    const expected: Array<[string, string]> = [
      ["/api/approvals", "get"],
      ["/api/approvals/{id}/approve", "post"],
      ["/api/approvals/{id}/deny", "post"],
      ["/api/warden/rules", "get"],
      ["/api/warden/rules", "put"],
      ["/api/warden/grants", "get"],
      ["/api/warden/grants/{id}", "delete"],
      ["/api/warden/audit", "get"],
    ];
    for (const [route, method] of expected) {
      assert.ok(contract.paths[route]?.[method]?.operationId, `${method.toUpperCase()} ${route}`);
    }
  });

  test("real DTOs satisfy the documented schemas", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "lisa-warden-contract-"));
    const events: WardenEvent[] = [];
    const inbox = new WardenInbox({ emit: (event) => events.push(event) });
    void inbox.request(req, { home, reason: "publish needs approval" });
    for (let i = 0; i < 400 && events.length === 0; i++) await new Promise((r) => setTimeout(r, 5));
    const [item] = await inbox.list(null, home);
    assertSatisfies("ApprovalItem", item as unknown as Record<string, unknown>);
    assert.deepEqual(item!.scopes, ["once", "task", "target", "24h", "always"]);

    // The SSE payload is the card: same fields, plus the event type.
    const { type, ...card } = events[0] as unknown as Record<string, unknown>;
    assert.equal(type, "approval_requested");
    for (const key of Object.keys(card)) {
      assert.ok(
        contract.components.schemas.ApprovalItem!.properties?.[key],
        `approval_requested.${key} is not in ApprovalItem`,
      );
    }
    for (const key of [
      "id",
      "at",
      "tool",
      "category",
      "targets",
      "preview",
      "digest",
      "expiresAt",
      "origin",
    ]) {
      assert.ok(card[key] !== undefined, `approval_requested.${key}`);
    }

    const resolved = await inbox.resolve(null, item!.id, { approve: true, scope: "task" });
    assert.equal(resolved.ok, true);

    const [grant] = await createGrants(req, "target", home);
    assertSatisfies("WardenGrant", grant as unknown as Record<string, unknown>);

    await auditDecision(
      req,
      { verdict: "ask", reason: "r", ruleId: "default:publish" },
      { home, latencyMs: 2 },
    );
    const entries = await readAudit({ home });
    for (const entry of entries) {
      const schema = contract.components.schemas.WardenAuditEntry!;
      for (const key of schema.required ?? []) {
        assert.ok((entry as unknown as Record<string, unknown>)[key] !== undefined, key);
      }
    }
    await inbox.shutdown();
    fs.rmSync(home, { recursive: true, force: true });
  });
});

describe("web client approval cards", () => {
  const start = MAIN_CLIENT_JS.indexOf("// ── Warden approvals (W2a)");
  const block = MAIN_CLIENT_JS.slice(start);

  test("the client handles both inbox events and answers through the API", () => {
    assert.ok(start > 0, "Warden block present");
    assert.match(MAIN_CLIENT_JS, /ev\.type === 'approval_requested'/);
    assert.match(MAIN_CLIENT_JS, /ev\.type === 'approval_resolved'/);
    assert.match(block, /'\/api\/approvals\/' \+ encodeURIComponent\(id\)/);
    assert.match(block, /'content-type': 'application\/json'/);
    for (const label of ["Approve once", "Approve for this task", "Always", "Deny"]) {
      assert.ok(block.includes(label), label);
    }
  });

  test("previews are never parsed as HTML", () => {
    assert.equal(/innerHTML|insertAdjacentHTML|outerHTML|document\.write/.test(block), false);
    assert.match(block, /textContent/);
  });

  test("approving sends the digest the card was rendered from", () => {
    assert.match(block, /scope: 'once', digest: item\.digest/);
    assert.match(block, /scope: 'always', digest: item\.digest/);
  });
});

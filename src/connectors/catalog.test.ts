import { test } from "node:test";
import assert from "node:assert/strict";
import { CONNECTOR_CATALOG, connectorCatalogReply } from "./catalog.js";
import { isGitHubReadRequest } from "./github.js";
import { googleReadIntents } from "./google-driver.js";
import { isLinearReadRequest } from "./linear-driver.js";
import { isDriveReadRequest } from "./drive-driver.js";
import { isNotionReadRequest } from "./notion-driver.js";
import { isFeishuReadRequest } from "./feishu-driver.js";
import { isSlackReadRequest } from "./slack-driver.js";
import { workspaceReadIntents } from "./workspace/catalog.js";

test("every directory example routes to exactly its own read connector in either language", () => {
  for (const app of CONNECTOR_CATALOG) {
    for (const example of Object.values(app.example)) {
      const matches = [
        ...googleReadIntents(example),
        ...(isGitHubReadRequest(example) ? ["github"] : []),
        ...(isLinearReadRequest(example) ? ["linear"] : []),
        ...(isDriveReadRequest(example) ? ["google-drive"] : []),
        ...(isNotionReadRequest(example) ? ["notion"] : []),
        ...(isFeishuReadRequest(example) ? ["feishu"] : []),
        ...(isSlackReadRequest(example) ? ["slack"] : []),
        ...workspaceReadIntents(example),
      ];
      assert.deepEqual(matches, [app.id], example);
      assert.equal(connectorCatalogReply(example), undefined);
    }
  }
});

test("directory replies distinguish catalog lookup from a data request", () => {
  for (const app of CONNECTOR_CATALOG)
    assert.ok(connectorCatalogReply("有哪些应用可以连接？")?.includes(app.name));
  assert.match(connectorCatalogReply("What apps can I connect?")!, /read-only/);
  const filtered = connectorCatalogReply("/connectors 工单", "zh-CN")!;
  assert.match(filtered, /Linear/);
  assert.doesNotMatch(filtered, /Gmail/);
  assert.match(connectorCatalogReply("/connectors foobar")!, /No matching/);
  assert.equal(connectorCatalogReply("/connectors\nSend mail"), undefined);
});

test("the directory only offers sources this install can serve", () => {
  const builtIns = new Set([
    "github",
    "google-calendar",
    "gmail",
    "linear",
    "google-drive",
    "slack",
    "notion",
    "feishu",
  ]);
  const onlyBuiltIns = (id: string) => builtIns.has(id);
  const reply = connectorCatalogReply("/connectors", "en", onlyBuiltIns)!;
  assert.match(reply, /GitHub/);
  assert.doesNotMatch(reply, /Jira|Dropbox|Apple Reminders/);
  assert.match(connectorCatalogReply("/connectors jira", "en", onlyBuiltIns)!, /No matching/);
});

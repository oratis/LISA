import { test } from "node:test";
import assert from "node:assert/strict";
import { CONNECTOR_CATALOG, connectorCatalogReply } from "./catalog.js";
import { isGitHubReadRequest } from "./github.js";
import { googleReadIntents } from "./google-driver.js";
import { isLinearReadRequest } from "./linear-driver.js";
import { isDriveReadRequest } from "./drive-driver.js";
import { isNotionReadRequest } from "./notion-driver.js";
import { isSlackReadRequest } from "./slack-driver.js";

test("every directory example routes to exactly its own read connector in either language", () => {
  for (const app of CONNECTOR_CATALOG) {
    for (const example of Object.values(app.example)) {
      const matches = [
        ...googleReadIntents(example),
        ...(isGitHubReadRequest(example) ? ["github"] : []),
        ...(isLinearReadRequest(example) ? ["linear"] : []),
        ...(isDriveReadRequest(example) ? ["google-drive"] : []),
        ...(isNotionReadRequest(example) ? ["notion"] : []),
        ...(isSlackReadRequest(example) ? ["slack"] : []),
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

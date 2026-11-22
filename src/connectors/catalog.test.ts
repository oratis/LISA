import { gameReadIntent } from "./gaming/catalog.js";
import { isObsidianReadRequest } from "./obsidian.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { CONNECTOR_CATALOG, connectorCatalogReply } from "./catalog.js";
import { isGitHubReadRequest } from "./github.js";
import { googleReadIntents } from "./google-driver.js";
import { isLinearReadRequest } from "./linear-driver.js";
import { isDriveReadRequest } from "./drive-driver.js";
import { isNotionReadRequest } from "./notion-driver.js";
import { isT3ReadRequest } from "./t3-driver.js";
import { isFeishuReadRequest } from "./feishu-driver.js";
import { isSlackReadRequest } from "./slack-driver.js";
import { workspaceReadIntents } from "./workspace/catalog.js";

test("every directory example routes to exactly its own read connector in either language", () => {
  for (const app of CONNECTOR_CATALOG) {
    for (const example of Object.values(app.example)) {
      const matches = [
        ...(isObsidianReadRequest(example) ? ["obsidian"] : []),
        ...googleReadIntents(example),
        ...(isGitHubReadRequest(example) ? ["github"] : []),
        ...(isLinearReadRequest(example) ? ["linear"] : []),
        ...(isDriveReadRequest(example) ? ["google-drive"] : []),
        ...(isNotionReadRequest(example) ? ["notion"] : []),
        ...(isT3ReadRequest(example) ? ["t3"] : []),
        ...(isFeishuReadRequest(example) ? ["feishu"] : []),
        ...(isSlackReadRequest(example) ? ["slack"] : []),
        ...workspaceReadIntents(example),
        ...[gameReadIntent(example)].filter(Boolean),
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

test("game requests keep general CSVs and write requests in the ordinary chat", () => {
  assert.equal(gameReadIntent("Read my monthly salary CSV"), undefined);
  assert.equal(gameReadIntent("Buy my selected Steam game"), undefined);
  assert.equal(gameReadIntent("Review my Steam invoice"), undefined);
  assert.equal(gameReadIntent("show my Switch settings"), undefined);
  assert.equal(gameReadIntent("总结我的 PlayStation 合同"), undefined);
  assert.equal(gameReadIntent("Review my Epic Games invoice"), undefined);
  assert.equal(gameReadIntent("整理我选定的 Nintendo 游戏"), "game-library");
  assert.equal(gameReadIntent("Import my Steam library CSV"), "game-library");
  assert.match(connectorCatalogReply("/connectors PlayStation")!, /Playnite/);
});

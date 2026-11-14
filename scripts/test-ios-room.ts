// Run with node --import tsx scripts/test-ios-room.ts <simulator UUID> <new .xcresult path>
import { spawn, execFileSync } from "node:child_process";
import path from "node:path";
import fs from "node:fs/promises";
import { WardenInbox } from "../src/warden/inbox.js";
import { writeMemory } from "../src/memory/store.js";
import { startLisa, REPO_ROOT } from "../tests/e2e/helpers/lisa-server.js";
import { seedReve } from "../tests/e2e/helpers/reve-data.js";
import { homeScope } from "../src/paths.js";
import { addSource } from "../src/kb/store.js";

const [simulator, result] = process.argv.slice(2);
if (!simulator || !result) throw new Error("Provide a simulator UUID and new .xcresult path");
const pocket = path.join(REPO_ROOT, "packaging/ios-companion");
execFileSync("xcodegen", ["generate"], { cwd: pocket, stdio: "inherit" });
await fs.mkdir(path.join(REPO_ROOT, ".tmp/e2e"), { recursive: true });
const checkout = await fs.mkdtemp(path.join(REPO_ROOT, ".tmp/e2e/room-approval-"));
const target = path.join(checkout, "example.ts");
await fs.writeFile(target, 'export const state = "before";');
const lisa = await startLisa({
  label: "ios-room",
  cwd: checkout,
  stub: "self-edit",
  env: { LISA_APPROVAL: "warden" },
});
try {
  await seedReve(lisa.home);
  await homeScope.run(lisa.home, () =>
    writeMemory("user", "- 喜欢简洁的中文解释。\n- 讨论项目时，习惯先看结论，再看细节。"),
  );
  const project = path.join(lisa.home, "user-home", ".claude", "projects", "-Projects-Atlas");
  await fs.mkdir(project, { recursive: true });
  await fs.writeFile(
    path.join(project, "bbbbbbbb-0000-0000-0000-000000000001.jsonl"),
    JSON.stringify({
      type: "assistant",
      cwd: "/Projects/Atlas",
      message: {
        role: "assistant",
        stop_reason: "end_turn",
        content: [{ type: "text", text: "Which draft?" }],
      },
    }) + "\n",
  );
  await fs.mkdir(path.join(lisa.home, "warden"), { recursive: true });
  await fs.writeFile(
    path.join(lisa.home, "warden/rules.json"),
    JSON.stringify({
      version: 1,
      categories: {},
      tools: { edit: "ask" },
      targets: {},
      trustedMcpServers: [],
    }),
  );
  await lisa.restart();
  const handoff = await new WardenInbox().handoff(
    {
      id: "act_room_fixture",
      uid: null,
      surface: "local-web",
      origin: { kind: "chat" },
      at: new Date().toISOString(),
      tool: "review",
      category: "publish",
      preview: "请核对发布说明中的两个版本号。",
      purpose: "Verify release notes",
      targets: [],
      dataClasses: [],
      digest: "0".repeat(64),
      tainted: false,
      sandboxed: false,
    },
    { home: lisa.home, reason: "Review required" },
  );
  if (!handoff) throw new Error("Could not create the Room handoff fixture");
  await homeScope.run(lisa.home, () =>
    addSource({
      title: "Room field notes",
      body: "The copper bookmark is in the sunroom.",
    }),
  );
  await homeScope.run(lisa.home, () =>
    addSource({
      title: "Garden inventory",
      body: "Water the basil on the terrace.",
    }),
  );
  const child = spawn(
    "xcodebuild",
    [
      "test",
      "-project",
      "LisaPocket.xcodeproj",
      "-scheme",
      "LisaPocketRoomAcceptance",
      "-destination",
      "id=" + simulator,
      "-parallel-testing-enabled",
      "NO",
      "-derivedDataPath",
      path.join(REPO_ROOT, ".tmp/ios-room-build"),
      "-resultBundlePath",
      path.resolve(result),
      "CODE_SIGNING_ALLOWED=NO",
    ],
    {
      cwd: pocket,
      stdio: "inherit",
      env: { ...process.env, TEST_RUNNER_ROOM_E2E_PORT: new URL(lisa.baseURL).port },
    },
  );
  process.exitCode = await new Promise<number>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => resolve(code ?? 1));
  });
  if (process.exitCode === 0 && !(await fs.readFile(target, "utf8")).includes('"after"'))
    throw new Error("The reviewed, one-time approval did not reach its isolated target");
} finally {
  await lisa.stop();
  await fs.rm(checkout, { recursive: true, force: true });
}

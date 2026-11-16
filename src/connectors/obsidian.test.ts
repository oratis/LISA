import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ObsidianDriver, isObsidianReadRequest } from "./obsidian.js";
import { ReadonlyConnector } from "./service.js";
import { MemorySecretStore } from "../warden/secrets.js";
import type { CredentialAccess } from "./types.js";
const signal = () => AbortSignal.timeout(5000);
test("Obsidian lists, searches and reads only confirmed Markdown vaults, excluding links and hidden files", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lisa-obsidian-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const vault = path.join(dir, "Notes");
  await fs.mkdir(path.join(vault, "Projects"), { recursive: true });
  await fs.mkdir(path.join(vault, ".obsidian"));
  await fs.writeFile(
    path.join(vault, "Projects/plan.md"),
    "# Launch\nBox and Obsidian knowledge\n",
  );
  await fs.writeFile(path.join(vault, ".obsidian/private.md"), "hidden");
  await fs.writeFile(path.join(dir, "outside.md"), "outside secret");
  await fs.symlink(path.join(dir, "outside.md"), path.join(vault, "link.md"));
  await fs.link(path.join(dir, "outside.md"), path.join(vault, "hard.md"));
  await fs.symlink(dir, path.join(vault, "escape"));
  const driver = new ObsidianDriver(async () => [vault]);
  const { token, account } = await driver.authorize("login", signal());
  const c: CredentialAccess = { use: (fn) => fn(token, async () => {}) };
  const resources = await driver.resources(c, 1, signal());
  assert.equal(resources.length, 1);
  assert.equal(JSON.stringify(resources).includes(dir), false);
  const id = resources[0]!.id;
  const read = (args: unknown) => driver.read(c, account, resources, args, signal());
  const listing = (await read({ operation: "list", resourceId: id })) as {
    items: { path: string }[];
  };
  assert(listing.items.some((i) => i.path === "Projects/plan.md"));
  assert(!listing.items.some((i) => /link|private|escape/.test(i.path)));
  const found = (await read({ operation: "search", resourceId: id, query: "knowledge" })) as {
    items: unknown[];
    truncated: boolean;
  };
  assert.equal(found.items.length, 1);
  assert.equal(found.truncated, true); // excluded hard link is reported
  assert.match(
    JSON.stringify(await read({ operation: "read", resourceId: id, path: "Projects/plan.md" })),
    /Box and Obsidian/,
  );
  for (const relative of [
    "../outside.md",
    "/outside.md",
    ".obsidian/private.md",
    "link.md",
    "escape/outside.md",
    "hard.md",
  ])
    await assert.rejects(read({ operation: "read", resourceId: id, path: relative }), /obsidian_/);
  await assert.rejects(
    driver.read(
      c,
      account,
      [],
      { operation: "read", resourceId: id, path: "Projects/plan.md" },
      signal(),
    ),
    /resource_not_granted/,
  );
  await assert.rejects(read({ operation: "write", resourceId: id }), /read_operation_required/);
  await fs.rename(vault, vault + "-old");
  await fs.mkdir(vault);
  await assert.rejects(driver.resource(c, id, signal()), /obsidian_reauthorize/);
});
test("Obsidian consent, saved status, restart and disconnect use the shared durable lifecycle", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "lisa-obsidian-service-"));
  const vault = path.join(home, "Vault");
  await fs.mkdir(vault);
  await fs.writeFile(path.join(vault, "hello.md"), "Hello Lisa");
  let discoveries = 0,
    deliveries = 0;
  const driver = new ObsidianDriver(async () => {
    discoveries++;
    return [vault];
  });
  const secrets = new MemorySecretStore();
  const options = {
    home,
    driver,
    secrets,
    changed: () => {},
    resume: async (
      run: Parameters<NonNullable<ConstructorParameters<typeof ReadonlyConnector>[0]["resume"]>>[0],
    ) => {
      const output = await run.tools[0]!.execute(
        { operation: "list", resourceId: (run.request.resources[0] as { id: string }).id },
        { cwd: home, signal: run.signal, log: () => {} },
      );
      assert.match(JSON.stringify(output), /hello.md/);
      await run.commit(async () => {
        deliveries++;
      });
    },
  };
  const service = new ReadonlyConnector(options);
  t.after(async () => {
    await service.stop();
    await fs.rm(home, { recursive: true, force: true });
  });
  await service.start();
  assert.deepEqual(await service.summary(), { status: "disconnected", resourceCount: 0 });
  assert.equal(discoveries, 0);
  const request = await service.create("chat", "Read Obsidian");
  await service.authorize(request.id, "login");
  for (let i = 0; (await service.list("chat"))[0]!.status !== "selecting" && i < 200; i++)
    await new Promise((r) => setTimeout(r, 10));
  const resources = await service.resources(request.id, 1, signal());
  await service.confirm(request.id, [resources[0]!.id], signal());
  for (let i = 0; deliveries === 0 && i < 200; i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(deliveries, 1);
  assert.deepEqual(await service.summary(), { status: "authorized", resourceCount: 1 });
  const restarted = new ReadonlyConnector(options);
  t.after(() => restarted.stop());
  assert.deepEqual(await restarted.summary(), { status: "authorized", resourceCount: 1 });
  assert.equal(discoveries, 1);
  await restarted.disconnect();
  assert.deepEqual(await restarted.summary(), { status: "disconnected", resourceCount: 0 });
  assert.equal((await secrets.list()).length, 0);
  assert(isObsidianReadRequest("检索 Obsidian 笔记"));
  assert(!isObsidianReadRequest("删除 Obsidian 笔记"));
  await assert.rejects(
    new ObsidianDriver(async () => []).authorize("login", signal()),
    /obsidian_no_vaults/,
  );
});

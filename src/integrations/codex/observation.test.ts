import { test } from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setCodexObservation } from "./observation.js";
import type { OrchestratorHub } from "../hub.js";
import type { AgentIntegrationConfig } from "../types.js";

/** Just enough hub for setCodexObservation: records what it was asked to run. */
function fakeHub(running = false) {
  const calls: AgentIntegrationConfig[] = [];
  const hub = {
    hasObserver: () => running,
    async setObserverEnabled(_name: string, config: AgentIntegrationConfig) {
      calls.push(config);
      running = config.enabled !== false;
    },
  } as unknown as OrchestratorHub;
  return { hub, calls };
}

async function agentsFile(content: object): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "lisa-codex-observation-"));
  const file = path.join(dir, "agents.json");
  await fsp.writeFile(file, JSON.stringify(content));
  return file;
}

const saved = async (file: string) =>
  JSON.parse(await fsp.readFile(file, "utf8")) as {
    visibility?: string;
    integrations: { codex: AgentIntegrationConfig };
  };

test("enabling Codex keeps a metadata-only visibility the owner set", async () => {
  const file = await agentsFile({
    integrations: { codex: { enabled: false, visibility: "metadata" } },
  });
  const { hub, calls } = fakeHub();
  const entry = await setCodexObservation(file, hub, true, false);
  assert.equal(entry.visibility, "metadata");
  assert.equal((await saved(file)).integrations.codex.visibility, "metadata");
  assert.equal(calls.at(-1)?.visibility, "metadata");
});

test("enabling Codex under a global metadata-only setting writes no per-agent override", async () => {
  const file = await agentsFile({ visibility: "metadata", integrations: {} });
  const { hub } = fakeHub();
  const entry = await setCodexObservation(file, hub, true, false);
  assert.equal(entry.visibility, undefined);
  const written = await saved(file);
  assert.equal(written.visibility, "metadata");
  assert.equal(written.integrations.codex.visibility, undefined);
});

test("only an explicit request for conversations raises visibility to activity", async () => {
  const file = await agentsFile({
    integrations: { codex: { enabled: true, visibility: "metadata" } },
  });
  const { hub } = fakeHub(true);
  const entry = await setCodexObservation(file, hub, true, true);
  assert.equal(entry.visibility, "activity");
  assert.equal((await saved(file)).integrations.codex.visibility, "activity");
});

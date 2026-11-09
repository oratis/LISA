import { expect, test } from "@playwright/test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { startLisa, type LisaInstance } from "./helpers/lisa-server.js";

test("a local owner can discover, show and hide Codex sessions from Control", async ({
  page,
  request,
}) => {
  const codex = await fs.mkdtemp(path.join(os.tmpdir(), "lisa-e2e-codex-"));
  let lisa: LisaInstance | undefined;
  try {
    const sessions = path.join(codex, "sessions", "2026", "11", "08");
    await fs.mkdir(sessions, { recursive: true });
    const log =
      [
        { type: "session_meta", payload: { cwd: "/work/sample-project" } },
        { type: "event_msg", payload: { type: "task_started" } },
        {
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "Review the release" }],
          },
        },
        {
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "The release is ready." }],
          },
        },
      ]
        .map((row) => JSON.stringify(row))
        .join("\n") + "\n";
    await fs.writeFile(path.join(sessions, "rollout-current.jsonl"), log);
    await fs.writeFile(
      path.join(codex, "session_index.jsonl"),
      JSON.stringify({ id: "current", thread_name: "November release" }) + "\n",
    );
    const old = path.join(sessions, "rollout-yesterday.jsonl");
    await fs.writeFile(old, log);
    await fs.utimes(old, new Date(0), new Date(0));
    lisa = await startLisa({ label: "codex-observation", env: { CODEX_HOME: codex } });
    const internal = log.replace(
      '"/work/sample-project"',
      '"/work/sample-project","source":{"subagent":{"other":"guardian"}}',
    );
    await fs.writeFile(path.join(sessions, "rollout-review.jsonl"), internal);
    const configFile = path.join(lisa.home, "agents.json");
    const config = { integrations: { git: { enabled: false } }, note: "retain this" };
    await fs.writeFile(configFile, JSON.stringify(config));
    const endpoint = lisa.baseURL + "/api/agents/codex/observation";
    const forbidden = await request.post(endpoint, {
      headers: { Origin: "https://other.example" },
      data: { enabled: true },
    });
    expect(forbidden.status()).toBe(403);
    expect((await request.post(endpoint, { data: { enabled: "true" } })).status()).toBe(400);

    await page.goto(lisa.baseURL + "/#control");
    const rows = page.locator("#ctrlScroll .ctrl-row");
    const sidebar = page.locator("#sessionTree .agent-group");
    await expect(
      page.getByRole("button", { name: "Show Codex sessions", exact: true }),
    ).toBeVisible();
    await expect(rows).toHaveCount(0);
    await page.getByRole("button", { name: "Show Codex sessions", exact: true }).click();
    await expect(rows).toHaveCount(1);
    await expect(rows).toContainText("November release");
    await expect(sidebar).toContainText("Codex");
    const foreign = { Origin: "https://other.example" };
    const remoteView = await request.get(lisa.baseURL + "/api/agents/sessions", {
      headers: foreign,
    });
    expect((await remoteView.json()).sessions[0]).not.toHaveProperty("displayName");
    expect(
      (
        await request.get(lisa.baseURL + "/api/agents/transcript?agent=codex&id=current", {
          headers: foreign,
        })
      ).status(),
    ).toBe(403);
    expect(JSON.parse(await fs.readFile(configFile, "utf8"))).toMatchObject({
      ...config,
      integrations: { ...config.integrations, codex: { enabled: true, visibility: "activity" } },
    });

    await page.locator('.tleaf[data-agent="codex"]').click();
    await expect(page.locator("#asHead b")).toHaveText("November release");
    await expect(page.locator("#asHead .meta")).toContainText("sample-project");
    await expect(page.locator("#asSteps .as-msg.user")).toContainText("Review the release");
    await expect(page.locator("#asSteps .as-msg.assistant")).toContainText("The release is ready.");

    await lisa.restart();
    await page.goto(lisa.baseURL + "/#control");
    await page.reload();
    await expect(rows).toHaveCount(1);
    await page.getByRole("button", { name: "Stop showing Codex sessions" }).click();
    await expect(rows).toHaveCount(0);
    await expect(sidebar).toHaveCount(0);
    expect(JSON.parse(await fs.readFile(configFile, "utf8")).integrations.codex.enabled).toBe(
      false,
    );

    // An existing metadata-only installation can upgrade without restarting.
    await fs.writeFile(
      configFile,
      JSON.stringify({ integrations: { codex: { enabled: true, visibility: "metadata" } } }),
    );
    await lisa.restart();
    await page.reload();
    await expect(
      page.getByRole("button", { name: "Show conversations", exact: true }),
    ).toBeVisible();
    const beforeUpgrade = await request.get(
      lisa.baseURL + "/api/agents/transcript?agent=codex&id=current",
    );
    expect(await beforeUpgrade.json()).toEqual({ entries: [], metadataOnly: true });
    await page.getByRole("button", { name: "Show conversations", exact: true }).click();
    await expect(rows).toContainText("November release");
    await fs.appendFile(
      path.join(codex, "session_index.jsonl"),
      JSON.stringify({ id: "current", thread_name: "Renamed in Codex" }) + "\n",
    );
    await page.reload();
    await expect(rows).toContainText("Renamed in Codex");
    await page.getByRole("button", { name: "Stop showing Codex sessions" }).click();
    await expect(rows).toHaveCount(0);

    await fs.writeFile(configFile, "{broken");
    await page.getByRole("button", { name: "Show Codex sessions", exact: true }).click();
    await expect(page.getByRole("alert").filter({ hasText: "Could not save" })).toBeVisible();
    expect(await fs.readFile(configFile, "utf8")).toBe("{broken");
    await expect(rows).toHaveCount(0);
  } finally {
    await lisa?.stop();
    await fs.rm(codex, { recursive: true, force: true });
  }
});

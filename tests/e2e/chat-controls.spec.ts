import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { startLisa } from "./helpers/lisa-server.js";

test("composer binds the model and permissions to the active chat", async ({ page }) => {
  const lisa = await startLisa({
    label: "chat-controls",
    env: { LISA_APPROVAL: "auto", LISA_CHAT_MODELS: "claude-haiku-4-5" },
  });
  try {
    await page.goto(lisa.baseURL);
    const permission = page.locator("#chatPermission");
    const model = page.getByLabel("Chat model", { exact: true });
    await expect(permission).toHaveText("Smart approval");
    await permission.click();
    await page.getByRole("button", { name: /^Ask for approval/ }).click();
    await model.selectOption("claude-haiku-4-5");
    await expect(page.locator("#chatEffort")).toBeHidden();
    await page.reload();
    await expect(permission).toHaveText("Ask for approval");
    await expect(model).toHaveValue("claude-haiku-4-5");
    const outgoing = page.waitForRequest((r) => r.url().endsWith("/chat") && r.method() === "POST");
    await page.locator("#input").fill("hello");
    await page.locator("#sendBtn").click();
    expect((await outgoing).postDataJSON().controls).toEqual({
      permission: "ask",
      model: "claude-haiku-4-5",
    });
    await expect(page.locator("#sendBtn")).toBeEnabled();
    await page.locator("#sbNewSession").click();
    await expect(permission).toHaveText("Smart approval");
    await expect(model).toHaveValue("");
    await page.setViewportSize({ width: 390, height: 844 });
    await permission.click();
    page.once("dialog", (dialog) => dialog.dismiss());
    await page.getByRole("button", { name: /^Full access/ }).click();
    await expect(permission).toHaveText("Smart approval");
    await permission.click();
    page.once("dialog", (dialog) => dialog.accept());
    await page.getByRole("button", { name: /^Full access/ }).click();
    await expect(permission).toHaveText("Full access");
    await page.reload();
    await expect(permission).toHaveText("Smart approval");
  } finally {
    await lisa.stop();
  }
});

test("editing Lisa pauses at a reviewable approval card even in full access", async ({ page }) => {
  const checkout = await fs.mkdtemp(path.join(os.tmpdir(), "lisa-chat-approval-"));
  const target = path.join(checkout, "example.ts");
  await fs.writeFile(target, 'export const state = "before";');
  const lisa = await startLisa({
    label: "self-edit",
    cwd: checkout,
    stub: "self-edit",
    env: { LISA_SOURCE_ROOT: checkout, LISA_APPROVAL: "auto" },
  });
  try {
    await page.goto(lisa.baseURL);
    await page.locator("#chatPermission").click();
    page.once("dialog", (dialog) => dialog.accept());
    await page.getByRole("button", { name: /^Full access/ }).click();
    for (const answer of ["Deny", "Approve once"]) {
      await page.locator("#input").fill("Update Lisa's example file.");
      await page.locator("#sendBtn").click();
      const card = page.locator(".warden-card:not(.resolved)").last();
      await expect(card).toContainText("Lisa’s own files");
      await expect(card.locator(".warden-field-value")).toContainText([
        "example.ts",
        "before",
        "after",
      ]);
      await expect(card.getByRole("button", { name: "Always", exact: true })).toHaveCount(0);
      expect(await fs.readFile(target, "utf8")).toContain("before");
      await card.getByRole("button", { name: answer, exact: true }).click();
      await expect(page.locator("#sendBtn")).toBeEnabled();
      expect(await fs.readFile(target, "utf8")).toContain(answer === "Deny" ? "before" : "after");
    }
  } finally {
    await lisa.stop();
    await fs.rm(checkout, { recursive: true, force: true });
  }
});

test("stale effort is dropped when the default model changes to one without effort support", async ({
  page,
}) => {
  const lisa = await startLisa({
    label: "stale-effort",
    env: {
      LISA_APPROVAL: "auto",
      LISA_MODEL: "claude-sonnet-4-6",
      LISA_CHAT_MODELS: "claude-sonnet-4-6,claude-haiku-4-5",
    },
  });
  try {
    await page.goto(lisa.baseURL);
    const effort = page.getByLabel("Reasoning effort", { exact: true });
    await expect(effort).toBeVisible();
    await effort.selectOption("high");
    await expect(effort).toHaveValue("high");

    // Change the server default model in Settings to a model with no efforts.
    await page.locator('#navList .nav-item[data-view="settings"]').click();
    await page.getByLabel("Model (optional)").fill("claude-haiku-4-5");
    const refreshControls = page.waitForResponse(
      (r) => r.url().endsWith("/api/chat-controls") && r.status() === 200,
    );
    await page.locator("#viewSettings").getByRole("button", { name: "Save", exact: true }).click();
    await refreshControls;
    await page.locator('#navList .nav-item[data-view="chat"]').click();
    await expect(effort).toBeHidden();

    const outgoing = page.waitForRequest((r) => r.url().endsWith("/chat") && r.method() === "POST");
    const responsePromise = page.waitForResponse(
      (r) => r.url().endsWith("/chat") && r.request().method() === "POST",
    );
    await page.locator("#input").fill("hello after model change");
    await page.locator("#sendBtn").click();
    expect((await outgoing).postDataJSON().controls).toEqual({
      permission: "smart",
    });
    expect((await responsePromise).status()).toBe(200);
    await expect(page.locator("#sendBtn")).toBeEnabled();
  } finally {
    await lisa.stop();
  }
});

import { test, expect } from "@playwright/test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { startLisa, type LisaInstance } from "./helpers/lisa-server.js";

test.describe("skills and coding plans", () => {
  // Fault injection must reach page.route even after the app claims the page.
  test.use({ serviceWorkers: "block" });
  let lisa: LisaInstance, root: string;
  test.beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "lisa-skills-browser-"));
    await fs.mkdir(path.join(root, "project/.git"), { recursive: true });
    for (const [location, name] of [
      ["project/.agents/skills", "project-workflow"],
      ["codex/skills", "codex-workflow"],
    ]) {
      const folder = path.join(root, location!, name!);
      await fs.mkdir(folder, { recursive: true });
      await fs.writeFile(
        path.join(folder, "SKILL.md"),
        `---\nname: ${name}\ndescription: Fixture workflow\n---\nOnly synthetic test data.\n`,
      );
    }
    const cli = path.join(root, "custom codex");
    await fs.writeFile(cli, '#!/bin/sh\necho "Logged in using ChatGPT"\n', { mode: 0o700 });
    lisa = await startLisa({
      label: "skills-plans",
      cwd: path.join(root, "project"),
      env: { CODEX_HOME: path.join(root, "codex"), LISA_PTY_CODEX_CMD: cli },
    });
  });
  test.afterAll(async () => {
    await lisa?.stop();
    await fs.rm(root, { recursive: true, force: true });
  });
  test.beforeEach(async ({ page }) => {
    await page.goto(lisa.baseURL);
  });

  test("project skills, explicit import and skill creation survive refresh", async ({ page }) => {
    await page.getByRole("button", { name: "Skills", exact: true }).click();
    await expect(page.locator("#modalBody")).toContainText("project-workflow");
    await page.getByRole("button", { name: "Import codex-workflow from codex" }).click();
    await expect(page.locator("#modalBody")).toContainText("Already added");
    expect(
      await fs.readFile(path.join(lisa.home, "skills/codex-workflow/SKILL.md"), "utf8"),
    ).toContain("Only synthetic");
    await page.getByRole("button", { name: "Create skill", exact: true }).click();
    await page.getByLabel("Name (lowercase letters, digits and hyphens)").fill("my-workflow");
    await page.getByLabel("Description", { exact: true }).fill("My test workflow");
    await page.getByLabel("Instructions", { exact: true }).fill("Use only fixture data.");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.locator("#modalBody")).toContainText("my-workflow");
    await page.reload();
    await page.getByRole("button", { name: "Skills", exact: true }).click();
    await expect(page.locator("#modalBody")).toContainText("my-workflow");
    await expect(page.locator("#modalBody")).toContainText("project-workflow");
  });
  for (const panel of ["Skills", "Tools", "Memory"]) {
    test(`${panel} reports errors and retries without displaying a false empty state`, async ({
      page,
    }) => {
      // Memory loads the editable entries first and falls back to the
      // read-only view; both must fail for the error state to show.
      const endpoints =
        panel === "Memory"
          ? ["/api/memory/entries", "/api/memory"]
          : ["/api/" + panel.toLowerCase()];
      let injectedFailures = 0;
      for (const endpoint of endpoints)
        await page.route("**" + endpoint, (route) => {
          injectedFailures++;
          return route.fulfill({
            status: 503,
            contentType: "application/json",
            body: '{"error":"offline fixture"}',
          });
        });
      if (panel === "Memory") {
        await fs.mkdir(path.join(lisa.home, "memory"), { recursive: true });
        await fs.writeFile(path.join(lisa.home, "memory/USER.md"), "Preserved audit memory");
        await page.getByRole("button", { name: "Memory", exact: true }).click();
        await page.getByRole("button", { name: /Memory USER.md/ }).click();
      } else await page.getByRole("button", { name: panel, exact: true }).click();
      await expect(page.locator("#modalBody [role=alert]")).toContainText("Could not load");
      expect(injectedFailures).toBeGreaterThan(0);
      await expect(page.locator("#modalBody")).not.toContainText("(empty)");
      for (const endpoint of endpoints) await page.unroute("**" + endpoint);
      await page.getByRole("button", { name: "Retry", exact: true }).click();
      await expect(page.locator("#modalBody [role=alert]")).toHaveCount(0);
      if (panel === "Memory")
        await expect(page.locator("#modalBody")).toContainText("Preserved audit memory");
    });
  }
  test("unavailable interactive CLI choices are disabled before submitting", async ({ page }) => {
    await page.getByRole("button", { name: "Dashboard", exact: true }).click();
    await page.getByRole("button", { name: "+ Delegate a task", exact: true }).click();
    await expect(page.locator('#dmKind option[value="codex"]')).toBeDisabled();
    await expect(page.locator('#dmKind option[value="managed"]')).toBeEnabled();
    await expect(page.locator("#dmAvailability")).toContainText(/turned off|does not include/);
  });
  test("skill creation rejects invalid requests without overwriting existing skills", async ({
    request,
  }) => {
    for (const endpoint of ["/api/skills", "/api/skills/import", "/api/session-names"]) {
      const foreign = await request.post(lisa.baseURL + endpoint, {
        data: { name: "cross-origin", source: "codex", description: "Fixture", body: "Never save" },
        headers: { origin: "https://untrusted.example" },
      });
      expect(foreign.status()).toBe(403);
      const rebound = await request.get(lisa.baseURL + endpoint, {
        headers: { host: "untrusted.example" },
      });
      expect(rebound.status()).toBe(403);
    }
    for (const endpoint of ["/api/skills", "/api/skills/import"]) {
      const simple = await request.post(lisa.baseURL + endpoint, {
        data: JSON.stringify({
          name: "cross-origin",
          source: "codex",
          description: "Fixture",
          body: "Never save",
        }),
        headers: { "content-type": "text/plain" },
      });
      expect(simple.status()).toBe(415);
    }
    for (const payload of [
      null,
      { name: "../escape", description: "Bad", body: "Bad" },
      { name: "empty", description: "", body: "" },
    ]) {
      const response = await request.post(lisa.baseURL + "/api/skills", {
        data: payload ?? "null",
        headers: { "content-type": "application/json" },
      });
      expect(response.status()).toBe(400);
    }
    const imported = await request.post(lisa.baseURL + "/api/skills/import", {
      data: { source: "codex", name: "../../escape" },
    });
    expect(imported.status()).toBe(400);
  });
  test("coding plan discovers the configured executable, verifies login and rechecks", async ({
    page,
  }) => {
    await page.getByRole("button", { name: "Coding plans", exact: true }).click();
    const codex = page.locator("#modalBody .item").filter({ hasText: "ChatGPT plan (Codex)" });
    await expect(codex).toContainText("ready");
    await codex.getByRole("button", { name: "use this" }).click();
    await expect(codex.getByRole("button", { name: "selected", exact: true })).toBeDisabled();
    await page.getByRole("button", { name: "Recheck installed tools" }).click();
    await expect(codex).toContainText("ready");
  });
});

import { expect, test } from "@playwright/test";
import { startLisa } from "./helpers/lisa-server.js";

test("Tasks UI creates a goal with schedule/timezone/milestones and inspects capabilities", async ({
  page,
  request,
}) => {
  const lisa = await startLisa({ label: "tasks-ui" });
  try {
    // A01: /api/client-capabilities reports truthful local Mac capabilities.
    const capRes = await request.get(lisa.baseURL + "/api/client-capabilities");
    expect(capRes.status()).toBe(200);
    const caps = await capRes.json();
    expect(caps.location).toBe("mac");
    expect(caps.tasks.status).toBe("available");
    expect(caps.tasks.supportedKinds).toContain("goal");
    expect(caps.artifacts.status).toBe("available");

    // A02: Open #tasks deep link cleanly while preserving existing 3x3 nav count.
    await page.goto(lisa.baseURL + "/#tasks");
    await expect(page.locator("#viewTasks")).toHaveClass(/\bactive\b/);
    await expect(page.locator("#navList .nav-item")).toHaveCount(9);

    // Create a Goal task with schedule, IANA timezone, and milestones.
    await page.locator("#tasksNewToggle").click();
    await page.locator("#taskTitleInput").fill("Weekly architecture brief");
    await page.locator("#taskKindInput").selectOption("goal");
    await page.locator("#taskScheduleInput").fill("weekdays:09:00");
    await page.locator("#taskTzInput").fill("America/Los_Angeles");
    await page.locator("#taskInstructionInput").fill("Review open PRs and write brief.");
    await page.locator("#taskMilestonesInput").fill("Audit open PRs\nPublish brief");
    await page.locator('#tasksCreateForm button[type="submit"]').click();

    await expect(
      page.locator(".task-card", { hasText: "Weekly architecture brief" }),
    ).toBeVisible();
    await expect(page.locator("#tasksDetailPane")).toContainText(
      "weekdays:09:00 (America/Los_Angeles)",
    );
    await expect(page.locator(".goal-milestone")).toHaveCount(2);

    // Dashboard also exposes one-click Tasks entry.
    await page.locator('#navList [data-view="dashboard"]').click();
    await page.locator("#dashOpenTasks").click();
    await expect(page.locator("#viewTasks")).toHaveClass(/\bactive\b/);
  } finally {
    await lisa.stop();
  }
});

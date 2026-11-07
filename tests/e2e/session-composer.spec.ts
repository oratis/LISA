import { expect, test } from "@playwright/test";
import { startLisa, type LisaInstance } from "./helpers/lisa-server.js";
import fs from "node:fs/promises";
import path from "node:path";

test.describe("session names and image attachments", () => {
  let lisa: LisaInstance;
  test.beforeAll(async () => {
    lisa = await startLisa({ label: "session-composer" });
  });
  test.afterAll(async () => {
    await lisa?.stop();
  });

  test("rename from context menu persists, syncs windows and never switches sessions", async ({
    page,
    context,
  }) => {
    await page.goto(lisa.baseURL);
    const original = await page
      .locator(".tleaf[data-lisa-id]")
      .first()
      .getAttribute("data-lisa-id");
    await page.locator("#sbNewSession").click();
    await expect(page.locator(".tleaf[data-lisa-id]")).toHaveCount(2);
    const active = await page.locator(".tleaf.active").getAttribute("data-lisa-id");
    const other = await context.newPage();
    await other.goto(lisa.baseURL);
    await expect(other.locator(".tleaf[data-lisa-id]")).toHaveCount(2);
    const row = page.locator(`.tleaf[data-lisa-id="${original}"]`);
    await row.click({ button: "right" });
    await page.getByRole("menuitem", { name: "Rename session" }).click();
    await page.getByLabel("Session name", { exact: true }).fill("  我的项目 <design>  ");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(row.locator(".tname")).toHaveText("我的项目 <design>");
    await expect(page.locator(".tleaf.active")).toHaveAttribute("data-lisa-id", active!);
    await expect(other.locator(`[data-lisa-id="${original}"] .tname`)).toHaveText(
      "我的项目 <design>",
    );
    await page.reload();
    await expect(row.locator(".tname")).toHaveText("我的项目 <design>");
    await row.click();
    await expect(page.locator("#tabStrip .ctx-name")).toHaveText("我的项目 <design>");
    await row.focus();
    await row.press("F2");
    await page.getByLabel("Session name", { exact: true }).fill("   ");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByRole("alert")).toHaveText("Enter a name of 1–120 characters.");
    await page.keyboard.press("Escape");
    await expect(page.locator(".session-rename-dialog")).toHaveCount(0);
    await expect(row.locator(".tname")).toHaveText("我的项目 <design>");
    await other.close();
  });

  test("agent icons and custom names work in both tree views", async ({ page }) => {
    await page.route("**/api/agents/sessions", (route) =>
      route.fulfill({
        json: {
          sessions: [
            {
              agent: "claude-code",
              sessionId: "claude-example",
              project: "LISA",
              lastMtime: new Date().toISOString(),
              state: "working",
            },
            {
              agent: "codex",
              sessionId: "codex-example",
              project: "LISA",
              lastMtime: new Date().toISOString(),
              state: "working",
            },
          ],
        },
      }),
    );
    await page.goto(lisa.baseURL);
    const icons = page.locator("#sessionTree .tnode .agent-glyph img");
    await expect(icons).toHaveCount(3);
    for (const icon of await icons.all()) {
      await expect
        .poll(() => icon.evaluate((img) => (img as HTMLImageElement).naturalWidth))
        .toBe(128);
    }
    const row = page.locator('.tleaf[data-agent="codex"]');
    await row.click({ button: "right" });
    await page.getByRole("menuitem", { name: "Rename session" }).click();
    await page.getByLabel("Session name", { exact: true }).fill("Sidebar polish");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(row.locator(".tname")).toHaveText("Sidebar polish");
    await page.locator("#sbTreeMode").click();
    await expect(row.locator(".tname")).toHaveText("Sidebar polish");
    await expect(row.locator("img")).toBeVisible();
    await page.reload();
    await expect(row.locator(".tname")).toHaveText("Sidebar polish");
  });

  test("pasted images preview, open, remove and send their original bytes", async ({ page }) => {
    await page.goto(lisa.baseURL);
    const image = await fs.readFile(path.join("src/web/assets/agents/lisa.webp"));
    const data = image.toString("base64");
    await page.locator("#input").fill("Please review these images");
    await page.evaluate((base64) => {
      const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
      const clipboard = new DataTransfer();
      clipboard.items.add(new File([bytes], "pasted.webp", { type: "image/webp" }));
      document.querySelector("#input")!.dispatchEvent(
        new ClipboardEvent("paste", {
          clipboardData: clipboard,
          bubbles: true,
          cancelable: true,
        }),
      );
    }, data);
    await expect(page.locator(".attach-image img")).toHaveCount(1);
    await expect
      .poll(() =>
        page.locator(".attach-image img").evaluate((img) => (img as HTMLImageElement).naturalWidth),
      )
      .toBe(128);
    await expect(page.locator("#input")).toHaveValue("Please review these images");
    // One object URL per image, reused across re-renders (no base64 data: URL).
    const thumb = await page.locator(".attach-image img").getAttribute("src");
    expect(thumb).toMatch(/^blob:/);
    await page.getByRole("button", { name: "Preview pasted.webp" }).click();
    await expect(page.locator(".attachment-viewer img")).toHaveAttribute("src", thumb!);
    await expect(page.locator(".attachment-viewer img")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator(".attachment-viewer")).toHaveCount(0);
    await page.locator("#fileInput").setInputFiles([
      { name: "second.webp", mimeType: "image/webp", buffer: image },
      { name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("notes") },
    ]);
    await expect(page.locator(".attach-chip")).toHaveCount(3);
    await expect(page.locator(".attach-image img").first()).toHaveAttribute("src", thumb!);
    const removed = await page.locator(".attach-image img").nth(1).getAttribute("src");
    await page.getByRole("button", { name: "Remove second.webp" }).click();
    // The removed image's URL is released; the one still attached is not.
    const probe = (url: string | null) =>
      page.evaluate(
        (src) =>
          new Promise<string>((resolve) => {
            const img = new Image();
            img.onload = () => resolve("alive");
            img.onerror = () => resolve("revoked");
            img.src = src!;
          }),
        url,
      );
    expect(await probe(removed)).toBe("revoked");
    expect(await probe(thumb)).toBe("alive");
    await expect(page.locator(".attach-image")).toHaveCount(1);
    await expect(page.locator(".attach-chip")).toHaveCount(2);
    const sent = page.waitForRequest(
      (request) => request.url().endsWith("/chat") && request.method() === "POST",
    );
    await page.locator("#sendBtn").click();
    const payload = (await sent).postDataJSON();
    expect(payload.files[0]).toEqual({ name: "pasted.webp", mediaType: "image/webp", data });
    expect(payload.files[1].name).toBe("notes.txt");
    await expect(page.locator("#attachPreview")).toBeEmpty();
  });

  test("multiple image previews stay inside a phone viewport", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto(lisa.baseURL);
    const buffer = await fs.readFile(path.join("src/web/assets/agents/claude.webp"));
    await page.locator("#fileInput").setInputFiles(
      Array.from({ length: 5 }, (_, i) => ({
        name: `image-${i}.webp`,
        mimeType: "image/webp",
        buffer,
      })),
    );
    await expect(page.locator(".attach-image")).toHaveCount(5);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(375);
    await expect(page.locator("#sendBtn")).toBeInViewport();
    await page.locator(".attach-open").first().click();
    const box = await page.locator(".attachment-viewer").boundingBox();
    expect(box!.width).toBeLessThanOrEqual(375);
  });
});

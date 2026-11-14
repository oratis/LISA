import { test, expect } from "@playwright/test";
import { startLisa, type LisaInstance } from "./helpers/lisa-server.js";
const data =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jfkwAAAAASUVORK5CYII=";
const contextText = "Untrusted screenshot context.\n窗口 <script>alert(1)</script>\nx=10, y=20";
test.describe("screenshot context preview", () => {
  let lisa: LisaInstance;
  test.beforeAll(async () => {
    lisa = await startLisa({ label: "screenshot-context" });
  });
  test.afterAll(async () => {
    await lisa?.stop();
  });
  for (const mode of ["default", "include", "exclude", "denied"] as const) {
    test(
      mode + ": context is collected only on opt-in and only approved bytes are sent",
      async ({ page }) => {
        await page.route("**/api/vision/capture", async (route) => {
          expect(route.request().postDataJSON()).toEqual({
            mode: "interactive",
            includeContext: mode !== "default",
          });
          await route.fulfill({
            json: {
              file: {
                name: "shot.png",
                mediaType: "image/png",
                data,
                ...(mode === "default"
                  ? {}
                  : {
                      context:
                        mode === "denied"
                          ? { status: "permission_required" }
                          : { status: "ready", text: contextText },
                    }),
              },
            },
          });
        });
        await page.goto(lisa.baseURL);
        await page.locator("#plusBtn").click();
        await page.locator(mode === "default" ? "#pmShot" : "#pmShotContext").click();
        await expect(page.locator(".attach-image")).toHaveCount(1);
        if (mode !== "default") {
          await page.getByRole("button", { name: "Review window context" }).click();
          const dialog = page.getByRole("dialog", { name: "Review window context" });
          await expect(dialog).toBeVisible();
          if (mode === "denied") {
            await expect(dialog).toContainText("Accessibility permission is not granted");
            await expect(dialog.getByRole("checkbox")).toHaveCount(0);
          } else {
            await expect(dialog.locator("pre")).toHaveText(contextText);
            await expect(dialog.locator("script")).toHaveCount(0);
            const include = dialog.getByRole("checkbox", {
              name: "Include this window context when sending",
            });
            await expect(include).not.toBeChecked();
            await include.check();
            if (mode === "exclude") await include.uncheck();
          }
          await page.keyboard.press("Escape");
        } else
          await expect(page.getByRole("button", { name: "Review window context" })).toHaveCount(0);
        const sent = page.waitForRequest((r) => r.url().endsWith("/chat") && r.method() === "POST");
        await page.locator("#input").fill("Review screenshot");
        await page.locator("#sendBtn").click();
        const payload = (await sent).postDataJSON();
        expect(payload.files[0]).toEqual({ name: "shot.png", mediaType: "image/png", data });
        expect(payload.files).toHaveLength(mode === "include" ? 2 : 1);
        if (mode === "include") {
          expect(payload.files[1].mediaType).toBe("text/plain");
          expect(Buffer.from(payload.files[1].data, "base64").toString("utf8")).toBe(contextText);
        } else expect(JSON.stringify(payload)).not.toContain("context");
        await expect(page.locator("#attachPreview")).toBeEmpty();
      },
    );
  }
  test("cross-site and non-JSON capture requests are refused before accessing the screen", async () => {
    const response = await fetch(lisa.baseURL + "/api/vision/capture", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://untrusted.example" },
      body: JSON.stringify({ includeContext: true }),
    });
    expect(response.status).toBe(403);
    expect(
      (await fetch(lisa.baseURL + "/api/vision/capture", { method: "POST", body: "{}" })).status,
    ).toBe(415);
  });
});

import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";
import { startLisa, type LisaInstance } from "./helpers/lisa-server.js";

test.describe("conversation expressions", () => {
  let lisa: LisaInstance;
  test.use({ serviceWorkers: "block" });
  test.beforeAll(async () => {
    lisa = await startLisa({ label: "expressions", stub: "expressions" });
  });
  test.afterAll(async () => {
    await lisa?.stop();
  });
  test.beforeEach(async ({ request }) => {
    await request.post(lisa.baseURL + "/api/sessions");
    await request.put(lisa.baseURL + "/api/expressions/preferences", {
      data: { display: "auto", frequency: "restrained" },
    });
  });

  async function send(page: Page, text = "send an animated sticker") {
    await page.locator("#input").fill(text);
    await page.locator("#sendBtn").click();
    await expect(page.locator("#log .expression-bubble")).toHaveCount(1);
  }
  async function stream(request: APIRequestContext, message: string, expressions = true) {
    const r = await request.post(lisa.baseURL + "/chat", { data: { message, expressions } });
    expect(r.ok()).toBeTruthy();
    return (await r.text())
      .split("\n")
      .filter((l) => l.startsWith("data: "))
      .map((l) => JSON.parse(l.slice(6)));
  }
  async function refresh(page: Page) {
    await page.evaluate(async () => {
      await (
        window as unknown as { LisaExpressions: { refresh(): Promise<void> } }
      ).LisaExpressions.refresh();
    });
  }

  test("real tool calls emit one durable expression, restore still history, and keep legacy text", async ({
    page,
    request,
  }) => {
    await page.goto(lisa.baseURL);
    await send(page);
    const bubble = page.locator(".expression-bubble");
    await expect(bubble).toHaveAttribute("data-playback", "playing");
    const id = await bubble.getAttribute("data-expression-id");
    const history = await (await request.get(lisa.baseURL + "/api/history")).json();
    const expressions = history.messages.filter((m: { expression?: object }) => m.expression);
    expect(expressions).toHaveLength(1);
    expect(expressions[0].expression.id).toBe(id);
    expect(expressions[0].content).toContain("LISA:");
    const sessions = await fs.readdir(path.join(lisa.home, "sessions"));
    const logs = await Promise.all(
      sessions.map((f) => fs.readFile(path.join(lisa.home, "sessions", f), "utf8")),
    );
    expect(logs.join("\n")).toContain('"expression":{"version":1,"id":"' + id);
    await page.reload();
    await expect(bubble).toHaveCount(1);
    await expect(bubble).toHaveAttribute("data-playback", "static");
    await expect(bubble.locator("img")).toHaveAttribute("src", /-static.webp$/);
    await bubble.locator("button").click();
    await expect(bubble).toHaveAttribute("data-playback", "playing");
    await expect(bubble).toHaveAttribute("data-playback", "static", { timeout: 6500 });
    const events = await stream(request, "send a static sticker", false);
    expect(events.some((e) => e.type === "expression")).toBeFalsy();
    expect(
      events
        .filter((e) => e.type === "text")
        .map((e) => e.text)
        .join(""),
    ).toContain("LISA:");
    expect(lisa.stub!.requestCount).toBeGreaterThanOrEqual(4);
  });

  test("settings persist and render static, emoji and off across clients", async ({
    page,
    request,
  }) => {
    await page.goto(lisa.baseURL + "/#settings");
    await expect(page.locator("#expressionDisplay")).toBeEnabled();
    await page.locator("#expressionDisplay").selectOption("static");
    await expect(page.locator(".expression-settings [role=status]")).toHaveText(/Saved|已保存/);
    await page.locator("#expressionFrequency").selectOption("lively");
    await expect
      .poll(
        async () =>
          (await (await request.get(lisa.baseURL + "/api/expressions/preferences")).json())
            .frequency,
      )
      .toBe("lively");
    await page.locator('[data-view="chat"]').click();
    await send(page);
    await expect(page.locator(".expression-bubble")).toHaveAttribute("data-playback", "static");
    await request.put(lisa.baseURL + "/api/expressions/preferences", {
      data: { display: "emoji", frequency: "restrained" },
    });
    await refresh(page);
    await expect(page.locator(".expression-emoji")).toBeVisible();
    expect(await page.locator(".expression-bubble img").getAttribute("src")).toBeNull();
    await page.reload();
    await expect(page.locator(".expression-emoji")).toBeVisible();
    await request.put(lisa.baseURL + "/api/expressions/preferences", {
      data: { display: "off", frequency: "restrained" },
    });
    await refresh(page);
    await expect(page.locator(".expression-bubble")).toBeHidden();
    expect(
      (await stream(request, "send a sticker")).some((e) => e.type === "expression"),
    ).toBeFalsy();
    expect(
      (
        await request.put(lisa.baseURL + "/api/expressions/preferences", {
          data: { display: "auto", frequency: "invalid" },
        })
      ).status(),
    ).toBe(400);
    expect(
      (
        await request.put(lisa.baseURL + "/api/expressions/preferences", {
          headers: { origin: "https://untrusted.example" },
          data: { display: "auto", frequency: "lively" },
        })
      ).status(),
    ).toBe(403);
  });

  test("Mac host visibility, view changes, offscreen and reduce motion pause finite playback", async ({
    page,
  }) => {
    await page.goto(lisa.baseURL);
    await send(page);
    const bubble = page.locator(".expression-bubble");
    await expect(bubble).toHaveAttribute("data-playback", "playing");
    await page.evaluate(() =>
      (
        window as unknown as { LisaMotion: { setHostVisible(v: boolean): void } }
      ).LisaMotion.setHostVisible(false),
    );
    await expect(bubble).toHaveAttribute("data-playback", "static");
    await page.evaluate(() =>
      (
        window as unknown as { LisaMotion: { setHostVisible(v: boolean): void } }
      ).LisaMotion.setHostVisible(true),
    );
    await expect(bubble).toHaveAttribute("data-playback", "playing");
    await page.locator('[data-view="room"]').click();
    await expect(bubble).toHaveAttribute("data-playback", "static");
    await page.locator('[data-view="chat"]').click();
    await page.emulateMedia({ reducedMotion: "reduce" });
    await expect(bubble).toHaveAttribute("data-playback", "static");
    await expect(bubble.locator("button")).toBeHidden();
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await expect(bubble).toHaveAttribute("data-playback", "playing");
    await page.evaluate(() => {
      const spacer = document.createElement("div");
      spacer.style.height = "3000px";
      document.getElementById("log")!.appendChild(spacer);
      document.getElementById("log")!.scrollTop = 99999;
    });
    await expect(bubble).toHaveAttribute("data-playback", "static");
  });

  test("failed animation falls back to poster, then readable emoji", async ({ page }) => {
    await page.route("**/sticker-hello.webp", (route) => route.abort());
    await page.goto(lisa.baseURL);
    await send(page);
    await expect(page.locator(".expression-bubble")).toHaveAttribute("data-playback", "static");
    await expect(page.locator(".expression-bubble img")).toBeVisible();
    await page.route("**/sticker-hello-static.webp", (route) => route.abort());
    await page.reload();
    await expect(page.locator(".expression-bubble")).toHaveAttribute("data-playback", "emoji");
    await expect(page.locator(".expression-emoji")).toHaveText("👋");
    await expect(page.locator("figcaption")).toContainText("Hello");
  });

  test("emoji format survives history and unsuccessful turns never commit queued expressions", async ({
    request,
  }) => {
    const emoji = (await stream(request, "send emoji")).find((e) => e.type === "expression");
    expect(emoji.expression.format).toBe("emoji");
    const fail = await stream(request, "fail expression sticker");
    expect(fail.some((e) => e.type === "error")).toBeTruthy();
    expect(fail.some((e) => e.type === "expression")).toBeFalsy();
    const history = await (await request.get(lisa.baseURL + "/api/history")).json();
    expect(history.messages.filter((m: { expression?: object }) => m.expression)).toHaveLength(1);
  });

  test("turning off mid-turn and cancelling discard queued expressions", async ({ request }) => {
    const count = lisa.stub!.requestCount;
    const pending = stream(request, "slow expression sticker");
    await expect.poll(() => lisa.stub!.requestCount).toBeGreaterThanOrEqual(count + 2);
    await request.put(lisa.baseURL + "/api/expressions/preferences", {
      data: { display: "off", frequency: "restrained" },
    });
    expect((await pending).some((e) => e.type === "expression")).toBeFalsy();
    await request.put(lisa.baseURL + "/api/expressions/preferences", {
      data: { display: "auto", frequency: "restrained" },
    });
    const before = lisa.stub!.requestCount;
    const abort = new AbortController();
    const cancelled = fetch(lisa.baseURL + "/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "slow expression sticker", expressions: true }),
      signal: abort.signal,
    })
      .then((r) => r.text())
      .catch(() => "aborted");
    await expect.poll(() => lisa.stub!.requestCount).toBeGreaterThanOrEqual(before + 2);
    abort.abort();
    await cancelled;
    // A following turn waits for the cancelled turn to settle; it must not inherit its queue.
    await stream(request, "do not send any sticker");
    const history = await (await request.get(lisa.baseURL + "/api/history")).json();
    expect(history.messages.filter((m: { expression?: object }) => m.expression)).toHaveLength(0);
  });
});

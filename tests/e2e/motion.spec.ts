import { expect, test } from "@playwright/test";
import { startLisa, type LisaInstance } from "./helpers/lisa-server.js";

test.describe("LISA motion lifecycle", () => {
  let lisa: LisaInstance;
  test.beforeAll(async () => {
    lisa = await startLisa({ label: "motion" });
  });
  test.afterAll(async () => {
    await lisa?.stop();
  });
  test.use({ serviceWorkers: "block" });
  // The test supplies authoritative ping snapshots; hold SSE so the fixture
  // server's unrelated initial neutral mood cannot race those snapshots.
  test.beforeEach(async ({ page }) => {
    await page.route("**/events", () => {});
  });

  test("Room navigation, backgrounding and reduced motion replace animated sources", async ({
    page,
  }) => {
    await page.route("**/api/island/ping", (route) =>
      route.fulfill({ json: { online: true, mood: "working-coding" } }),
    );
    await page.goto(lisa.baseURL);
    await expect(page.locator("#mascot")).toHaveAttribute("data-motion-state", "playing");
    await page.locator('[data-view="room"]').click();
    const room = page.frameLocator("#roomFrame");
    const image = room.locator("#lisa-motion");
    await expect(image).toHaveAttribute("data-motion-clip", "typing");
    await expect(image).toHaveAttribute("data-motion-state", "playing");
    await expect(room.locator("#lisa")).toHaveClass(/motion-ready/);
    await expect(image).toBeVisible();
    await page.locator('[data-view="chat"]').click();
    await expect(image).toHaveAttribute("src", /typing-static.webp$/);
    await expect(room.locator("body")).toHaveClass(/art-paused/);
    await page.locator('[data-view="room"]').click();
    await expect(image).toHaveAttribute("data-motion-state", "playing");
    await page.emulateMedia({ reducedMotion: "reduce" });
    await expect(image).toHaveAttribute("src", /typing-static.webp$/);
    await expect(page.locator("#mascot")).toHaveAttribute("data-motion-state", "static");
    expect(
      await room
        .locator("#notes span")
        .first()
        .evaluate((el) => getComputedStyle(el).animationName),
    ).toBe("none");
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await expect(image).toHaveAttribute("data-motion-state", "playing");
    await page.evaluate(() => {
      Object.defineProperty(document, "hidden", { configurable: true, value: true });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await expect(image).toHaveAttribute("src", /typing-static.webp$/);
    await expect(page.locator("#mascot")).toHaveAttribute("data-motion-state", "static");
    await page.evaluate(() => {
      Object.defineProperty(document, "hidden", { configurable: true, value: false });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await expect(image).toHaveAttribute("data-motion-state", "playing");
  });

  test("repeated host visibility reports do not reset the Room", async ({ page }) => {
    await page.route("**/api/island/ping", (route) =>
      route.fulfill({ json: { online: true, mood: "neutral" } }),
    );
    await page.goto(lisa.baseURL + "/#room");
    await expect(page.frameLocator("#roomFrame").locator("#lisa-motion")).toHaveAttribute(
      "data-motion-state",
      "playing",
    );
    const room = page.frame({ url: /\/room$/ })!;
    type Counted = Window & { motionEvents: number };
    await room.evaluate(() => {
      (window as unknown as Counted).motionEvents = 0;
      window.addEventListener("lisa-motion-change", () => {
        (window as unknown as Counted).motionEvents++;
      });
    });
    // macOS reports every window's occlusion change and the shell re-posts on
    // each view switch. Neither is a transition, so nothing may restart.
    await page.evaluate(() => {
      const motion = (window as unknown as { LisaMotion: { setHostVisible(v: boolean): void } })
        .LisaMotion;
      motion.setHostVisible(true);
      motion.setHostVisible(true);
    });
    await page.locator('.nav-item[data-view="room"]').click();
    await page.locator('.nav-item[data-view="chat"]').click();
    await expect(page.frameLocator("#roomFrame").locator("body")).toHaveClass(/art-paused/);
    expect(await room.evaluate(() => (window as unknown as Counted).motionEvents)).toBe(1);
  });

  test("all six Room actions follow real moods and keep the atlas fallback", async ({ page }) => {
    let mood = "reading-book";
    await page.route("**/api/island/ping", (route) =>
      route.fulfill({ json: { online: true, mood } }),
    );
    for (const [slug, clip] of [
      ["reading-book", "room-reading"],
      ["drinking-tea", "room-tea"],
      ["stretching", "stretching"],
      ["listening-music", "listening"],
      ["working-coding", "typing"],
      ["napping", "sleeping"],
    ]) {
      mood = slug!;
      await page.goto(lisa.baseURL + "/room");
      await expect(page.locator("#lisa-motion")).toHaveAttribute("data-motion-clip", clip!);
      await expect(page.locator("#lisa")).toHaveClass(/motion-ready/);
      await expect(page.locator("#lisa-motion")).toBeVisible();
    }
    await page.route("**/soft-ink-motion-v1/*", (route) => route.fulfill({ status: 404 }));
    await page.reload();
    await expect(page.locator("#lisa-wrap")).toHaveAttribute("data-pose", "sleep");
    await expect(page.locator("#lisa-motion")).toHaveAttribute("data-motion-clip", "sleeping");
    await expect(page.locator("#lisa-motion")).toHaveAttribute("data-motion-state", "fallback");
    await expect(page.locator("#lisa")).not.toHaveClass(/motion-ready/);
    expect(
      await page.locator("#lisa").evaluate((el) => getComputedStyle(el).backgroundImage),
    ).toContain("soft-ink-room-v2/sleep.webp");
  });

  test("portrait errors fall through poster to atlas; late requests cannot restart paused motion", async ({
    page,
  }) => {
    await page.route("**/soft-ink-motion-v1/*", (route) => route.fulfill({ status: 404 }));
    await page.goto(lisa.baseURL);
    const portrait = page.locator("#mascot");
    await expect(portrait).toHaveAttribute("data-motion-state", "fallback");
    await expect(portrait).toHaveAttribute("src", /^data:image\/png/);
    expect(await portrait.evaluate((el) => (el as HTMLImageElement).naturalWidth)).toBeGreaterThan(
      0,
    );
    await page.unroute("**/soft-ink-motion-v1/*");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route("**/happy.webp", async (route) => {
      await gate;
      await route.continue().catch(() => {});
    });
    await page.evaluate(async () => {
      const w = window as unknown as {
        LisaArt: { portrait(el: Element, slug: string): Promise<boolean> };
      };
      await w.LisaArt.portrait(document.getElementById("mascot")!, "happy");
    });
    await expect(portrait).toHaveAttribute("data-motion-clip", "happy");
    await page.emulateMedia({ reducedMotion: "reduce" });
    release();
    await expect(portrait).toHaveAttribute("src", /happy-static.webp$/);
    await page.evaluate(async () => {
      const w = window as unknown as {
        LisaArt: { portrait(el: Element, slug: string): Promise<boolean> };
      };
      await Promise.all([
        w.LisaArt.portrait(document.getElementById("mascot")!, "happy"),
        w.LisaArt.portrait(document.getElementById("mascot")!, "sad"),
      ]);
    });
    await expect(portrait).toHaveAttribute("data-motion-state", "static");
    await expect(portrait).toHaveAttribute("data-motion-clip", "sad");
  });

  test("both rooms' object effects and the gramophone share the motion lifecycle", async ({
    page,
  }) => {
    await page.addInitScript(() => {
      const Base = window.Audio;
      window.Audio = class extends Base {
        constructor() {
          super();
          (window as unknown as { testRoomAudio: HTMLAudioElement }).testRoomAudio = this;
        }
      };
    });
    await page.route("**/api/island/ping", (route) =>
      route.fulfill({ json: { online: true, mood: "neutral" } }),
    );
    await page.goto(lisa.baseURL + "/room");
    await expect(page.locator("#room-details .room-detail")).toHaveCount(19);
    await page.evaluate(() =>
      (window as unknown as { testRoomAudio: HTMLAudioElement }).testRoomAudio.dispatchEvent(
        new Event("play"),
      ),
    );
    await expect(page.locator("#gramophone-motion")).toHaveAttribute(
      "data-motion-state",
      "playing",
    );
    await page.emulateMedia({ reducedMotion: "reduce" });
    await expect(page.locator("#gramophone-motion")).toHaveAttribute(
      "src",
      /gramophone-static.webp$/,
    );
    expect(
      await page
        .locator(".detail-leaves")
        .first()
        .evaluate((el) => getComputedStyle(el).animationName),
    ).toBe("none");
    await page.evaluate(() =>
      (window as unknown as { testRoomAudio: HTMLAudioElement }).testRoomAudio.dispatchEvent(
        new Event("pause"),
      ),
    );
    await expect(page.locator("#gramophone-motion")).toHaveAttribute(
      "data-motion-state",
      "fallback",
    );
    await page.evaluate(() => localStorage.setItem("lisa-room-theme", "room2"));
    await page.reload();
    await expect(page.locator("#room-details .room-detail")).toHaveCount(23);
    await expect(page.locator("body")).toHaveAttribute("data-room", "room2");
  });

  test("all portrait and sticker choices load; reduced motion avoids animation downloads", async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    const animated: string[] = [];
    page.on("request", (request) => {
      const url = request.url();
      if (url.includes("soft-ink-motion-v1/") && /(?<!-static)\.webp$/.test(url))
        animated.push(url);
    });
    await page.goto(lisa.baseURL + "/assets/visuals/soft-ink-v1/gallery.html");
    await expect(page.locator("#expressions img")).toHaveCount(24);
    await expect(page.locator("#stickers img")).toHaveCount(8);
    for (const image of await page.locator("#expressions img, #stickers img").all()) {
      await expect(image).toHaveAttribute("data-motion-state", "static");
      await expect
        .poll(() => image.evaluate((el) => (el as HTMLImageElement).naturalWidth))
        .toBeGreaterThan(0);
    }
    expect(animated).toEqual([]);
    // Latest request wins: a pose whose atlas crop resolves later must not
    // replace a sticker the caller asked for afterwards.
    expect(
      await page.evaluate(async () => {
        const art = (
          window as unknown as {
            LisaArt: {
              pose(el: Element, index: number, size: number): Promise<boolean>;
              sticker(el: Element, index: number, fallback: string): void;
            };
          }
        ).LisaArt;
        const img = document.body.appendChild(document.createElement("img"));
        const pending = art.pose(img, 0, 384);
        art.sticker(img, 1, "stickers/lisa-well-done.png");
        await pending;
        return img.dataset.motionClip;
      }),
    ).toBe("sticker-well-done");
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await page.locator("#stickers").scrollIntoViewIfNeeded();
    await expect(page.locator("#stickers img").first()).toHaveAttribute(
      "data-motion-state",
      "playing",
    );
    await expect(page.locator("#expressions img").first()).toHaveAttribute(
      "data-motion-state",
      "static",
    );
  });
});

import { expect, test, type Page } from "@playwright/test";
import { startLisa, type LisaInstance } from "./helpers/lisa-server.js";

/**
 * Breakpoint smoke for the three viewports UX-2 measured: phone (375×812),
 * tablet (768×1024) and desktop (1440×900), each with the right rail collapsed
 * (the v0.24 default, #367) and expanded.
 *
 * UX-2 found that at 375px `body.rb-collapsed .frame` (specificity 0,1,1) beats
 * the ≤720px media query (0,0,1), so the main pane collapses to 75px and the
 * send button lands off-screen. Those assertions are live here now that
 * the UX stream lands the fix; everything else runs today.
 */
const VIEWPORTS = [
  { name: "phone", width: 375, height: 812 },
  { name: "tablet", width: 768, height: 1024 },
  { name: "desktop", width: 1440, height: 900 },
] as const;

/** Collapsed is the default; the value is what localStorage stores. */
async function setRail(page: Page, state: "collapsed" | "open", baseURL: string): Promise<void> {
  await page.goto(baseURL);
  await page.evaluate((v) => localStorage.setItem("lisaRightbar", v), state);
  await page.reload();
  await expect(page.locator("#form #input")).toBeVisible();
  if (state === "collapsed") {
    await expect(page.locator("body")).toHaveClass(/\brb-collapsed\b/);
  } else {
    await expect(page.locator("body")).not.toHaveClass(/\brb-collapsed\b/);
  }
}

test.describe("layout breakpoints", () => {
  let lisa: LisaInstance;

  test.beforeAll(async () => {
    lisa = await startLisa({ label: "layout" });
  });
  test.afterAll(async () => {
    await lisa?.stop();
  });

  for (const vp of VIEWPORTS) {
    for (const rail of ["collapsed", "open"] as const) {
      test(`${vp.name} ${vp.width}x${vp.height} · rail ${rail} · page does not scroll sideways`, async ({
        page,
      }) => {
        await page.setViewportSize({ width: vp.width, height: vp.height });
        await setRail(page, rail, lisa.baseURL);

        const doc = await page.evaluate(() => ({
          scrollWidth: document.documentElement.scrollWidth,
          clientWidth: document.documentElement.clientWidth,
        }));
        expect(doc.scrollWidth).toBeLessThanOrEqual(doc.clientWidth);
      });

      test(`${vp.name} ${vp.width}x${vp.height} · rail ${rail} · shell regions render`, async ({
        page,
      }) => {
        await page.setViewportSize({ width: vp.width, height: vp.height });
        await setRail(page, rail, lisa.baseURL);

        // Whatever the width, these three exist and have non-zero area.
        for (const sel of [".main", "#viewChat", "#form"]) {
          const box = await page.locator(sel).boundingBox();
          expect(box, `${sel} has a box`).not.toBeNull();
          expect(box!.width, `${sel} width`).toBeGreaterThan(0);
        }
      });
    }
  }

  // ── UX-2: the two assertions that used to fail on the shipped CSS ────────
  //
  // They were test.fixme while the fix lived on another branch. It landed —
  // `body.rb-collapsed .frame` is scoped to min-width:721px, #viewChat pins its
  // column to minmax(0,1fr), and #fnbar sheds its quick-panel buttons below
  // 720px — so these are live, and they are what stops the regression from
  // coming back.
  for (const rail of ["collapsed", "open"] as const) {
    test(`UX-2 · phone 375 · rail ${rail} · .main fills the viewport and SEND is on screen`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: 375, height: 812 });
      await setRail(page, rail, lisa.baseURL);

      const main = await page.locator(".main").boundingBox();
      expect(main).not.toBeNull();
      expect(main!.width).toBe(375);

      const send = await page.locator("#sendBtn").boundingBox();
      expect(send).not.toBeNull();
      expect(send!.x).toBeGreaterThanOrEqual(0);
      expect(send!.x + send!.width).toBeLessThanOrEqual(375);
      await expect(page.locator("#sendBtn")).toBeInViewport();

      const main2 = await page.evaluate(() => {
        const el = document.querySelector(".main") as HTMLElement;
        return { scrollWidth: el.scrollWidth, clientWidth: el.clientWidth };
      });
      expect(main2.scrollWidth).toBeLessThanOrEqual(main2.clientWidth);
    });
  }

  test("tablet 768 and desktop 1440 already give the main pane real width", async ({ page }) => {
    for (const width of [768, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await setRail(page, "collapsed", lisa.baseURL);
      const main = await page.locator(".main").boundingBox();
      expect(main, `main box at ${width}`).not.toBeNull();
      // The sidebar is 300px; anything less than that means the grid collapsed.
      expect(main!.width, `main width at ${width}`).toBeGreaterThan(300);
    }
  });
});

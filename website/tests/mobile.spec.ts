import { expect, test } from "@playwright/test";

const routes = ["/", "/install", "/cloud", "/moods", "/changelog", "/privacy", "/support"];

for (const prefix of ["", "/zh-CN"]) {
  for (const route of routes) {
    test(`${prefix}${route} fits phone, tablet and desktop widths`, async ({ page }) => {
      const failures: string[] = [];
      page.on("pageerror", (error) => failures.push(error.message));
      page.on("response", (response) => {
        if (response.status() >= 400) failures.push(`${response.status()} ${response.url()}`);
      });
      await page.goto(`${prefix}${route}`);
      await expect(page.locator(".topbar")).toHaveAttribute("data-navigation", "ready");
      await page.evaluate(() => document.fonts.ready);
      for (const width of [320, 375, 430, 768, 1440]) {
        await page.setViewportSize({ width, height: 844 });
        await expect(page.locator("h1")).toBeVisible();
        const layout = await page.evaluate(() => ({
          width: document.documentElement.clientWidth,
          scrollWidth: document.documentElement.scrollWidth,
          headerHeight: document.querySelector(".topbar")!.getBoundingClientRect().height,
          clippedButtons: Array.from(
            document.querySelectorAll<HTMLElement>(
              ".main a[class*='btn-'], .footer a[class*='btn-']",
            ),
          )
            .filter(
              (el) =>
                el.getBoundingClientRect().right > innerWidth + 1 ||
                el.getBoundingClientRect().left < -1 ||
                el.scrollWidth > el.clientWidth + 1,
            )
            .map((el) => el.textContent),
        }));
        expect(layout.scrollWidth, `page overflow at ${width}px`).toBeLessThanOrEqual(
          layout.width + 1,
        );
        expect(layout.clippedButtons, `clipped actions at ${width}px`).toEqual([]);
        if (width <= 1200) {
          expect(layout.headerHeight).toBeLessThanOrEqual(68);
          await expect(page.locator(".menu-toggle")).toBeVisible();
          const targets = await page
            .locator(".topbar .brand, .topbar .lang, .menu-toggle")
            .evaluateAll((els) => els.map((el) => el.getBoundingClientRect().height));
          expect(targets.every((height) => height >= 44)).toBe(true);
        } else {
          await expect(page.locator(".menu-toggle")).toBeHidden();
          await expect(page.locator(".topbar > .nav")).toBeVisible();
        }
      }
      expect(failures).toEqual([]);
    });
  }

  test(`${prefix || "en"} menu supports touch, keyboard, backdrop and navigation`, async ({
    page,
  }) => {
    await page.goto(`${prefix}/`);
    const toggle = page.locator(".menu-toggle");
    const menu = page.getByRole("dialog");
    await toggle.tap();
    await expect(menu).toBeVisible();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(page.locator(".menu-close")).toBeFocused();
    await expect(menu.locator('[aria-current="page"]')).toHaveAttribute("href", `${prefix}/`);
    // Native dialogs can yield focus to browser chrome (activeElement is body),
    // but cannot focus the inert page behind the menu.
    for (let i = 0; i < 24; i++) {
      await page.keyboard.press(i < 12 ? "Tab" : "Shift+Tab");
      expect(
        await menu.evaluate(
          (el) => document.activeElement === document.body || el.contains(document.activeElement),
        ),
      ).toBe(true);
    }
    await page
      .locator(".main a")
      .first()
      .evaluate((el: HTMLAnchorElement) => el.focus());
    expect(await page.locator(".main").evaluate((el) => el.contains(document.activeElement))).toBe(
      false,
    );
    await page.keyboard.press("Escape");
    await expect(menu).not.toBeVisible();
    await expect(toggle).toBeFocused();
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(page.locator("html")).not.toHaveClass(/menu-open/);
    await toggle.tap();
    await page.touchscreen.tap(10, 820);
    await expect(menu).not.toBeVisible();
    await toggle.tap();
    await page.locator(".menu-close").tap();
    await expect(menu).not.toBeVisible();
    await toggle.tap();
    await menu.locator(`a[href="${prefix}/cloud"]`).tap();
    await expect(page).toHaveURL(new RegExp(`${prefix}/cloud/?$`));
    await expect(menu).not.toBeVisible();
    await expect(page.locator(".topbar .lang")).toHaveAttribute(
      "href",
      prefix ? /^\/cloud\/?$/ : /^\/zh-CN\/cloud\/?$/,
    );
    await page.locator(".topbar .lang").tap();
    await expect(page.locator("html")).toHaveAttribute("lang", prefix ? "en" : "zh-CN");
  });

  test(`${prefix || "en"} comparison keeps every value readable without side scrolling`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 320, height: 700 });
    await page.goto(`${prefix}/cloud`);
    const table = page.getByRole("table").first();
    await expect(table.getByRole("rowheader")).toHaveCount(7);
    await expect(table.getByRole("cell")).toHaveCount(14);
    await expect(table.locator(".cell-label")).toHaveCount(14);
    const clipped = await table
      .getByRole("cell")
      .evaluateAll((els) =>
        els.some(
          (el) =>
            el.scrollWidth > el.clientWidth + 1 || el.getBoundingClientRect().right > innerWidth,
        ),
      );
    expect(clipped).toBe(false);
    for (const label of await table.locator(".cell-label").all()) await expect(label).toBeVisible();
  });

  test(`${prefix || "en"} credit packs retain their labels and values on phones`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 320, height: 700 });
    await page.goto(`${prefix}/cloud`);
    const packs = page.getByRole("table", { name: prefix ? "充值包" : "Credit pack", exact: true });
    await expect(packs.getByRole("columnheader")).toHaveCount(3);
    await expect(packs.getByRole("rowheader")).toHaveCount(3);
    await expect(packs.getByRole("cell")).toHaveCount(6);
    for (const row of await packs.locator("tbody tr").all()) {
      await expect(row.locator(".cell-label")).toHaveCount(3);
      for (const label of await row.locator(".cell-label").all()) await expect(label).toBeVisible();
      expect(
        await row.evaluate(
          (el) =>
            el.scrollWidth <= el.clientWidth && el.getBoundingClientRect().right <= innerWidth,
        ),
      ).toBe(true);
    }
    for (const price of ["$4.99", "$9.99", "$19.99"])
      await expect(packs.getByRole("rowheader", { name: price, exact: true })).toHaveCount(1);
    await expect(packs.getByRole("cell", { name: "$5.00", exact: true })).toHaveCount(1);
    await expect(
      packs.getByRole("cell", { name: prefix ? "$1.20 / 天" : "$1.20 / day", exact: true }),
    ).toHaveCount(1);
  });

  test(`${prefix || "en"} installation anchors clear the header and code stays scrollable`, async ({
    page,
    browserName,
  }) => {
    await page.setViewportSize({ width: 320, height: 700 });
    await page.goto(`${prefix}/install`);
    const cdp = browserName === "chromium" ? await page.context().newCDPSession(page) : null;
    for (const top of cdp ? [0, 59] : [0]) {
      if (cdp)
        await cdp.send("Emulation.setSafeAreaInsetsOverride", {
          insets: { top, bottom: 34, left: 0, right: 0 },
        });
      await page.locator('.toc a[href="#cli"]').tap();
      const headerBottom = await page
        .locator(".topbar")
        .evaluate((el) => el.getBoundingClientRect().bottom);
      const sectionTop = await page
        .locator("#cli")
        .evaluate((el) => el.getBoundingClientRect().top);
      expect(headerBottom).toBeGreaterThanOrEqual(top + 44);
      expect(sectionTop).toBeGreaterThanOrEqual(headerBottom);
      expect(sectionTop).toBeLessThan(180);
    }
    const scrollable = page.locator("pre").filter({ hasText: "npm install" }).first();
    expect(await scrollable.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
    await scrollable.evaluate((el) => {
      el.scrollLeft = 80;
    });
    expect(await scrollable.evaluate((el) => el.scrollLeft)).toBeGreaterThan(0);
  });
}

test("menu survives rotation and releases focus when switching to desktop", async ({ page }) => {
  await page.goto("/");
  await page.locator(".menu-toggle").tap();
  await page.setViewportSize({ width: 844, height: 390 });
  const menu = page.getByRole("dialog");
  const lastAction = menu.locator(".menu-actions a").last();
  await lastAction.scrollIntoViewIfNeeded();
  await expect(lastAction).toBeInViewport();
  expect(await menu.evaluate((el) => el.getBoundingClientRect().bottom)).toBeLessThanOrEqual(390);
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(menu).not.toBeVisible();
  await expect(page.locator("html")).not.toHaveClass(/menu-open/);
  await expect(page.locator(".topbar .brand")).toBeFocused();
  await page.setViewportSize({ width: 375, height: 812 });
  await page.locator(".menu-toggle").tap();
  await expect(menu).toBeVisible();
});

test("navigation remains available without JavaScript", async ({ browser, baseURL }) => {
  const context = await browser.newContext({
    javaScriptEnabled: false,
    viewport: { width: 375, height: 812 },
  });
  const page = await context.newPage();
  await page.goto(`${baseURL}/`);
  await expect(page.locator(".topbar > .nav")).toBeVisible();
  await page.locator('.topbar > .nav a[href="/install"]').click();
  await expect(page).toHaveURL(/\/install\/?$/);
  await context.close();
});

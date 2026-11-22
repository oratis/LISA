import { test, expect } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";
import { startLisa } from "./helpers/lisa-server.js";

test.use({ locale: "zh-CN" });

test("CSV preview saves only explicitly selected games and columns, then asks for model access", async ({
  page,
}) => {
  const lisa = await startLisa({ label: "game-import" });
  try {
    const posted: string[] = [];
    page.on("request", (req) => {
      if (req.method() === "POST") posted.push(req.postData() ?? "");
    });
    await page.goto(lisa.baseURL);
    await page.locator("#sbNewSession").click();
    await page.locator("#input").fill("按来源整理我从 Playnite CSV 清单中选定的游戏。");
    await page.locator("#sendBtn").click();
    const cards = page.locator('[data-connector-key^="game-library:"]');
    const card = cards.first();
    const downloading = page.waitForEvent("download");
    await card.getByRole("link", { name: "下载 CSV 模板" }).click();
    const template = await downloading;
    expect(template.suggestedFilename()).toBe("lisa-game-library-template.csv");
    expect(await fs.readFile(await template.path(), "utf8")).toContain(
      "标题,来源,平台,版本,游玩秒数",
    );
    const choose = card.getByLabel("选择游戏库 CSV");
    await choose.setInputFiles({
      name: "fixture.csv",
      mimeType: "text/csv",
      buffer: Buffer.from(
        "名称,来源,游玩时间,备注\r\n同名,Steam,7200,PRIVATE-NOTE\r\n同名,GOG,9000,PRIVATE-NOTE\r\n仅本机游戏,PlayStation,,PRIVATE-NOTE\r\n",
      ),
    });
    await expect(card.getByText("共 3 款 · 已选 0 款 · 第 1/1 页")).toBeVisible();
    await card.getByRole("checkbox", { name: "游玩时长（秒）", exact: true }).uncheck();
    await card.getByRole("checkbox", { name: /#1.*同名.*Steam/ }).check();
    await card.getByRole("checkbox", { name: /#2.*同名.*GOG/ }).check();
    expect(posted.join(" ")).not.toMatch(/PRIVATE-NOTE|仅本机游戏|7200|9000/);
    const authorizing = page.waitForRequest(
      (req) => req.url().endsWith("/authorize") && req.method() === "POST",
    );
    await card.getByRole("button", { name: "将所选游戏保存在本机" }).click();
    expect((await authorizing).postDataJSON()).toEqual({
      mode: "import",
      games: [
        { title: "同名", source: "Steam" },
        { title: "同名", source: "GOG" },
      ],
    });
    const confirm = card.getByRole("button", { name: "只读连接并继续" });
    await expect(confirm).toBeDisabled();
    const storeFile = path.join(lisa.home, "warden", "game-library", "snapshots.enc.json");
    expect(await fs.readFile(storeFile, "utf8")).not.toMatch(/Steam|GOG|PRIVATE-NOTE/);
    expect(lisa.stub?.requestCount).toBe(0);
    await page.reload();
    await card.getByRole("checkbox", { name: /#1.*同名.*Steam/ }).check();
    await confirm.click();
    await expect(card.getByText("原任务已完成", { exact: true })).toBeVisible();
    const stateFile = path.join(lisa.home, "connectors", "game-library", "state.json");
    const state = JSON.parse(await fs.readFile(stateFile, "utf8"));
    expect(state.connection.resources).toHaveLength(1);
    expect(state.connection.resources[0].name).toContain("Steam");
    expect(state.connection.resources[0].name).not.toContain("GOG");
    const callsAfterFirstFile = lisa.stub?.requestCount;
    await page.locator("#input").fill("导入我的新 Playnite CSV 游戏清单。");
    await page.locator("#sendBtn").click();
    await expect(cards).toHaveCount(2);
    await expect(cards.last().getByLabel("选择游戏库 CSV")).toBeVisible();
    expect(lisa.stub?.requestCount).toBe(callsAfterFirstFile);
    await card.getByRole("button", { name: "断开 LISA 连接" }).click();
    await expect
      .poll(async () => Object.keys(JSON.parse(await fs.readFile(storeFile, "utf8")).secrets))
      .toHaveLength(0);
    expect(await fs.readFile(stateFile, "utf8")).not.toMatch(/Steam|GOG|PRIVATE-NOTE/);
  } finally {
    await lisa.stop();
  }
});

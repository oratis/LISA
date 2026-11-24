import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { homeScope } from "../../paths.js";
import { setRoomTheme } from "../../room/store.js";
import { handleRoomRoutes } from "./room-routes.js";

describe("handleRoomRoutes", () => {
  test("serves /room HTML, /api/room/decor state, and music playlist with Range streaming", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "lisa-room-routes-"));
    const musicDir = path.join(tmp, "bundled-music");
    await fs.mkdir(musicDir, { recursive: true });
    await fs.writeFile(path.join(musicDir, "01-lofi-rain.mp3"), Buffer.from("0123456789ABCDEF"));
    await fs.writeFile(
      path.join(musicDir, "manifest.json"),
      JSON.stringify([
        {
          id: "lofi-rain",
          title: "Lo-fi Rain",
          mood: "light",
          file: "01-lofi-rain.mp3",
          license: "CC0",
        },
      ]),
    );
    await setRoomTheme("rainy-window", tmp);

    const server = http.createServer((req, res) => {
      void homeScope.run(tmp, () =>
        handleRoomRoutes(req, res, req.url ?? "/", { musicDir, home: tmp }).then((handled) => {
          if (!handled) {
            res.writeHead(404);
            res.end();
          }
        }),
      );
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address();
    assert.ok(addr && typeof addr !== "string");
    const base = `http://127.0.0.1:${addr.port}`;

    try {
      const roomRes = await fetch(`${base}/room`);
      assert.equal(roomRes.status, 200);
      assert.match(roomRes.headers.get("content-type") ?? "", /text\/html/);
      assert.ok((await roomRes.text()).includes("Lisa · room"));

      const decorRes = await fetch(`${base}/api/room/decor`);
      assert.equal(decorRes.status, 200);
      const decor = (await decorRes.json()) as { theme: string; items: unknown[] };
      assert.equal(decor.theme, "rainy-window");
      assert.deepEqual(decor.items, []);

      const listRes = await fetch(`${base}/api/room/music`);
      assert.equal(listRes.status, 200);
      const tracks = (await listRes.json()) as Array<{ id: string }>;
      assert.equal(tracks.length, 1);

      const rangeRes = await fetch(
        `${base}/api/room/music/file/${encodeURIComponent(tracks[0]!.id)}`,
        {
          headers: { range: "bytes=2-5" },
        },
      );
      assert.equal(rangeRes.status, 206);
      assert.equal(await rangeRes.text(), "2345");

      const badRange = await fetch(
        `${base}/api/room/music/file/${encodeURIComponent(tracks[0]!.id)}`,
        {
          headers: { range: "bytes=999-1000" },
        },
      );
      assert.equal(badRange.status, 416);

      const missing = await fetch(`${base}/api/room/music/file/no-such-id`);
      assert.equal(missing.status, 404);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });
});

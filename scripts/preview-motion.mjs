/** Local, isolated artwork review. No access to the user's LISA state. */
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { ROOM_HTML } from "../dist/web/room.js";
const root = path.resolve(import.meta.dirname, "..");
const port = Number(process.argv[2] || 8768);
const doc = path.join(root, "docs/design/2026-11-07-motion-samples");
const mime = {
  ".js": "application/javascript",
  ".json": "application/json",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".png": "image/png",
  ".html": "text/html; charset=utf-8",
};
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://127.0.0.1:" + port);
  const ref = new URL(req.headers.referer || url.origin);
  const mood = ref.searchParams.get("mood") || "neutral";
  try {
    res.setHeader("Cache-Control", "no-store");
    if (url.pathname === "/events") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("data: " + JSON.stringify({ type: "mood", slug: mood }) + "\n\n");
      return;
    }
    if (url.pathname === "/api/island/ping") {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ online: true, mood }));
      return;
    }
    if (url.pathname === "/api/room/music") {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ tracks: [] }));
      return;
    }
    if (url.pathname === "/preview/room") {
      const theme = url.searchParams.get("theme") === "room2" ? "room2" : "room";
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end(
        ROOM_HTML.replace(
          "<script>",
          '<script>localStorage.setItem("lisa-room-theme",' + JSON.stringify(theme) + ");\n",
        ),
      );
      return;
    }
    let file;
    if (url.pathname === "/") file = path.join(doc, "full.html");
    else if (url.pathname === "/preview/report.json")
      file = path.join(doc, "production-report.json");
    else if (url.pathname.startsWith("/assets/")) {
      file = path.resolve(root, "src/web/assets", url.pathname.slice(8));
      if (!file.startsWith(path.join(root, "src/web/assets") + path.sep)) {
        res.writeHead(400).end();
        return;
      }
    } else {
      res.writeHead(404).end();
      return;
    }
    res.setHeader("Content-Type", mime[path.extname(file)] || "application/octet-stream");
    res.end(await fs.readFile(file));
  } catch {
    res.writeHead(404).end();
  }
});
server.listen(port, "127.0.0.1", () => console.log("LISA motion review: http://127.0.0.1:" + port));

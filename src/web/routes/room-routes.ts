/**
 * Cohesive HTTP route module for Lisa's Room (`/room`, `/api/room/decor`,
 * `/api/room/music`, `/api/room/music/file/:id`).
 *
 * Extracted from `src/web/server.ts` so Room HTML, sovereign room decor, and
 * gramophone Range streaming stay self-contained without bloating the main
 * request dispatcher.
 */
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import type http from "node:http";
import { lisaHome } from "../../paths.js";
import { readRoomDecor } from "../../room/store.js";
import { ROOM_HTML } from "../room.js";
import { listRoomMusic, toPublicTrack } from "../room-music.js";

export interface RoomRouteOptions {
  musicDir: string;
  home?: string;
}

export async function handleRoomRoutes(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: string,
  opts: RoomRouteOptions,
): Promise<boolean> {
  if (req.method !== "GET") return false;

  if (url === "/room" || url.startsWith("/room?")) {
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    });
    res.end(ROOM_HTML);
    return true;
  }

  if (url === "/api/room/decor" || url.startsWith("/api/room/decor?")) {
    const state = await readRoomDecor(opts.home ?? lisaHome());
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify(state));
    return true;
  }

  if (url === "/api/room/music") {
    const tracks = (await listRoomMusic(opts.musicDir)).map(toPublicTrack);
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify(tracks));
    return true;
  }

  if (url.startsWith("/api/room/music/file/")) {
    let id: string;
    try {
      id = decodeURIComponent(url.slice("/api/room/music/file/".length));
    } catch {
      res.writeHead(400, { "content-type": "text/plain" });
      res.end("invalid track id");
      return true;
    }
    const track = (await listRoomMusic(opts.musicDir)).find((t) => t.id === id);
    if (!track) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("no such track");
      return true;
    }
    try {
      const total = (await fs.stat(track.filePath)).size;
      const base = {
        "content-type": "audio/mpeg",
        "accept-ranges": "bytes",
        "cache-control": "public, max-age=86400",
      };
      const range = req.headers.range;
      const m = range ? /^bytes=(\d*)-(\d*)$/.exec(range.trim()) : null;
      if (m) {
        let start = m[1] ? parseInt(m[1], 10) : 0;
        let end = m[2] ? parseInt(m[2], 10) : total - 1;
        if (!Number.isFinite(start) || start < 0) start = 0;
        if (!Number.isFinite(end) || end >= total) end = total - 1;
        if (start > end || start >= total) {
          res.writeHead(416, { "content-range": `bytes */${total}` });
          res.end();
          return true;
        }
        res.writeHead(206, {
          ...base,
          "content-range": `bytes ${start}-${end}/${total}`,
          "content-length": String(end - start + 1),
        });
        createReadStream(track.filePath, { start, end }).pipe(res);
      } else {
        res.writeHead(200, { ...base, "content-length": String(total) });
        createReadStream(track.filePath).pipe(res);
      }
    } catch {
      res.writeHead(404);
      res.end();
    }
    return true;
  }

  return false;
}

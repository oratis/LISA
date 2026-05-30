import http from "node:http";
import path from "node:path";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { runAgent } from "../agent.js";
import { saveConfigEnv } from "../env.js";
import { runIdleOnce } from "../idle/runner.js";
import { getIdleWatcher } from "../idle/watcher.js";
import { moodBus } from "../mood-bus.js";
import { providerForModel } from "../providers/registry.js";
import { buildSystemPromptSnapshot, getPromptFingerprint } from "../prompt.js";
import {
  readActiveWebSession,
  writeActiveWebSession,
} from "../sessions/active.js";
import { listSessionsOnDisk } from "../sessions/list.js";
import { SessionStore } from "../sessions/store.js";
import { reflectOnSession } from "../reflect.js";
import { listDesires } from "../soul/store.js";
import { ISLAND_HTML } from "./island.js";
import { MAIN_HTML } from "./lisa-html.js";
import { OrchestratorHub, loadOrchestratorConfig } from "../integrations/hub.js";
import type { AgentSession } from "../integrations/types.js";
import { LISA_HOME } from "../paths.js";
import type { ToolDefinition, StoredMessage } from "../types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ASSETS_DIR = path.join(__dirname, "assets");


export interface WebServerOptions {
  port: number;
  tools: ToolDefinition[];
  model: string;
  thinking: boolean;
  reflect: boolean;
  /** Minutes of inactivity before idle mode fires. 0 disables. */
  idleMinutes?: number;
}

async function resumeOrCreateWebSession(model: string): Promise<SessionStore> {
  const lastId = await readActiveWebSession();
  if (lastId) {
    try {
      const s = await SessionStore.open(lastId);
      console.error(`[web] resuming session ${lastId} (from pointer)`);
      return s;
    } catch (err) {
      console.error(
        `[web] pointer ${lastId} unreadable (${(err as Error).message}) — falling back to most recent session`,
      );
    }
  }
  // Pointer missing or stale: pick the latest session whose cwd matches
  // this project. This catches the case where the user chatted before the
  // pointer mechanism existed, or the file was lost.
  try {
    const cwd = process.cwd();
    const sessions = await listSessionsOnDisk();
    const candidate = sessions.find(
      (s) => s.cwd === cwd && s.messageCount > 0,
    );
    if (candidate) {
      const s = await SessionStore.open(candidate.id);
      console.error(
        `[web] resuming session ${candidate.id} (most recent in ${cwd}, ${candidate.messageCount} msgs)`,
      );
      return s;
    }
  } catch (err) {
    console.error(`[web] could not scan sessions: ${(err as Error).message}`);
  }
  const s = await SessionStore.create({ cwd: process.cwd(), model });
  console.error(`[web] starting fresh session ${s.id}`);
  return s;
}

export async function startWebServer(opts: WebServerOptions): Promise<http.Server> {
  const snapshot = await buildSystemPromptSnapshot();
  const initialFingerprint = await getPromptFingerprint();
  // Per-process hot-reload cache for the web server: same shape as cli's
  // makeHotReloadRebuilder, inlined here so the web server stays standalone.
  let cachedFp = initialFingerprint;
  let cachedText = snapshot.text;
  const rebuildPrompt = async (): Promise<{ text: string; fingerprint: string }> => {
    const fp = await getPromptFingerprint();
    if (fp === cachedFp) return { text: cachedText, fingerprint: fp };
    const next = await buildSystemPromptSnapshot();
    cachedFp = fp;
    cachedText = next.text;
    return { text: next.text, fingerprint: fp };
  };
  // Resume previous chat across restarts. Three-tier fallback:
  //  1. ~/.lisa/active-web-session.txt (set on every web startup)
  //  2. Most recent session on disk in this cwd (catches the case where the
  //     pointer was lost or the very first launch happened pre-pointer)
  //  3. Fresh session
  // Whichever wins, we always update the pointer so the next launch is clean.
  const session = await resumeOrCreateWebSession(opts.model);
  await writeActiveWebSession(session.id);
  process.env.LISA_SESSION_ID = session.id;
  // Lazy provider — the SDK reads ANTHROPIC_API_KEY at construction time,
  // so we can't build it before the user has set the key via the GUI popup.
  // Rebuilt after /api/config/save so the in-memory client picks up the
  // new key without restarting the server.
  let cachedProvider: ReturnType<typeof providerForModel> | null = null;
  const getProvider = () => {
    if (!cachedProvider) cachedProvider = providerForModel(opts.model);
    return cachedProvider;
  };
  // Restore full history from the session file on startup (so context survives page refresh)
  const { messages: savedMessages } = await session.readMessagePage(0, 9999);
  const history: StoredMessage[] = [...savedMessages];
  const abort = new AbortController();

  // ── Persistent /events SSE subscribers (mood + idle broadcasts) ─────
  const eventClients = new Set<http.ServerResponse>();
  const broadcast = (event: object) => {
    const data = `data: ${JSON.stringify(event)}\n\n`;
    for (const c of eventClients) {
      try { c.write(data); } catch { /* dead conn */ }
    }
  };
  moodBus.on("mood", (slug) => broadcast({ type: "mood", slug }));
  // Surface "thinking" to long-lived viewers (web GUI, island widget). Each
  // event is one tick — surfaces toggle their own indicator. Multiple
  // concurrent turns (e.g. heartbeat + user) overlap; first chatStart wins
  // the visual, last chatEnd clears it. Best-effort.
  moodBus.on("chat_start", () => broadcast({ type: "chat_start" }));
  moodBus.on("chat_end", () => broadcast({ type: "chat_end" }));

  // ── Cross-agent orchestration hub (O1) ──────────────────────────────
  // The hub fans out over every enabled integration (Claude Code today;
  // Codex/OpenCode/… as adapters land) and merges their sessions into one
  // normalized stream. Privacy: structural metadata only (see types.ts +
  // each adapter). Replaces the single-purpose ClaudeCodeWatcher wiring.
  const orchestratorCfg = await loadOrchestratorConfig(
    path.join(LISA_HOME, "agents.json"),
  );
  const hub = new OrchestratorHub(orchestratorCfg, {
    log: (msg) => console.error(msg),
  });
  hub.on("update", (session: AgentSession) => {
    // New generalized event for the multi-agent UI.
    broadcast({ type: "agent_session_update", ...session });
    // Back-compat: the island still listens for claude_session_update as a
    // "something changed, refetch" trigger. Keep emitting it for Claude Code.
    if (session.agent === "claude-code") {
      broadcast({
        type: "claude_session_update",
        sessionId: session.sessionId,
        projectLabel: session.project,
        state: session.state,
        stateReason: session.stateReason,
        cwd: session.cwd,
        ts: new Date(session.lastMtime).toISOString(),
      });
    }
  });
  void hub.start();

  // ── Island unread tracking (Phase 1 of MAC_ISLAND_PLAN) ─────────────
  // The island widget caches "last idle_message" so a fresh tab opening
  // mid-conversation knows there's something to read. Cleared via
  // POST /api/island/dismiss-unread. Per design doc §6 Q2: latest wins,
  // no inbox-style accumulation.
  let lastIdleMessage: { text: string; at: string } | null = null;
  let serverStartedAt = Date.now();

  // ── Idle mode ───────────────────────────────────────────────────────
  let idleRunning = false;
  if (opts.idleMinutes && opts.idleMinutes > 0) {
    const watcher = getIdleWatcher(opts.idleMinutes * 60_000);
    watcher.on("idle", async () => {
      if (idleRunning) return;
      idleRunning = true;
      const startedAt = new Date().toISOString();
      console.error(
        `[idle] firing after ${Math.round(watcher.idleFor() / 60_000)}m of inactivity`,
      );
      broadcast({ type: "idle_start", at: startedAt });
      try {
        const result = await runIdleOnce({
          tools: opts.tools,
          cwd: process.cwd(),
          signal: abort.signal,
          model: opts.model,
          idleMs: watcher.idleFor(),
        });
        if (result.silent) {
          console.error("[idle] (silent)");
          broadcast({ type: "idle_done", silent: true });
        } else {
          console.error(`[idle] → ${result.text.slice(0, 120)}`);
          await session.appendMessage({
            role: "assistant",
            content: [{ type: "text", text: `[while you were away]\n${result.text}` }],
          });
          history.push({
            role: "assistant",
            content: [{ type: "text", text: `[while you were away]\n${result.text}` }],
          });
          lastIdleMessage = { text: result.text, at: startedAt };
          broadcast({ type: "idle_message", text: result.text, at: startedAt });
        }
      } catch (err) {
        const msg = (err as Error).message;
        console.error(`[idle] error: ${msg}`);
        broadcast({ type: "idle_error", message: msg });
      } finally {
        idleRunning = false;
      }
    });
    watcher.start();
    console.error(
      `[idle] watching — will fire after ${opts.idleMinutes}m of no input`,
    );
  }

  const server = http.createServer(async (req, res) => {
    const url = req.url ?? "/";

    if (req.method === "GET" && url === "/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(MAIN_HTML);
      return;
    }

    // Island widget — designed to be opened in a tiny browser window
    // (Arc, Vivaldi PWA, Safari split). See docs/MAC_ISLAND_PLAN.md.
    if (req.method === "GET" && url === "/island") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(ISLAND_HTML);
      return;
    }

    // Light status endpoint for the island. Polled every 5–30s as a
    // fallback when SSE has been quiet.
    if (req.method === "GET" && url === "/api/island/ping") {
      let currentDesire: string | null = null;
      try {
        const desires = await listDesires();
        const actionable = desires.find((d) => d.actionable);
        currentDesire = (actionable ?? desires[0])?.what ?? null;
      } catch {
        // listDesires can fail before soul is born; that's fine.
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        online: true,
        mood: moodBus.current(),
        has_unread_idle_message: lastIdleMessage !== null,
        last_idle_message_at: lastIdleMessage?.at ?? null,
        last_idle_message_text: lastIdleMessage?.text ?? null,
        current_desire: currentDesire,
        uptime_sec: Math.round((Date.now() - serverStartedAt) / 1000),
      }));
      return;
    }

    if (req.method === "POST" && url === "/api/island/dismiss-unread") {
      lastIdleMessage = null;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    // Cross-agent session snapshot (O1). Returns every active session
    // across all integrations, normalized. activity (Tier 2) is present
    // when the integration runs at visibility ≥ "activity".
    if (req.method === "GET" && url === "/api/agents/sessions") {
      const sessions = hub.list().map((s) => ({
        ...s,
        lastMtime: new Date(s.lastMtime).toISOString(),
      }));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ sessions }));
      return;
    }

    // Back-compat alias: the island still calls /api/claude/sessions and
    // expects the legacy field shape. Derive it from the hub's Claude Code
    // sessions so there's a single source of truth.
    if (req.method === "GET" && url === "/api/claude/sessions") {
      const sessions = hub.listByAgent("claude-code").map((s) => ({
        project: s.project,
        projectEncoded: s.project, // legacy field; UI only uses `project`
        sessionId: s.sessionId,
        lastMtime: new Date(s.lastMtime).toISOString(),
        state: s.state,
        stateReason: s.stateReason,
        cwd: s.cwd,
        activity: s.activity, // new in O2; older UI ignores unknown fields
      }));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ sessions }));
      return;
    }

    // PWA manifest. Lets users add Lisa to the home screen on iOS / Android
    // and run her as a standalone app shell.
    if (req.method === "GET" && url === "/manifest.webmanifest") {
      res.writeHead(200, {
        "content-type": "application/manifest+json; charset=utf-8",
        "cache-control": "public, max-age=86400",
      });
      res.end(JSON.stringify({
        name: "LISA",
        short_name: "Lisa",
        description: "An AI agent with a real self.",
        start_url: "/",
        scope: "/",
        display: "standalone",
        orientation: "any",
        background_color: "#0a0d2b",
        theme_color: "#0a0d2b",
        icons: [
          { src: "/assets/lisa-mascot.png", sizes: "any", type: "image/png", purpose: "any" },
          { src: "/assets/lisa-mascot.png", sizes: "any", type: "image/png", purpose: "maskable" },
        ],
      }));
      return;
    }

    // Service worker. Cache-first for /assets/* (mood portraits, icons,
    // fonts) so the UI runs offline once cached. Network-only for live
    // endpoints (/chat, /events, /session, /api/*) — we never want stale
    // chat state.
    if (req.method === "GET" && url === "/sw.js") {
      res.writeHead(200, {
        "content-type": "application/javascript; charset=utf-8",
        "service-worker-allowed": "/",
      });
      res.end(`
const CACHE = 'lisa-v2-redesign';
const ASSET_PATHS = ['/assets/lisa-mascot.png', '/assets/background-tile.png',
  '/assets/icon-soul.png', '/assets/icon-skill.png', '/assets/icon-memory.png',
  '/assets/icon-tool.png', '/assets/icon-send.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(ASSET_PATHS).catch(() => {}))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  // Never cache live endpoints — chat state must not stale.
  if (url.pathname === '/chat' || url.pathname === '/events' ||
      url.pathname === '/session' || url.pathname.startsWith('/api/') ||
      url.pathname === '/reflect') {
    return; // default network behavior
  }
  // Cache-first for /assets/* (mood portraits 50MB will fill cache lazily).
  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(
      caches.open(CACHE).then((cache) =>
        cache.match(event.request).then((hit) => {
          if (hit) return hit;
          return fetch(event.request).then((res) => {
            if (res.ok) cache.put(event.request, res.clone());
            return res;
          });
        })
      )
    );
    return;
  }
  // Stale-while-revalidate for / and the manifest — the app shell.
  if (url.pathname === '/' || url.pathname === '/manifest.webmanifest') {
    event.respondWith(
      caches.open(CACHE).then((cache) =>
        cache.match(event.request).then((hit) => {
          const networked = fetch(event.request).then((res) => {
            if (res.ok) cache.put(event.request, res.clone());
            return res;
          }).catch(() => hit);
          return hit || networked;
        })
      )
    );
  }
});
`);
      return;
    }

    if (req.method === "GET" && url === "/session") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: session.id, model: opts.model }));
      return;
    }

    if (req.method === "GET" && url === "/events") {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      res.write(`data: ${JSON.stringify({ type: "hello", session: session.id })}\n\n`);
      // Send current mood right away
      res.write(`data: ${JSON.stringify({ type: "mood", slug: moodBus.current() })}\n\n`);
      eventClients.add(res);
      req.on("close", () => eventClients.delete(res));
      return;
    }

    if (req.method === "GET" && url.startsWith("/api/history")) {
      const qs = new URL(url, "http://localhost").searchParams;
      const page = Math.max(0, parseInt(qs.get("page") ?? "0", 10));
      const pageSize = 20;
      const { messages, hasMore } = await session.readMessagePage(page, pageSize);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ messages, hasMore, page }));
      return;
    }

    if (req.method === "GET" && url === "/api/skills") {
      const { listSkills } = await import("../skills/manager.js");
      const skills = await listSkills();
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          skills: skills.map((s) => ({
            name: s.frontmatter.name,
            description: s.frontmatter.description,
          })),
        }),
      );
      return;
    }

    if (req.method === "GET" && url === "/api/memory") {
      const { readMemory } = await import("../memory/store.js");
      const [user, memory] = await Promise.all([
        readMemory("user"),
        readMemory("memory"),
      ]);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ user, memory }));
      return;
    }

    if (req.method === "GET" && url === "/api/tools") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          tools: opts.tools.map((t) => ({
            name: t.name,
            description: t.description,
          })),
        }),
      );
      return;
    }

    if (req.method === "GET" && url === "/api/config/status") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          configured: !!process.env.ANTHROPIC_API_KEY,
          anthropic: !!process.env.ANTHROPIC_API_KEY,
          openai: !!process.env.OPENAI_API_KEY,
        }),
      );
      return;
    }

    if (req.method === "POST" && url === "/api/config/save") {
      // Defence in depth: only accept the key from a loopback caller, even
      // if the listener happens to be on a public interface. Writes the key
      // to disk and into process.env, so spoofed remote calls would be
      // very bad.
      const remote = req.socket.remoteAddress ?? "";
      const isLoopback =
        remote === "127.0.0.1" ||
        remote === "::1" ||
        remote === "::ffff:127.0.0.1" ||
        remote.startsWith("127.");
      if (!isLoopback) {
        res.writeHead(403, { "content-type": "text/plain" });
        res.end("config save only accepted from localhost");
        return;
      }
      let body = "";
      for await (const chunk of req) body += chunk.toString("utf8");
      let payload: { anthropicKey?: unknown; openaiKey?: unknown };
      try {
        payload = JSON.parse(body || "{}");
      } catch {
        res.writeHead(400, { "content-type": "text/plain" });
        res.end("bad json");
        return;
      }
      const updates: Record<string, string> = {};
      const anthropic = typeof payload.anthropicKey === "string" ? payload.anthropicKey.trim() : "";
      const openai = typeof payload.openaiKey === "string" ? payload.openaiKey.trim() : "";
      if (!anthropic && !openai) {
        res.writeHead(400, { "content-type": "text/plain" });
        res.end("no keys provided");
        return;
      }
      if (anthropic) {
        if (!/^[\x21-\x7e]{20,}$/.test(anthropic)) {
          res.writeHead(400, { "content-type": "text/plain" });
          res.end("anthropic key looks malformed");
          return;
        }
        updates.ANTHROPIC_API_KEY = anthropic;
      }
      if (openai) {
        if (!/^[\x21-\x7e]{20,}$/.test(openai)) {
          res.writeHead(400, { "content-type": "text/plain" });
          res.end("openai key looks malformed");
          return;
        }
        updates.OPENAI_API_KEY = openai;
      }
      try {
        await saveConfigEnv(updates);
      } catch (err) {
        res.writeHead(500, { "content-type": "text/plain" });
        res.end((err as Error).message);
        return;
      }
      // Force the next /chat to rebuild the provider so the new key is read.
      cachedProvider = null;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, saved: Object.keys(updates) }));
      return;
    }

    if (req.method === "GET" && url === "/api/soul") {
      const { isBorn, readSoulSummary } = await import("../soul/store.js");
      const born = await isBorn();
      if (!born) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ born: false }));
        return;
      }
      const summary = await readSoulSummary();
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ born: true, summary }));
      return;
    }

    if (req.method === "POST" && url === "/api/birth") {
      const { isBorn } = await import("../soul/store.js");
      const { birth } = await import("../soul/birth.js");
      if (await isBorn()) {
        res.writeHead(409, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "already born" }));
        return;
      }
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      const send = (event: object) =>
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      try {
        await birth({
          model: opts.model,
          onStep: (log) => {
            send({ kind: "step", name: log.step, detail: log.detail });
          },
        });
        send({ kind: "done", message: "she is alive" });
      } catch (err) {
        send({ kind: "error", message: (err as Error).message });
      } finally {
        res.end();
      }
      return;
    }

    if (req.method === "GET" && url.startsWith("/assets/")) {
      const safe = path
        .normalize(url.slice("/assets/".length))
        .replace(/^[/\\]+/, "");
      if (safe.includes("..")) {
        res.writeHead(400);
        res.end();
        return;
      }
      try {
        const file = path.join(ASSETS_DIR, safe);
        const data = await fs.readFile(file);
        const type = safe.endsWith(".png")
          ? "image/png"
          : safe.endsWith(".jpg") || safe.endsWith(".jpeg")
            ? "image/jpeg"
            : "application/octet-stream";
        res.writeHead(200, {
          "content-type": type,
          "cache-control": "public, max-age=86400",
        });
        res.end(data);
      } catch {
        res.writeHead(404);
        res.end();
      }
      return;
    }

    if (req.method === "POST" && url === "/chat") {
      let body = "";
      for await (const chunk of req) body += chunk.toString("utf8");
      const { message, files } = JSON.parse(body) as { message: string; files?: Array<{ name: string; mediaType: string; data: string }> };
      // User just talked — reset the idle watcher.
      try { getIdleWatcher(60 * 60_000).tick(); } catch {}
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      const send = (event: object) =>
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      const onMood = (slug: string) => send({ type: "mood", slug });
      moodBus.on("mood", onMood);
      // Send the current mood immediately so a fresh tab knows where to start.
      send({ type: "mood", slug: moodBus.current() });
      try {
        // Use the freshest cached prompt for this chat. If soul / skills /
        // memory changed since the previous chat, rebuildPrompt() picks it up.
        const fresh = await rebuildPrompt();
        const result = await runAgent({
          provider: getProvider(),
          systemPrompt: fresh.text,
          tools: opts.tools,
          toolCtx: {
            cwd: process.cwd(),
            signal: abort.signal,
            log: () => {},
          },
          history,
          userMessage: message,
          userFiles: files,
          model: opts.model,
          thinking: opts.thinking,
          onEvent: (ev) => {
            if (ev.type === "text_delta" && ev.text)
              send({ type: "text", text: ev.text });
            if (ev.type === "tool_call_start")
              send({
                type: "tool_start",
                name: ev.toolName,
                input: ev.toolInput,
              });
            if (ev.type === "tool_call_end")
              send({
                type: "tool_end",
                name: ev.toolName,
                isError: ev.isError === true,
                resultPreview:
                  typeof ev.toolResult === "string"
                    ? ev.toolResult.slice(0, 200)
                    : "",
              });
            if (ev.type === "system_prompt_rebuilt")
              send({ type: "soul_reload", message: ev.message ?? "" });
            if (ev.type === "error")
              send({ type: "error", message: ev.message ?? "" });
          },
          onMessagePersist: (m) => session.appendMessage(m),
          hotReload: {
            initialFingerprint: fresh.fingerprint,
            rebuild: rebuildPrompt,
          },
        });
        history.length = 0;
        history.push(...result.history);
        send({ type: "done" });
      } catch (err) {
        send({ type: "error", message: (err as Error).message });
      } finally {
        moodBus.off("mood", onMood);
        res.end();
      }
      return;
    }

    if (req.method === "POST" && url === "/reflect") {
      try {
        const r = await reflectOnSession({
          history,
          sessionId: session.id,
          model: opts.model,
        });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(r));
      } catch (err) {
        res.writeHead(500);
        res.end((err as Error).message);
      }
      return;
    }

    res.writeHead(404);
    res.end();
  });
  server.listen(opts.port);
  return server;
}

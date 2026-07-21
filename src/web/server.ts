import http from "node:http";
import path from "node:path";
import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { listRoomMusic, toPublicTrack } from "./room-music.js";
import { runAgent } from "../agent.js";
import { fireHooks } from "../hooks/runner.js";
import type { HookSpec } from "../plugins/types.js";
import { saveConfigEnv } from "../env.js";
import { detectPlans, selectedPlan, parsePlanRef, planMark, PLAN_IDS } from "../model/plans.js";
import { planUsage, formatUsage } from "../model/plan-usage.js";
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
import {
  DEFAULT_REFLECT_DEBOUNCE_MS,
  REFLECT_CHECK_INTERVAL_MS,
  countUserMessages,
  decideReflect,
} from "./reflect-scheduler.js";
import { listDesires, desireActivity, pickCurrentDesire } from "../soul/store.js";
import {
  FOCUS_FRESHNESS_MS,
  pickFocusedDesire,
  recentUserText,
} from "../soul/desire-focus.js";
import { ISLAND_HTML } from "./island.js";
import { LOGIN_HTML } from "./login.js";
import { ROOM_HTML } from "./room.js";
import { MAIN_HTML } from "./lisa-html.js";
import { OrchestratorHub, loadOrchestratorConfig } from "../integrations/hub.js";
import { setCurrentHub } from "../integrations/current-hub.js";
import { advise, dismissSuggestion, formatDigest } from "../advisor/engine.js";
import type { SuggestionCategory, SuggestedAction, Urgency } from "../advisor/types.js";
import { recordEvent } from "../orchestrator/journal.js";
import { buildRecap, formatRecap } from "../orchestrator/recap.js";
import type { AgentSession } from "../integrations/types.js";
import { captureScreenshot, captureSupported, type CaptureMode } from "../vision/capture.js";
import { transcribeAudio } from "../voice/transcribe.js";
import { polishDictation, type DictationProvider } from "../voice/dictation.js";
import { listGrants, grant, revoke, revokeAll, isGranted, SENSE_SIGNALS, SIGNAL_DESCRIPTIONS } from "../consent/store.js";
import { signalAgentTool } from "../tools/signal_agent.js";
import { managedRegistry } from "../agents/managed.js";
import { ptyRegistry, ptyEnabled, normalizeAgentKind } from "../agents/pty.js";
import { liveClaudeSessionIds } from "../integrations/claude-code/liveness.js";
import { sweepAll, pollNewMail, probeAccount } from "../mail/service.js";
import { pickImportant, formatAlert, alertLevel, pollMinutes } from "../mail/alerts.js";
import { latestDigest } from "../mail/store.js";
import { formatDigestText } from "../mail/digest.js";
import { isDigestDue, digestHour } from "../mail/scheduler.js";
import { loadAccounts, addAccount, removeAccount, setAccountEnabled } from "../mail/accounts.js";
import { inferHost } from "../mail/hosts.js";
import type { DailyDigest } from "../mail/types.js";
import { listRecentDispatches, isAlive, toDispatchView, readDispatchOutput } from "../integrations/dispatch-ledger.js";
import { loadControlPolicy, saveControlPolicy, type ControlPolicy } from "../control/policy.js";
import { loadAutonomyState, saveAutonomyState, type AutonomyState } from "../autonomy/state.js";
import { mintDevice, verifyDeviceToken, touchDevice, listDevices, revokeDevice } from "./devices.js";
import {
  loadOrCreateSessionSecret,
  mintSession,
  verifySession,
  looksLikeSession,
  shouldRenew,
} from "./sessions-auth.js";
import {
  AccountError,
  createEmailAccount,
  verifyEmailLogin,
  upsertAppleAccount,
  deleteAccount,
  getAccount,
  sessionAccountValid,
} from "./accounts.js";
import { PushBridge, listPush, registerPush, unregisterPush, setPushPrefs, registerLiveActivity, unregisterLiveActivity, type PushPrefs } from "./push.js";
import { SenseService } from "../sense/service.js";
import { ScreenSource } from "../sense/screen.js";
import { VoiceSource } from "../sense/voice.js";
import { appendSenseEvent, readSenseEvents } from "../sense/log.js";
import {
  loadScreenAdvisorConfig,
  saveScreenAdvisorConfig,
  normalizeConfig,
  analyzeScreenshot,
  type ScreenAdvisorConfig,
  type ScreenSuggestion,
  type SuggestionProvider,
} from "../screen_advisor/engine.js";
import os from "node:os";
import { lisaHome, lisaGlobalHome, homeScope, homeForUid } from "../paths.js";
import { isCloud, editionInfo } from "../edition.js";
import {
  verifyAppleIdentityToken,
  fetchAppleKeys,
  appleSignInConfig,
  subAllowed,
  AppleAuthError,
} from "./cloudAuth.js";
import { detectLanHost, buildPairUrl } from "./pairing.js";
import { qrSvg } from "./qr-svg.js";
import type { ToolDefinition, StoredMessage } from "../types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ASSETS_DIR = path.join(__dirname, "assets");
const MUSIC_DIR = path.join(ASSETS_DIR, "room", "music");

/**
 * Turn a raw IMAP probe failure into a plain-language hint for the connect
 * modal. The single biggest cause is pasting a login password where an
 * app-password / authorization code is required, so lead with that.
 */
function friendlyMailError(err: unknown, email: string, host: string): string {
  const raw = err instanceof Error ? err.message : String(err);
  const m = raw.toLowerCase();
  const isGmail = /(^|@)(gmail\.com|googlemail\.com)$/.test(email.toLowerCase()) || host === "imap.gmail.com";
  if (/auth|credential|login|invalid|denied|not accepted|username|password/.test(m)) {
    return isGmail
      ? "Gmail rejected the sign-in. Use a 16-character app password (not your Google login password), and make sure 2-Step Verification is on."
      : "Authentication failed. Use an app-password / authorization code from your mail provider — not your login password.";
  }
  if (/enotfound|eai_again|getaddrinfo|dns|no such host/.test(m)) {
    return "Could not find the mail server. Check the IMAP host.";
  }
  if (/timed out|timeout|etimedout|econn|network|socket|refused/.test(m)) {
    return "Could not reach the mail server (network or timeout). Check your connection and the IMAP host.";
  }
  return "Could not connect: " + raw.slice(0, 160);
}


export interface WebServerOptions {
  port: number;
  tools: ToolDefinition[];
  model: string;
  thinking: boolean;
  reflect: boolean;
  /** Minutes of inactivity before idle mode fires. 0 disables. */
  idleMinutes?: number;
  /**
   * Bind address. Defaults to 127.0.0.1 — the server drives a full-tool agent
   * with no per-request auth, so it must not be reachable from the LAN unless
   * the user explicitly opts in. Binding to a non-loopback address requires
   * LISA_WEB_TOKEN to be set; non-loopback requests must then present the
   * token (Authorization: Bearer / ?token= / cookie).
   */
  host?: string;
  /** PreToolUse/PostToolUse hook specs from loaded plugins. */
  hooks?: HookSpec[];
}

/** True for loopback peer/bind addresses (v4, v6, and v4-mapped-v6 forms). */
export function isLoopbackAddress(addr: string): boolean {
  const a = addr.startsWith("::ffff:") ? addr.slice("::ffff:".length) : addr;
  return a === "::1" || a === "localhost" || a.startsWith("127.");
}

function timingSafeEqualStr(a: string, b: string): boolean {
  // Hash both sides so the comparison is constant-time regardless of length.
  const ha = crypto.createHash("sha256").update(a).digest();
  const hb = crypto.createHash("sha256").update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

/**
 * The web auth decision (the unit the red-team script + tests target): a request
 * is authorized iff it's loopback (the local user) OR it presents the correct
 * LISA_WEB_TOKEN. No token configured ⇒ no non-loopback request can pass. Pure.
 */
export function isRequestAuthorized(
  remoteAddr: string,
  webToken: string | null,
  presented: string | null,
  trustLoopback = true,
): boolean {
  if (trustLoopback && isLoopbackAddress(remoteAddr)) return true;
  return !!webToken && !!presented && timingSafeEqualStr(presented, webToken);
}

/**
 * Extract a presented web token from Authorization header, lisa_token cookie,
 * or ?token= query param (the query form exists so a phone can bootstrap the
 * cookie by opening http://host:5757/?token=...).
 */
function presentedToken(req: http.IncomingMessage, url: string): string | null {
  const auth = req.headers.authorization;
  if (auth?.startsWith("Bearer ")) return auth.slice("Bearer ".length).trim();
  const cookies = req.headers.cookie ?? "";
  const m = /(?:^|;\s*)lisa_token=([^;]+)/.exec(cookies);
  if (m) return decodeURIComponent(m[1]!).trim() || null;
  try {
    // Trim: tokens arrive by copy-paste (App Review pastes the demo URL), and a
    // stray trailing space/newline must not fail the exact comparison.
    const q = new URL(url, "http://localhost").searchParams.get("token")?.trim();
    if (q) return q;
  } catch {
    /* fall through */
  }
  return null;
}

/** Read and JSON-parse a request body (tolerant: bad/empty JSON ⇒ {}). */
async function readJsonBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  let body = "";
  for await (const chunk of req) body += chunk.toString("utf8");
  try {
    const parsed: unknown = body ? JSON.parse(body) : {};
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
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
  const host = opts.host ?? "127.0.0.1";
  const webToken = process.env.LISA_WEB_TOKEN?.trim() || null;
  // Account sessions (PLAN_ACCOUNTS_BILLING B1): the signing secret lives in
  // $lisaHome() (auto-created 0600; durable on the cloud's /data mount). Only the
  // cloud edition mints/verifies account sessions today — the Mac edition gains
  // a client-side use in B6 (managed inference).
  const sessionSecret = isCloud() ? loadOrCreateSessionSecret() : null;
  if (!isLoopbackAddress(host) && !webToken) {
    throw new Error(
      `refusing to bind ${host} without LISA_WEB_TOKEN — every endpoint drives a ` +
        `full-tool agent on this machine. Set LISA_WEB_TOKEN (e.g. ` +
        `\`LISA_WEB_TOKEN=$(openssl rand -hex 24)\` in ~/.lisa/config.env), then open ` +
        `http://<host>:${opts.port}/?token=<value> from the remote device.`,
    );
  }
  const snapshot = await buildSystemPromptSnapshot();
  const initialFingerprint = await getPromptFingerprint();
  // Per-process hot-reload cache for the web server: same shape as cli's
  // makeHotReloadRebuilder, inlined here so the web server stays standalone.
  // Keyed by the ACTIVE home (B2): each cloud account gets its own soul, so the
  // prompt snapshot must be cached per-uid, not process-wide.
  const promptCache = new Map<string, { fp: string; text: string }>();
  promptCache.set(lisaGlobalHome(), { fp: initialFingerprint, text: snapshot.text });
  const rebuildPrompt = async (): Promise<{ text: string; fingerprint: string }> => {
    const key = lisaHome();
    const fp = await getPromptFingerprint();
    const cached = promptCache.get(key);
    if (cached && fp === cached.fp) return { text: cached.text, fingerprint: fp };
    const next = await buildSystemPromptSnapshot();
    promptCache.set(key, { fp, text: next.text });
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
  const hooks = opts.hooks ?? [];
  // Serialize chat turns. The whole process shares ONE history array and ONE
  // session file — two tabs (or a tab + the island) POSTing /chat concurrently
  // would run two agents against the same history reference and clobber each
  // other's `history.length = 0; history.push(...)` at the end. Same model as
  // the channels router's per-thread busy+queue, with a promise chain.
  //
  // ── Per-account conversation contexts (B2 multi-tenant seam) ──────────────
  // The module-level session/history above serve the Mac edition and legacy
  // shared-token cloud callers (one shared conversation — unchanged). A
  // signed-in cloud request runs inside homeScope, and gets its OWN context,
  // created lazily INSIDE that scope so every path underneath — sessions dir,
  // active pointer, soul, memory — resolves into the user's subtree. The
  // background schedulers (idle/reflect) keep operating on the global context
  // only; per-uid autonomy is gated on per-uid budgets (B4+).
  interface ChatCtx {
    session: SessionStore;
    history: StoredMessage[];
    chain: Promise<void>;
  }
  const globalChat: ChatCtx = { session, history, chain: Promise.resolve() };
  const uidChats = new Map<string, ChatCtx>();
  const ctxForRequest = async (): Promise<ChatCtx> => {
    const scoped = homeScope.getStore();
    if (!scoped) return globalChat;
    let ctx = uidChats.get(scoped);
    if (!ctx) {
      const s = await resumeOrCreateWebSession(opts.model);
      await writeActiveWebSession(s.id);
      const { messages } = await s.readMessagePage(0, 9999);
      ctx = { session: s, history: [...messages], chain: Promise.resolve() };
      uidChats.set(scoped, ctx);
    }
    return ctx;
  };

  // Lazy per-user birth (B2): a signed-in user's first request seeds THEIR soul
  // (the entrypoint's one-shot birth only covers the shared/global home). Runs
  // in the background inside the caller's home scope; chat before it completes
  // simply runs with the bare prompt and the soul arrives mid-conversation.
  const birthsInFlight = new Set<string>();
  const ensureUserBirth = (uid: string): void => {
    if (birthsInFlight.has(uid)) return;
    birthsInFlight.add(uid);
    void (async () => {
      try {
        const { isBorn } = await import("../soul/store.js");
        if (await isBorn()) return; // reads inside the per-uid scope
        console.error(`[accounts] birthing a soul for ${uid}…`);
        const { birth } = await import("../soul/birth.js");
        await birth({ model: opts.model });
        promptCache.delete(lisaHome()); // pick the newborn soul up next turn
        console.error(`[accounts] soul born for ${uid}`);
      } catch (e) {
        console.error(`[accounts] birth failed for ${uid}: ${(e as Error).message}`);
      } finally {
        birthsInFlight.delete(uid);
      }
    })();
  };

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
    path.join(lisaHome(), "agents.json"),
  );
  const hub = new OrchestratorHub(orchestratorCfg, {
    log: (msg) => console.error(msg),
  });
  // Operational push: notify subscribed phones on agent done/error/permission +
  // Reve idle messages. Opt-in, ntfy by default (apns is a stub). See push.ts.
  const pushBridge = new PushBridge({ log: (m) => console.error(m) });
  hub.on("update", (session: AgentSession) => {
    // L6 — record the transition in the orchestrator journal so the
    // cross-agent recap can answer "what happened while I was away?" even for
    // sessions that have since ended. (Dedups consecutive same-state events.)
    recordEvent(session);
    pushBridge.onAgentUpdate(session);
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
  // Expose the live hub to the advise_now tool (same process).
  setCurrentHub(hub);

  // ── Advisor (L5): periodic proactive suggestions ────────────────────
  // Every interval, run the cross-agent detectors against the live hub
  // snapshot. The engine applies the relevance bar + 3h digest throttle +
  // dedup (urgent items bypass the throttle), so most ticks surface
  // nothing. Survivors land in the idle_message "while you were away"
  // card — pull-friendly, not an interrupt. lastIdleMessage is assigned
  // inside the async callback (runs after all locals init; no TDZ issue).
  const ADVISE_INTERVAL_MS = 5 * 60_000;
  // The latest surfaced suggestions, kept so a freshly opened island can pull
  // them (GET /api/advisor/latest) instead of waiting for the next SSE tick.
  interface AdvisorCardSuggestion {
    id: string;
    category: SuggestionCategory;
    urgency: Urgency;
    text: string;
    action: SuggestedAction | null;
  }
  let lastAdvisorSuggestions: { suggestions: AdvisorCardSuggestion[]; at: string } | null = null;
  const adviseTimer = setInterval(() => {
    void (async () => {
      try {
        const sessions = hub.list();
        if (sessions.length === 0) return;
        const { surface } = await advise({ sessions, now: Date.now() });
        if (surface.length === 0) return;
        const text = formatDigest(surface);
        const at = new Date().toISOString();
        lastIdleMessage = { text, at };
        broadcast({ type: "idle_message", text, at, source: "advisor" });
        pushBridge.onIdleMessage(text);
        // Structured twin of the digest: same suggestions with id / urgency /
        // action attached so the island can render per-suggestion buttons
        // (act → prefill chat, ✕ → dismiss feeds the learning loop).
        const suggestions: AdvisorCardSuggestion[] = surface.map((s) => ({
          id: s.id,
          category: s.category,
          urgency: s.urgency,
          text: s.text,
          action: s.action ?? null,
        }));
        lastAdvisorSuggestions = { suggestions, at };
        broadcast({ type: "advisor_suggestions", suggestions, at });
        console.error(`[advisor] surfaced ${surface.length} suggestion(s)`);
      } catch (err) {
        console.error(`[advisor] tick failed: ${(err as Error).message}`);
      }
    })();
  }, ADVISE_INTERVAL_MS);
  if (adviseTimer.unref) adviseTimer.unref();

  // ── Mail digest (daily) ─────────────────────────────────────────────
  // Once past the target hour, if not already done today, sweep all mailboxes,
  // build + push the classified digest. Inert unless `mail` consent is granted
  // and at least one account is connected.
  let mailSweepRunning = false;
  const afterMailDigest = (digest: DailyDigest): void => {
    broadcast({
      type: "mail_digest_update",
      date: digest.date,
      total: digest.total,
      needsYou: digest.needsYou.length,
      at: new Date().toISOString(),
    });
    pushBridge.onMailDigest(formatDigestText(digest));
  };
  const runMailDigest = async (force: boolean): Promise<DailyDigest | null> => {
    if (mailSweepRunning || !isGranted("mail")) return null;
    if (loadAccounts().filter((a) => a.enabled).length === 0) return null;
    if (!force && !isDigestDue(latestDigest()?.date ?? null, new Date(), digestHour())) return null;
    mailSweepRunning = true;
    try {
      const { digest } = await sweepAll();
      afterMailDigest(digest);
      // Post the digest into the chat too (the "here's your mail" moment), in
      // addition to the push — but only on the scheduled daily run, not manual.
      if (!force && digest.total > 0) {
        broadcast({ type: "idle_message", text: formatDigestText(digest), at: new Date().toISOString(), source: "mail" });
      }
      console.error(`[mail] digest ${digest.date}: ${digest.total} mail · ${digest.needsYou.length} need-you`);
      return digest;
    } catch (err) {
      console.error(`[mail] digest sweep failed: ${(err as Error).message}`);
      return null;
    } finally {
      mailSweepRunning = false;
    }
  };
  const mailTimer = setInterval(() => void runMailDigest(false), 30 * 60_000);
  if (mailTimer.unref) mailTimer.unref();
  // Catch a restart that happens after the target hour (don't wait 30m).
  const mailKick = setTimeout(() => void runMailDigest(false), 20_000);
  if (mailKick.unref) mailKick.unref();

  // ── Important-mail alerts (intraday) ────────────────────────────────
  // Every LISA_MAIL_POLL_MINUTES (default 30; 0 disables), incrementally read
  // NEW mail; for items at/above the alert level, fire a high-priority push +
  // a proactive chat message. Inert without consent + an account.
  const mailPollMin = pollMinutes();
  if (mailPollMin > 0) {
    let mailPollRunning = false;
    const mailPoll = setInterval(() => {
      void (async () => {
        if (mailPollRunning || !isGranted("mail")) return;
        if (loadAccounts().filter((a) => a.enabled).length === 0) return;
        mailPollRunning = true;
        try {
          const important = pickImportant(await pollNewMail(), alertLevel());
          if (important.length === 0) return;
          for (const item of important.slice(0, 3)) {
            const alert = formatAlert(item);
            pushBridge.onMailImportant({ title: alert.title, body: alert.body, tag: alert.tag });
            broadcast({ type: "idle_message", text: alert.chat, at: new Date().toISOString(), source: "mail" });
          }
          broadcast({ type: "mail_digest_update", at: new Date().toISOString() });
          console.error(`[mail] ${important.length} important new mail (alerted ${Math.min(3, important.length)})`);
        } catch (err) {
          console.error(`[mail] poll failed: ${(err as Error).message}`);
        } finally {
          mailPollRunning = false;
        }
      })();
    }, mailPollMin * 60_000);
    if (mailPoll.unref) mailPoll.unref();
  }

  // ── Screen advisor (opt-in): periodic screen-grounded next-step ─────
  // When enabled, every N minutes capture a full-screen shot, ask the model
  // for the single best next coding step, and push it to the island as a
  // suggestion card. PRIVACY: disabled by default; the screenshot leaves the
  // machine only for the one analysis call and is never persisted (capture
  // deletes its temp file); only the short text suggestion is cached. Nothing
  // auto-runs — clicking the card just prefills chat.
  let screenCfg: ScreenAdvisorConfig = await loadScreenAdvisorConfig();
  let lastScreenSuggestion: ScreenSuggestion | null = null;
  let screenTimer: NodeJS.Timeout | null = null;
  let screenTickRunning = false;

  const screenTick = async (): Promise<void> => {
    // S2: a screenshot → model IS screen capture, so it requires the `screen`
    // consent grant (re-checked each tick so revoke-all stops it within one
    // interval) IN ADDITION to the advisor's own enabled flag. This unifies all
    // screen capture under the consent framework (FOUNDATIONS §1).
    if (screenTickRunning || !screenCfg.enabled || !captureSupported() || !isGranted("screen")) return;
    screenTickRunning = true;
    try {
      const shot = await captureScreenshot("full");
      if (!shot) return;
      const suggestion = await analyzeScreenshot({
        provider: getProvider() as unknown as SuggestionProvider,
        model: opts.model,
        imageBase64: shot.data,
        mediaType: shot.mediaType,
      });
      if (!suggestion) {
        console.error("[screen-advisor] nothing actionable on screen");
        return;
      }
      lastScreenSuggestion = { ...suggestion, at: new Date().toISOString() };
      broadcast({ type: "screen_suggestion", ...lastScreenSuggestion });
      console.error(`[screen-advisor] suggested: ${suggestion.title}`);
    } catch (err) {
      console.error(`[screen-advisor] tick failed: ${(err as Error).message}`);
    } finally {
      screenTickRunning = false;
    }
  };

  const restartScreenTimer = (): void => {
    if (screenTimer) {
      clearInterval(screenTimer);
      screenTimer = null;
    }
    if (!screenCfg.enabled) return;
    // First capture fires after one interval — never immediately on (re)start,
    // so flipping the toggle doesn't grab the screen the same instant.
    screenTimer = setInterval(() => void screenTick(), screenCfg.intervalMinutes * 60_000);
    if (screenTimer.unref) screenTimer.unref();
  };
  restartScreenTimer();
  if (screenCfg.enabled) {
    console.error(`[screen-advisor] enabled — every ${screenCfg.intervalMinutes}m`);
    if (!isGranted("screen")) {
      console.error("[screen-advisor] waiting on `screen` consent — grant it (`lisa consent grant screen`) to start capturing.");
    }
  }

  // ── Sense ambient sources (S2) ──────────────────────────────────────
  // The resident loop owns consent-gated ambient sources. ScreenSource ticks
  // continuously but captures NOTHING until `screen` is granted (it re-checks
  // each tick), so this is a no-op by default. On-change foreground-app events
  // are distilled to the bounded sense log; nothing raw is persisted.
  const senseService = new SenseService();
  // VoiceSource is event-driven (fed by the transcribe endpoint when `voice` is
  // granted); ScreenSource polls. Both no-op until their signal is granted.
  const voiceSource = new VoiceSource();
  senseService.register(new ScreenSource());
  senseService.register(voiceSource);
  void senseService.start((e) => {
    appendSenseEvent(e);
    broadcast({ type: "sense_event", ...e });
  });

  // ── Island unread tracking (Phase 1 of MAC_ISLAND_PLAN) ─────────────
  // The island widget caches "last idle_message" so a fresh tab opening
  // mid-conversation knows there's something to read. Cleared via
  // POST /api/island/dismiss-unread. Per design doc §6 Q2: latest wins,
  // no inbox-style accumulation.
  let lastIdleMessage: { text: string; at: string } | null = null;
  let serverStartedAt = Date.now();

  // ── Idle mode ───────────────────────────────────────────────────────
  let idleRunning = false;
  // Declared here (rather than beside the reflect scheduler below) so the dream's
  // idle handler can also defer to an in-flight reflection: PLAN §3 wants reflect
  // to run first, before the dream mutates history with its own "[while you were
  // away]" note. Without this the guard is asymmetric — the scheduler blocks
  // reflect-during-dream, but a dream could still start mid-reflect.
  let reflecting = false;
  if (opts.idleMinutes && opts.idleMinutes > 0) {
    const watcher = getIdleWatcher(opts.idleMinutes * 60_000);
    watcher.on("idle", async () => {
      if (idleRunning || reflecting) return;
      idleRunning = true;
      const startedAt = new Date().toISOString();
      console.error(
        `[idle] firing after ${Math.round(watcher.idleFor() / 60_000)}m of inactivity`,
      );
      broadcast({ type: "idle_start", at: startedAt });
      try {
        // Match the note's language to how the user actually writes (the most
        // recent non-empty user message). Language-agnostic — Lisa mirrors it.
        let userLanguageSample: string | undefined;
        for (let i = history.length - 1; i >= 0; i--) {
          const m = history[i];
          if (!m || m.role !== "user") continue;
          let t = "";
          if (typeof m.content === "string") {
            t = m.content;
          } else if (Array.isArray(m.content)) {
            t = m.content
              .map((b) =>
                b && typeof b === "object" && "text" in b && typeof b.text === "string"
                  ? b.text
                  : "",
              )
              .join(" ");
          }
          if (t.trim()) {
            userLanguageSample = t.trim();
            break;
          }
        }
        const result = await runIdleOnce({
          tools: opts.tools,
          cwd: process.cwd(),
          signal: abort.signal,
          model: opts.model,
          idleMs: watcher.idleFor(),
          userLanguageSample,
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
          pushBridge.onIdleMessage(result.text);
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

  // ── Reflection scheduler (PLAN_DESIRE_EVOLUTION_v1.0 §3 PR1) ──────────────
  // The web server never exits, so end-of-session reflection had nowhere to
  // hang — which is why web conversations never updated Lisa's desires. Reflect
  // when a stretch of conversation goes quiet instead: after a short debounce
  // with no user input, once, provided the human actually said something new.
  // Clamp to a positive, finite value: `Number(env) || DEFAULT` correctly
  // rejects NaN / "" / "0", but a negative value is truthy and would make
  // `idleMs < debounceMs` always false → reflect ~60s into any conversation.
  const reflectDebounceEnv = Number(process.env.LISA_REFLECT_DEBOUNCE_MS);
  const reflectDebounceMs =
    Number.isFinite(reflectDebounceEnv) && reflectDebounceEnv > 0
      ? reflectDebounceEnv
      : DEFAULT_REFLECT_DEBOUNCE_MS;
  // Reuse the process-wide idle watcher purely as an activity clock — /chat
  // already ticks() it. idleFor() works without start(); the idleMs we pass only
  // matters if we happen to be its first caller, and we never use its 'idle'
  // event here (that drives the separate, hour-long "dream" idle above).
  const reflectClock = getIdleWatcher(reflectDebounceMs);
  // Wall-clock of the last real user message (0 until one arrives this process).
  // Gates intra-session desire focus: unlike reflectClock.idleFor() — which reads
  // "fresh" right after a launchd restart — this stays 0 across a restart, so a
  // stale resumed conversation can't pin a focus. Stamped in the POST /chat path.
  let lastUserMessageAt = 0;
  // Seed from the resumed history so we never re-reflect prior sessions on the
  // first quiet window — only conversation added while this server is live.
  let lastReflectedUserCount = countUserMessages(history);
  const reflectTimer = setInterval(() => {
    const currentUserCount = countUserMessages(history);
    const decision = decideReflect({
      newUserMessages: currentUserCount - lastReflectedUserCount,
      idleMs: reflectClock.idleFor(),
      debounceMs: reflectDebounceMs,
      inFlight: reflecting || idleRunning,
    });
    if (!decision.shouldReflect) return;
    reflecting = true;
    const snapshot = history.slice();
    const snapshotUserCount = currentUserCount;
    void (async () => {
      try {
        const r = await reflectOnSession({
          history: snapshot,
          sessionId: session.id,
          model: opts.model,
        });
        // Advance the marker only on success, so a failed reflect retries next
        // tick instead of silently dropping the conversation.
        lastReflectedUserCount = snapshotUserCount;
        await session.appendReflection(r.summary);
        broadcast({
          type: "reflect_done",
          summary: r.summary,
          at: new Date().toISOString(),
        });
        console.error(`[reflect] ${decision.reason} → ${r.summary}`);
        for (const a of r.applied) console.error(`  applied: ${a}`);
      } catch (err) {
        console.error(`[reflect] failed: ${(err as Error).message}`);
      } finally {
        reflecting = false;
      }
    })();
  }, REFLECT_CHECK_INTERVAL_MS);
  // Don't let the reflection heartbeat keep the process alive on its own.
  reflectTimer.unref();

  const server = http.createServer(async (req, res) => {
    const url = req.url ?? "/";

    // ── Auth gate ────────────────────────────────────────────────────────
    // Loopback callers are the local user — no token needed (the default
    // 127.0.0.1 bind means this is the only case unless the user opted in
    // via --host). Anything else must present LISA_WEB_TOKEN; /chat drives a
    // full-tool agent and /api/vision/capture grabs the screen, so an
    // unauthenticated non-loopback request is a remote-code-execution hole.
    const remoteAddr = req.socket.remoteAddress ?? "";
    // In the hosted cloud edition there is no trusted local user — the gate runs
    // for EVERY request and loopback is not a free pass (the container must never
    // trust its own/proxy loopback). Mac edition: loopback = the local owner.
    const cloud = isCloud();

    // ── Sign in with Apple (cloud edition) ───────────────────────────────────
    // Public on purpose: this endpoint *mints* access, so it runs BEFORE the
    // token gate. The iOS app sends the Apple identity token; we verify it
    // against Apple's keys and hand back the cloud session token (= the shared
    // LISA_WEB_TOKEN — single-tenant, matching the M0/C2 demo). Default-OFF:
    // disabled unless LISA_CLOUD_APPLE_SIGNIN is set, so we never leak the token.
    // See src/web/cloudAuth.ts + docs/PLAN_CLOUD_v1.0.md.
    if (req.method === "POST" && url === "/api/auth/apple") {
      const cfg = appleSignInConfig();
      if (!cloud || !cfg.enabled) {
        res.writeHead(404, { "content-type": "text/plain" });
        res.end("apple sign-in not available");
        return;
      }
      if (!sessionSecret) {
        res.writeHead(503, { "content-type": "text/plain" });
        res.end("cloud sign-in misconfigured (no session secret)");
        return;
      }
      const payload = await readJsonBody(req);
      const idToken = typeof payload.identityToken === "string" ? payload.identityToken : "";
      if (!idToken) {
        res.writeHead(400, { "content-type": "text/plain" });
        res.end("identityToken required");
        return;
      }
      try {
        const id = await verifyAppleIdentityToken(idToken, {
          audience: cfg.audience,
          fetchKeys: fetchAppleKeys,
        });
        if (!subAllowed(id.sub, cfg)) {
          res.writeHead(403, { "content-type": "text/plain" });
          res.end("this Apple ID is not allowed on this LISA Cloud instance");
          return;
        }
        // B1: mint a per-uid account session (no longer the shared LISA_WEB_TOKEN).
        // The uid keys per-user isolation (B2) and billing (B3+).
        const acct = upsertAppleAccount(id.sub, id.email);
        const session = mintSession(acct.uid, sessionSecret, { sv: acct.sessionVersion });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, token: session, uid: acct.uid }));
      } catch (e) {
        const msg = e instanceof AppleAuthError ? e.message : "verification failed";
        res.writeHead(401, { "content-type": "text/plain" });
        res.end(`apple sign-in rejected: ${msg}`);
      }
      return;
    }

    // ── Email accounts (cloud edition; PLAN_ACCOUNTS_BILLING B1) ─────────────
    // Register/login mint access, so they run BEFORE the token gate — same
    // posture as /api/auth/apple. 404 outside the cloud edition.
    if (req.method === "POST" && (url === "/api/auth/register" || url === "/api/auth/login")) {
      if (!cloud || !sessionSecret) {
        res.writeHead(404, { "content-type": "text/plain" });
        res.end("accounts not available on this edition");
        return;
      }
      const body = await readJsonBody(req);
      const email = typeof body.email === "string" ? body.email : "";
      const password = typeof body.password === "string" ? body.password : "";
      try {
        const acct =
          url === "/api/auth/register"
            ? createEmailAccount(email, password)
            : verifyEmailLogin(email, password);
        if (!acct) {
          res.writeHead(401, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "bad_credentials" }));
          return;
        }
        const session = mintSession(acct.uid, sessionSecret, { sv: acct.sessionVersion });
        res.writeHead(200, {
          "content-type": "application/json",
          // Pin the session for browser clients (web island); Bearer clients ignore it.
          "set-cookie": `lisa_token=${encodeURIComponent(session)}; HttpOnly; SameSite=Strict; Path=/`,
        });
        res.end(JSON.stringify({ ok: true, token: session, uid: acct.uid, verified: acct.verified }));
      } catch (e) {
        if (e instanceof AccountError) {
          const status = e.code === "throttled" ? 429 : e.code === "email_taken" ? 409 : 400;
          res.writeHead(status, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: e.code }));
          return;
        }
        res.writeHead(500, { "content-type": "text/plain" });
        res.end("account operation failed");
      }
      return;
    }

    if (req.method === "POST" && url === "/api/auth/logout") {
      // Stateless sessions: logout = drop the credential client-side; here we
      // just expire the cookie for browsers. (Account-wide revocation is the
      // sessionVersion bump; per-device logout needs no server state.)
      res.writeHead(200, {
        "content-type": "application/json",
        "set-cookie": "lisa_token=; Max-Age=0; HttpOnly; SameSite=Strict; Path=/",
      });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    // uid of the authenticated LISA account, when the caller used an account
    // session (B1). null = legacy shared-token / device-token / loopback caller.
    let accountUid: string | null = null;
    let renewedCookie = false;
    if (cloud || !isLoopbackAddress(remoteAddr)) {
      const presented = presentedToken(req, url);
      // Authorized by the global LISA_WEB_TOKEN OR a non-revoked per-device token.
      let authed = isRequestAuthorized(remoteAddr, webToken, presented, !cloud);
      // Account session (cheap prefix check first). sv must still match the
      // account record, so deleted accounts lose access immediately.
      if (!authed && presented && sessionSecret && looksLikeSession(presented)) {
        const claims = verifySession(presented, sessionSecret);
        if (claims && sessionAccountValid(claims.uid, claims.sv)) {
          authed = true;
          accountUid = claims.uid;
          if (shouldRenew(claims)) {
            // Sliding renewal for cookie clients (web). Bearer clients (iOS)
            // keep their token until expiry and re-run sign-in then.
            const fresh = mintSession(claims.uid, sessionSecret, { sv: claims.sv });
            res.setHeader(
              "set-cookie",
              `lisa_token=${encodeURIComponent(fresh)}; HttpOnly; SameSite=Strict; Path=/`,
            );
            renewedCookie = true;
          }
        }
      }
      if (!authed && presented) {
        const device = verifyDeviceToken(presented);
        if (device) {
          authed = true;
          touchDevice(device.id);
        }
      }
      if (!authed) {
        // Browsers hitting the cloud edition get the login page (still 401 —
        // correct semantics, human-usable body). API callers get structured
        // JSON: no token presented vs a mismatch vs an instance with no token
        // configured at all. The presented value is never echoed back.
        const wantsHtml = (req.headers.accept ?? "").includes("text/html");
        if (cloud && req.method === "GET" && wantsHtml) {
          res.writeHead(401, { "content-type": "text/html; charset=utf-8" });
          res.end(LOGIN_HTML);
          return;
        }
        const reason = !webToken
          ? "server_not_configured"
          : presented
            ? "token_mismatch"
            : "token_missing";
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "unauthorized", reason }));
        return;
      }
      // Token arrived via query param (first open from a phone): pin it as a
      // cookie so subsequent same-origin fetch/EventSource calls authenticate.
      // presented is non-null here — isRequestAuthorized returned true for a
      // non-loopback caller, which requires a matching token. (Skip when the
      // sliding renewal above already set a fresher cookie.)
      if (presented && !renewedCookie && !req.headers.cookie?.includes("lisa_token=")) {
        res.setHeader(
          "set-cookie",
          `lisa_token=${encodeURIComponent(presented)}; HttpOnly; SameSite=Strict; Path=/`,
        );
      }
      // ── Per-uid home scope (B2) ────────────────────────────────────────────
      // From here on, every path helper — soul, sessions, memory, billing —
      // resolves into this account's subtree, including across awaits
      // (AsyncLocalStorage.enterWith sticks to this async chain).
      if (cloud && accountUid) {
        const uidHome = homeForUid(accountUid);
        await fs.mkdir(uidHome, { recursive: true });
        homeScope.enterWith(uidHome);
        ensureUserBirth(accountUid);
      }
    }

    // ── Account introspection + deletion (post-gate; PLAN_ACCOUNTS_BILLING B1) ──
    if (req.method === "GET" && url === "/api/auth/me") {
      const acct = accountUid ? getAccount(accountUid) : null;
      res.writeHead(200, { "content-type": "application/json" });
      // plan/tier is a placeholder until the quota engine (B4) lands.
      res.end(
        JSON.stringify(
          acct
            ? { signedIn: true, uid: acct.uid, kind: acct.kind, email: acct.email ?? null, verified: acct.verified, plan: "free" }
            : { signedIn: false },
        ),
      );
      return;
    }

    if (req.method === "DELETE" && url === "/api/account") {
      // App Store 5.1.1(v): in-app account deletion. Session-authed only — the
      // shared demo token must not be able to delete accounts.
      if (!accountUid) {
        res.writeHead(403, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "account_session_required" }));
        return;
      }
      const removed = deleteAccount(accountUid);
      // Remove the per-uid home + in-memory context. The account record going
      // away already killed every session via the sv-check.
      try {
        const userHome = homeForUid(accountUid);
        // Refuse to follow a surprising path — belt & braces against uid tampering
        // (uids are server-minted, but cheap to double-check).
        if (userHome.startsWith(path.join(lisaGlobalHome(), "users") + path.sep)) {
          await fs.rm(userHome, { recursive: true, force: true });
        }
        uidChats.delete(userHome);
        promptCache.delete(userHome);
      } catch (e) {
        console.error(`[auth] account home cleanup failed: ${(e as Error).message}`);
      }
      res.writeHead(200, {
        "content-type": "application/json",
        "set-cookie": "lisa_token=; Max-Age=0; HttpOnly; SameSite=Strict; Path=/",
      });
      res.end(JSON.stringify({ ok: true, removed }));
      return;
    }

    // Per-request gate for high-risk control actions from REMOTE callers. The Mac
    // owner (loopback) is never gated; a remote (token) device may take only what
    // the Mac-side policy permits. denyRemote() writes the 403 and returns true
    // when blocked, so call sites read `if (denyRemote(...)) return;`. See
    // src/control/policy.ts (default: control own agents yes, adopt external no).
    const remoteControlAllowed = (need: "control" | "adoptExternal"): boolean => {
      if (isLoopbackAddress(remoteAddr)) return true;
      const pol = loadControlPolicy();
      return need === "adoptExternal" ? pol.remoteAdoptExternal : pol.remoteControl;
    };
    const denyRemote = (need: "control" | "adoptExternal"): boolean => {
      if (remoteControlAllowed(need)) return false;
      res.writeHead(403, { "content-type": "text/plain" });
      res.end(
        need === "adoptExternal"
          ? "adopting external sessions from a remote device is disabled — enable remoteAdoptExternal on the Mac (POST /api/control/policy from localhost)"
          : "remote control is disabled — enable remoteControl on the Mac (POST /api/control/policy from localhost)",
      );
      return true;
    };

    if (req.method === "GET" && (url === "/" || url.startsWith("/?"))) {
      // no-store: never cache the shell, or a WKWebView / browser keeps rendering
      // an old GUI after `lisa` is updated (the shell carries the current markup +
      // asset references). Fixes the "removed element still shows" stale-cache bug.
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(MAIN_HTML);
      return;
    }

    // Edition + capability descriptor — the client hides Mac-only surfaces
    // (PTY/adopt, local dispatch, Sense, agent control) in the cloud edition.
    if (req.method === "GET" && url === "/api/edition") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(editionInfo()));
      return;
    }

    // Island widget — designed to be opened in a tiny browser window
    // (Arc, Vivaldi PWA, Safari split). See docs/MAC_ISLAND_PLAN.md.
    if (req.method === "GET" && (url === "/island" || url.startsWith("/island?"))) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(ISLAND_HTML);
      return;
    }

    // Room — an ambient, state-driven pixel-art living space where Lisa "lives".
    // Reuses /events + /api/island/ping. See docs/PLAN_ROOM_v1.0.md.
    if (req.method === "GET" && (url === "/room" || url.startsWith("/room?"))) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(ROOM_HTML);
      return;
    }

    // Light status endpoint for the island. Polled every 5–30s as a
    // fallback when SSE has been quiet.
    if (req.method === "GET" && url === "/api/island/ping") {
      let currentDesire: string | null = null;
      try {
        // Closed desires are finished — never surface one as her current/focused.
        const desires = (await listDesires()).filter((d) => !d.closed);
        // If the conversation is live and clearly about one of her desires,
        // surface THAT (intra-session focus — tracks the turn-by-turn topic).
        // Otherwise fall back to the most recently ACTIVE desire (authored or
        // pursued), not whichever fs.readdir listed first. See PLAN_DESIRE_EVOLUTION.
        // Freshness is measured from the last real user message (lastUserMessageAt,
        // reset to 0 on restart) — NOT the process-wide idle clock, which starts
        // "fresh" after a launchd restart and would pin focus onto a stale
        // resumed conversation for up to FOCUS_FRESHNESS_MS.
        const focused =
          lastUserMessageAt > 0 &&
          Date.now() - lastUserMessageAt < FOCUS_FRESHNESS_MS
            ? pickFocusedDesire(desires, recentUserText(history))
            : null;
        // Only compute activity (an fs.stat per desire) when we actually fall
        // back to the recency pick — `??` short-circuits it away on a focus hit.
        currentDesire =
          (focused ?? pickCurrentDesire(desires, await desireActivity(desires)))?.what ?? null;
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

    // Screen advisor config — GET current, POST to update (loopback only,
    // since it controls periodic screen capture). GET also reports `supported`
    // (macOS only) and the latest suggestion so a fresh island can render it.
    if (req.method === "GET" && url === "/api/screen-advisor/config") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ...screenCfg, supported: captureSupported() }));
      return;
    }
    if (req.method === "GET" && url === "/api/screen-advisor/latest") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ suggestion: lastScreenSuggestion }));
      return;
    }
    if (req.method === "POST" && url === "/api/screen-advisor/config") {
      const remote = req.socket.remoteAddress ?? "";
      const isLoopback =
        remote === "127.0.0.1" ||
        remote === "::1" ||
        remote === "::ffff:127.0.0.1" ||
        remote.startsWith("127.");
      if (!isLoopback) {
        res.writeHead(403, { "content-type": "text/plain" });
        res.end("screen-advisor config only accepted from localhost");
        return;
      }
      let saBody = "";
      for await (const chunk of req) saBody += chunk.toString("utf8");
      let payload: Partial<ScreenAdvisorConfig>;
      try {
        payload = JSON.parse(saBody || "{}") as Partial<ScreenAdvisorConfig>;
      } catch {
        res.writeHead(400, { "content-type": "text/plain" });
        res.end("bad json");
        return;
      }
      screenCfg = normalizeConfig({ ...screenCfg, ...payload });
      try {
        await saveScreenAdvisorConfig(screenCfg);
      } catch (err) {
        res.writeHead(500, { "content-type": "text/plain" });
        res.end((err as Error).message);
        return;
      }
      restartScreenTimer();
      console.error(
        `[screen-advisor] config: enabled=${screenCfg.enabled} every=${screenCfg.intervalMinutes}m`,
      );
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, ...screenCfg, supported: captureSupported() }));
      return;
    }

    // Vision: capture a screenshot via the macOS screencapture utility and

    // return it as a chat attachment. {cancelled:true} when the user hits

    // Escape. 501 on non-macOS. Body: { mode?: "interactive" | "full" }.

    if (req.method === "POST" && url === "/api/vision/capture") {
      if (!captureSupported()) {
        res.writeHead(501, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "screen capture is only supported on macOS" }));
        return;
      }
      let visionBody = "";
      for await (const chunk of req) visionBody += chunk.toString("utf8");
      console.error("[vision] capture requested");
      let mode: CaptureMode = "interactive";
      try {
        const parsed = visionBody ? (JSON.parse(visionBody) as { mode?: CaptureMode }) : {};
        if (parsed.mode === "full" || parsed.mode === "interactive") mode = parsed.mode;
      } catch { /* default interactive */ }
      try {
        const shot = await captureScreenshot(mode);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(shot ? { file: shot } : { cancelled: true }));
      } catch (err) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: (err as Error).message }));
      }
      return;
    }

    // Voice: transcribe an audio clip recorded in the browser. Body is JSON
    // { data: <base64>, mediaType?: string }. Writes a temp file, runs the
    // existing Whisper transcriber, returns { transcript } and deletes the
    // temp. The browser records via MediaRecorder; LISA then summarizes the
    // transcript through the normal chat flow (server-side summarization is
    // the model's job, not a special endpoint). 400 on missing data; the
    // transcriber itself errors clearly if OPENAI_API_KEY is unset.
    if (req.method === "POST" && url === "/api/voice/transcribe") {
      let voiceBody = "";
      for await (const chunk of req) voiceBody += chunk.toString("utf8");
      let payload: { data?: string; mediaType?: string; mode?: string };
      try {
        payload = JSON.parse(voiceBody || "{}");
      } catch {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "invalid JSON body" }));
        return;
      }
      if (!payload.data) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "missing audio data" }));
        return;
      }
      // Pick an extension Whisper accepts based on the recorder's mimeType.
      const mt = payload.mediaType ?? "audio/webm";
      const ext = mt.includes("mp4") || mt.includes("m4a")
        ? "m4a"
        : mt.includes("ogg")
          ? "ogg"
          : mt.includes("wav")
            ? "wav"
            : "webm";
      const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      const tmp = path.join(os.tmpdir(), `lisa-rec-${stamp}-${process.pid}.${ext}`);
      try {
        await fs.writeFile(tmp, Buffer.from(payload.data, "base64"));
        console.error(`[voice] transcribing ${Buffer.from(payload.data, "base64").length} bytes (${ext})`);
        const transcript = await transcribeAudio({ audioPath: tmp });
        // S2-voice: when `voice` is granted, distill this push-to-talk transcript
        // into the ambient sense log (PII-redacted, no audio). No-op otherwise,
        // so dictation works unchanged when voice consent is off.
        voiceSource.ingest(transcript);
        // Dictation mode (Typeless-equivalent): polish the raw transcript into
        // the clean text the speaker intended (filler/repetition removed,
        // self-corrections applied, punctuation + formatting), to drop into the
        // composer. Falls back to the raw transcript if the polish call fails.
        let text: string | undefined;
        if (payload.mode === "dictation") {
          try {
            text = await polishDictation({
              provider: getProvider() as unknown as DictationProvider,
              model: opts.model,
              transcript,
            });
          } catch (err) {
            console.error(`[voice] dictation polish failed: ${(err as Error).message}`);
            text = transcript;
          }
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(text !== undefined ? { transcript, text } : { transcript }));
      } catch (err) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: (err as Error).message }));
      } finally {
        await fs.rm(tmp, { force: true }).catch(() => {});
      }
      return;
    }

    if (req.method === "POST" && url === "/api/island/dismiss-unread") {
      lastIdleMessage = null;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    // Latest advisor suggestions, for a freshly opened island.
    if (req.method === "GET" && url === "/api/advisor/latest") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(lastAdvisorSuggestions ?? { suggestions: [], at: null }));
      return;
    }

    // ✕ on an advisor suggestion: persist the dismissal so the category
    // down-weights over time ("learns to shut up"), and drop it from the
    // cached card so a refreshed island doesn't resurrect it.
    if (req.method === "POST" && url === "/api/advisor/dismiss") {
      let dBody = "";
      for await (const chunk of req) dBody += chunk.toString("utf8");
      let payload: { id?: unknown; category?: unknown };
      try {
        payload = JSON.parse(dBody || "{}");
      } catch {
        res.writeHead(400, { "content-type": "text/plain" });
        res.end("bad json");
        return;
      }
      if (typeof payload.id !== "string" || typeof payload.category !== "string") {
        res.writeHead(400, { "content-type": "text/plain" });
        res.end("id and category required");
        return;
      }
      try {
        await dismissSuggestion(payload.id, payload.category as SuggestionCategory);
      } catch (err) {
        res.writeHead(500, { "content-type": "text/plain" });
        res.end((err as Error).message);
        return;
      }
      if (lastAdvisorSuggestions) {
        lastAdvisorSuggestions = {
          ...lastAdvisorSuggestions,
          suggestions: lastAdvisorSuggestions.suggestions.filter((s) => s.id !== payload.id),
        };
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    // ── Consent (FOUNDATIONS §1) ────────────────────────────────────────
    // The island's "always visible + one-tap stop" surface. GET lists every
    // sense signal + status; the POSTs grant/revoke/stop-all. Sources gate on
    // isGranted() server-side regardless — this is control, not the gate.
    if (req.method === "GET" && url === "/api/consent") {
      const grants = listGrants().map((g) => ({
        ...g,
        description: SIGNAL_DESCRIPTIONS[g.signal] ?? "",
      }));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ grants }));
      return;
    }
    // D4b — list/cancel LISA's OWN dispatched agents over HTTP. Behind the auth
    // gate like every endpoint (loopback or token). Reuses signal_agent, so it
    // can ONLY touch dispatch-ledger pids — never an arbitrary process.
    if (req.method === "POST" && url === "/api/agent/signal") {
      let sigBody = "";
      for await (const chunk of req) sigBody += chunk.toString("utf8");
      let payload: { action?: unknown; target?: unknown; force?: unknown };
      try {
        payload = JSON.parse(sigBody || "{}");
      } catch {
        res.writeHead(400, { "content-type": "text/plain" });
        res.end("bad json");
        return;
      }
      const action = payload.action === "list" ? "list" : payload.action === "cancel" ? "cancel" : null;
      if (!action) {
        res.writeHead(400, { "content-type": "text/plain" });
        res.end("action must be 'list' or 'cancel'");
        return;
      }
      if (action === "cancel" && denyRemote("control")) return;
      const result = await signalAgentTool.execute(
        {
          action,
          target: typeof payload.target === "string" ? payload.target : undefined,
          force: payload.force === true,
        },
        { cwd: process.cwd(), signal: new AbortController().signal, log: () => {} },
      );
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, result }));
      return;
    }

    // ── Managed agents (control plane) ──────────────────────────────────
    // LISA's own controllable agents: start a task, send follow-ups, cancel,
    // and approve/deny each mutating tool. Behind the auth gate like every
    // endpoint. They appear in the roster via the "managed" hub observer.
    // Device pairing: mint a per-device token (loopback-only — the Mac owner
    // pairs a phone by showing the returned token as a QR). The raw token is
    // returned ONCE; only its hash is stored. The phone then authenticates with
    // it like the global token (Bearer / ?token= / cookie).
    if (req.method === "POST" && url === "/api/pair/start") {
      if (!isLoopbackAddress(remoteAddr)) {
        res.writeHead(403, { "content-type": "text/plain" });
        res.end("pairing can only be started from the Mac (localhost)");
        return;
      }
      let prBody = "";
      for await (const chunk of req) prBody += chunk.toString("utf8");
      let payload: { name?: unknown; platform?: unknown; host?: unknown } = {};
      try { payload = prBody ? JSON.parse(prBody) : {}; } catch { /* tolerate */ }
      const name = typeof payload.name === "string" ? payload.name : "device";
      const platform = typeof payload.platform === "string" ? payload.platform : "ios";
      const { id, token, device } = mintDevice(name, platform);
      // Detect a phone-reachable LAN host server-side so every client (CLI, Mac
      // app, web UI) can show consistent, copyable pairing details — the browser
      // can't discover the Mac's LAN IP on its own. A caller-supplied host wins.
      const host =
        typeof payload.host === "string" && payload.host.trim()
          ? payload.host.trim()
          : detectLanHost();
      const url = host ? buildPairUrl(host, opts.port, token, name) : undefined;
      // The interface the server is actually bound to. If it's loopback-only, a
      // phone can't reach it however good the QR is — the client warns on this.
      const boundHost = opts.host ?? "127.0.0.1";
      // A scannable QR of the pairing link, for the web "Pair phone" modal (the
      // browser equivalent of the CLI's terminal QR). Only when we have a url.
      const qr = url ? qrSvg(url) : undefined;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, id, token, port: opts.port, host, url, boundHost, qrSvg: qr, device }));
      return;
    }
    if (req.method === "GET" && url === "/api/devices") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ devices: listDevices() }));
      return;
    }
    if (req.method === "POST" && url === "/api/devices/revoke") {
      if (!isLoopbackAddress(remoteAddr)) {
        res.writeHead(403, { "content-type": "text/plain" });
        res.end("device revocation is a Mac-owner action (localhost only)");
        return;
      }
      let rvBody = "";
      for await (const chunk of req) rvBody += chunk.toString("utf8");
      let payload: { id?: unknown } = {};
      try { payload = rvBody ? JSON.parse(rvBody) : {}; } catch { /* tolerate */ }
      const removed = revokeDevice(typeof payload.id === "string" ? payload.id : "");
      res.writeHead(removed ? 200 : 404, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: removed }));
      return;
    }

    // Push registration: a phone registers its own delivery target (ntfy topic or
    // APNs token) + prefs — authed (the device does this remotely). Low-sensitivity
    // metadata only; see push.ts.
    if (req.method === "POST" && url === "/api/push/register") {
      let puBody = "";
      for await (const chunk of req) puBody += chunk.toString("utf8");
      let payload: { kind?: unknown; target?: unknown; server?: unknown; prefs?: Partial<PushPrefs> } = {};
      try { payload = puBody ? JSON.parse(puBody) : {}; } catch { /* tolerate */ }
      if (typeof payload.target !== "string" || !payload.target.trim()) {
        res.writeHead(400, { "content-type": "text/plain" }); res.end("target required (ntfy topic or apns token)"); return;
      }
      const sub = registerPush({
        kind: typeof payload.kind === "string" ? payload.kind : "ntfy",
        target: payload.target,
        server: typeof payload.server === "string" ? payload.server : undefined,
        prefs: payload.prefs,
      });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, subscription: sub }));
      return;
    }
    if (req.method === "POST" && url === "/api/push/unregister") {
      let puBody = "";
      for await (const chunk of req) puBody += chunk.toString("utf8");
      let payload: { id?: unknown; target?: unknown } = {};
      try { payload = puBody ? JSON.parse(puBody) : {}; } catch { /* tolerate */ }
      const key = typeof payload.id === "string" ? payload.id : typeof payload.target === "string" ? payload.target : "";
      const removed = unregisterPush(key);
      res.writeHead(removed ? 200 : 404, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: removed }));
      return;
    }
    // Register/unregister a Live Activity push token for a pinned session — the
    // push-bridge then refreshes that activity over APNs as the agent updates.
    if (req.method === "POST" && url === "/api/push/live-activity") {
      let laBody = "";
      for await (const chunk of req) laBody += chunk.toString("utf8");
      let payload: { sessionId?: unknown; token?: unknown } = {};
      try { payload = laBody ? JSON.parse(laBody) : {}; } catch { /* tolerate */ }
      if (typeof payload.sessionId !== "string" || !payload.sessionId) {
        res.writeHead(400, { "content-type": "text/plain" }); res.end("sessionId required"); return;
      }
      if (typeof payload.token === "string" && payload.token) {
        registerLiveActivity(payload.sessionId, payload.token);
      } else {
        unregisterLiveActivity(payload.sessionId);
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (req.method === "GET" && url === "/api/push/list") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ subscriptions: listPush() }));
      return;
    }
    if (req.method === "POST" && url === "/api/push/prefs") {
      let puBody = "";
      for await (const chunk of req) puBody += chunk.toString("utf8");
      let payload: { id?: unknown; prefs?: Partial<PushPrefs> } = {};
      try { payload = puBody ? JSON.parse(puBody) : {}; } catch { /* tolerate */ }
      const sub = typeof payload.id === "string" ? setPushPrefs(payload.id, payload.prefs ?? {}) : null;
      res.writeHead(sub ? 200 : 404, { "content-type": "application/json" });
      res.end(JSON.stringify(sub ? { ok: true, subscription: sub } : { ok: false }));
      return;
    }

    // ── Mail module (read-only): accounts, connect, sweep, digest ───────
    if (req.method === "GET" && url === "/api/mail/accounts") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ accounts: loadAccounts(), consent: isGranted("mail") }));
      return;
    }
    if (req.method === "GET" && url === "/api/mail/digest") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ digest: latestDigest() }));
      return;
    }
    if (req.method === "POST" && url === "/api/mail/connect") {
      let mBody = "";
      for await (const chunk of req) mBody += chunk.toString("utf8");
      let p: { email?: unknown; host?: unknown; port?: unknown; password?: unknown; label?: unknown };
      try { p = JSON.parse(mBody || "{}"); } catch {
        res.writeHead(400, { "content-type": "text/plain" }); res.end("bad json"); return;
      }
      const email = typeof p.email === "string" ? p.email.trim() : "";
      const password = typeof p.password === "string" ? p.password : "";
      if (!email.includes("@") || !password) {
        res.writeHead(400, { "content-type": "text/plain" }); res.end("email + password required"); return;
      }
      const host = typeof p.host === "string" && p.host ? p.host : inferHost(email);
      if (!host) {
        res.writeHead(400, { "content-type": "text/plain" }); res.end("Could not detect the IMAP host — add it manually."); return;
      }
      const port = typeof p.port === "number" ? p.port : 993;
      // Verify the credentials actually sign in before storing them: a mailbox
      // that silently fails every sweep is exactly the confusion we avoid here.
      try {
        await probeAccount({ provider: "imap", email, host, port }, { password }, { timeoutMs: 20_000 });
      } catch (err) {
        res.writeHead(401, { "content-type": "text/plain" });
        res.end(friendlyMailError(err, email, host));
        return;
      }
      const account = addAccount(
        {
          provider: "imap",
          email,
          host,
          port,
          label: typeof p.label === "string" ? p.label : undefined,
        },
        { password },
      );
      grant("mail"); // connecting a mailbox is the consent act
      broadcast({ type: "mail_accounts_update", at: new Date().toISOString() });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, account }));
      return;
    }
    if (req.method === "POST" && url.startsWith("/api/mail/accounts/")) {
      const rest = url.slice("/api/mail/accounts/".length);
      const slash = rest.indexOf("/");
      const id = decodeURIComponent(slash >= 0 ? rest.slice(0, slash) : rest);
      const action = slash >= 0 ? rest.slice(slash + 1) : "";
      let ok = false;
      if (action === "remove") ok = removeAccount(id);
      else if (action === "enable") ok = setAccountEnabled(id, true);
      else if (action === "disable") ok = setAccountEnabled(id, false);
      else {
        res.writeHead(400, { "content-type": "text/plain" }); res.end("action must be remove|enable|disable"); return;
      }
      if (ok) broadcast({ type: "mail_accounts_update", at: new Date().toISOString() });
      res.writeHead(ok ? 200 : 404, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok }));
      return;
    }
    if (req.method === "POST" && url === "/api/mail/sweep") {
      if (!isGranted("mail")) {
        res.writeHead(409, { "content-type": "text/plain" });
        res.end("mail consent not granted");
        return;
      }
      const swept = await sweepAll();
      if (!swept.blocked) afterMailDigest(swept.digest);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: !swept.blocked, digest: swept.digest, newItems: swept.newItems.length }));
      return;
    }

    // Remote-control policy: GET (any authed caller) reports it; POST sets it,
    // but only from localhost (the Mac owner) — like the API-key save.
    if (req.method === "GET" && url === "/api/control/policy") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(loadControlPolicy()));
      return;
    }
    if (req.method === "POST" && url === "/api/control/policy") {
      if (!isLoopbackAddress(remoteAddr)) {
        res.writeHead(403, { "content-type": "text/plain" });
        res.end("control policy can only be changed from the Mac (localhost)");
        return;
      }
      let cpBody = "";
      for await (const chunk of req) cpBody += chunk.toString("utf8");
      let payload: Partial<ControlPolicy>;
      try { payload = JSON.parse(cpBody || "{}"); } catch {
        res.writeHead(400, { "content-type": "text/plain" }); res.end("bad json"); return;
      }
      try {
        const saved = saveControlPolicy({ ...loadControlPolicy(), ...payload });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, ...saved }));
      } catch (err) {
        res.writeHead(500, { "content-type": "text/plain" });
        res.end((err as Error).message);
      }
      return;
    }

    // Autonomy on/off — the "Proactive mode" master switch surfaced in the web
    // GUI + iOS as the Proactive toggle. GET reports it (any authed caller);
    // POST sets it. Unlike the control policy (loopback-only), this is allowed
    // from any authed device — letting Lisa rest is low-risk, and pausing her
    // from the phone is a primary use case. The token gate (above) still applies.
    if (req.method === "GET" && url === "/api/autonomy/state") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(loadAutonomyState()));
      return;
    }
    if (req.method === "POST" && url === "/api/autonomy/state") {
      let asBody = "";
      for await (const chunk of req) asBody += chunk.toString("utf8");
      let payload: Partial<AutonomyState>;
      try { payload = JSON.parse(asBody || "{}"); } catch {
        res.writeHead(400, { "content-type": "text/plain" }); res.end("bad json"); return;
      }
      try {
        const saved = saveAutonomyState({ ...loadAutonomyState(), ...payload });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(saved));
      } catch (err) {
        res.writeHead(500, { "content-type": "text/plain" });
        res.end((err as Error).message);
      }
      return;
    }

    // Structured view of the agents LISA dispatched fire-and-forget (the ledger).
    // Complements /api/agent/signal's action:"list" (which returns prose): this is
    // JSON for clients (the iOS roster). Structural only — never the captured log.
    if (req.method === "GET" && url === "/api/dispatch/list") {
      const dispatches = listRecentDispatches().map((e) => toDispatchView(e, isAlive(e.pid)));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ dispatches }));
      return;
    }

    // Status + captured-output tail of ONE dispatched agent. The tail is raw
    // stdout (potentially sensitive), so it's behind the remote-control gate
    // (loopback always; remote per policy). ?id=<dispatch id>.
    if (req.method === "GET" && url.startsWith("/api/dispatch/status")) {
      if (denyRemote("control")) return;
      const id = new URL(url, "http://localhost").searchParams.get("id") ?? "";
      const entry = id ? listRecentDispatches().find((e) => e.id === id) : undefined;
      if (!entry) {
        res.writeHead(id ? 404 : 400, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: id ? "no such dispatch" : "id required" }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        ok: true,
        ...toDispatchView(entry, isAlive(entry.pid)),
        tail: readDispatchOutput(entry, 4000),
      }));
      return;
    }

    if (req.method === "POST" && url === "/api/agents/managed/start") {
      if (denyRemote("control")) return;
      let mBody = "";
      for await (const chunk of req) mBody += chunk.toString("utf8");
      let payload: { task?: unknown; cwd?: unknown; model?: unknown };
      try { payload = JSON.parse(mBody || "{}"); } catch {
        res.writeHead(400, { "content-type": "text/plain" }); res.end("bad json"); return;
      }
      if (typeof payload.task !== "string" || !payload.task.trim()) {
        res.writeHead(400, { "content-type": "text/plain" }); res.end("task required"); return;
      }
      const cwd = typeof payload.cwd === "string" && payload.cwd.startsWith("/") ? payload.cwd : process.cwd();
      // A managed agent doesn't control other agents — drop dispatch/signal.
      const tools = opts.tools.filter((t) => t.name !== "dispatch_agent" && t.name !== "signal_agent");
      const systemPrompt =
        `You are a delegated agent working in ${cwd}, launched by the user through Lisa. ` +
        `Complete the user's task using the available tools, then report what you did concisely. ` +
        `Mutating actions (writes, shell, etc.) pause for the user's approval — keep going after each decision.`;
      const view = managedRegistry.start({
        task: payload.task,
        cwd,
        systemPrompt,
        tools,
        model: typeof payload.model === "string" ? payload.model : opts.model,
      });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, agent: view }));
      return;
    }
    if (req.method === "POST" && url.startsWith("/api/agents/managed/")) {
      if (denyRemote("control")) return;
      const rest = url.slice("/api/agents/managed/".length);
      const slash = rest.indexOf("/");
      const id = slash >= 0 ? rest.slice(0, slash) : rest;
      const action = slash >= 0 ? rest.slice(slash + 1) : "";
      let mBody = "";
      for await (const chunk of req) mBody += chunk.toString("utf8");
      let payload: { text?: unknown; allow?: unknown } = {};
      try { payload = mBody ? JSON.parse(mBody) : {}; } catch { /* tolerate empty/none */ }
      let ok = false;
      if (action === "send" && typeof payload.text === "string") ok = managedRegistry.send(id, payload.text);
      else if (action === "cancel") ok = managedRegistry.cancel(id);
      else if (action === "approve") ok = managedRegistry.decide(id, payload.allow !== false);
      else {
        res.writeHead(400, { "content-type": "text/plain" });
        res.end("action must be send|cancel|approve");
        return;
      }
      res.writeHead(ok ? 200 : 404, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok }));
      return;
    }

    // ── PTY agents (Stage C spike, off unless LISA_PTY_AGENTS=1) ─────────
    // Real `claude`/`codex` CLIs LISA spawns under a pseudo-terminal: it types
    // your task + follow-ups and can read the terminal tail. Behind the same
    // auth gate; 503 when the spike flag is off / node-pty is absent.
    if (req.method === "POST" && url === "/api/agents/pty/start") {
      let pBody = "";
      for await (const chunk of req) pBody += chunk.toString("utf8");
      let payload: { agent?: unknown; task?: unknown; cwd?: unknown; resumeSessionId?: unknown };
      try { payload = JSON.parse(pBody || "{}"); } catch {
        res.writeHead(400, { "content-type": "text/plain" }); res.end("bad json"); return;
      }
      if (!ptyEnabled()) {
        res.writeHead(503, { "content-type": "text/plain" });
        res.end("PTY agents are disabled — set LISA_PTY_AGENTS=1 to enable this spike");
        return;
      }
      const agent = typeof payload.agent === "string" && payload.agent.trim() ? payload.agent : "claude";
      const resumeSessionId =
        typeof payload.resumeSessionId === "string" && payload.resumeSessionId ? payload.resumeSessionId : undefined;
      // Adopting an external session is the highest-risk control action — gate it
      // behind remoteAdoptExternal; starting a fresh agent is ordinary control.
      if (denyRemote(resumeSessionId ? "adoptExternal" : "control")) return;
      // Resume-adopt is claude-only (docs/PTY_AGENTS.md). Codex has no liveness
      // signal, so we can't guard against resuming a *live* rollout and corrupting
      // it — refuse with a clear 400 rather than silently spawning a fresh session.
      if (resumeSessionId && normalizeAgentKind(agent) !== "claude-code") {
        res.writeHead(400, { "content-type": "text/plain" });
        res.end(`resume-adopt is only supported for claude sessions (got "${agent}"); start a fresh agent instead`);
        return;
      }
      // Adopting an existing session needs no task (it continues the convo); a
      // fresh agent does. Guard: never resume a session that's currently live.
      if (!resumeSessionId && (typeof payload.task !== "string" || !payload.task.trim())) {
        res.writeHead(400, { "content-type": "text/plain" }); res.end("task required"); return;
      }
      if (resumeSessionId && liveClaudeSessionIds().has(resumeSessionId)) {
        res.writeHead(409, { "content-type": "text/plain" });
        res.end("that session is currently live (open in the app/terminal) — close it first; resuming a live session would corrupt its transcript");
        return;
      }
      const cwd = typeof payload.cwd === "string" && payload.cwd.startsWith("/") ? payload.cwd : process.cwd();
      try {
        const view = await ptyRegistry.start({
          agent,
          task: typeof payload.task === "string" ? payload.task : "",
          cwd,
          resumeSessionId,
        });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, agent: view }));
      } catch (err) {
        res.writeHead(503, { "content-type": "text/plain" });
        res.end((err as Error).message);
      }
      return;
    }
    if (req.method === "GET" && url.startsWith("/api/agents/pty/") && url.endsWith("/output")) {
      if (denyRemote("control")) return;
      const id = url.slice("/api/agents/pty/".length, -"/output".length);
      const out = ptyRegistry.output(decodeURIComponent(id));
      if (out === null) {
        res.writeHead(404, { "content-type": "application/json" }); res.end(JSON.stringify({ ok: false }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, output: out }));
      return;
    }
    // Live attach stream for a PTY agent: the current output tail (snapshot), then
    // each new ANSI-stripped chunk as it arrives. Drives `lisa agents pty`
    // (adopt-at-launch) and a remote live-output view. Same auth gate; 404 if unknown.
    if (req.method === "GET" && url.startsWith("/api/agents/pty/") && url.endsWith("/stream")) {
      if (denyRemote("control")) return;
      const id = decodeURIComponent(url.slice("/api/agents/pty/".length, -"/stream".length));
      const initial = ptyRegistry.output(id);
      if (initial === null) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false }));
        return;
      }
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      res.write(`data: ${JSON.stringify({ type: "snapshot", text: initial })}\n\n`);
      const onOut = (e: { id: string; chunk: string }) => {
        if (e.id !== id) return;
        try {
          res.write(`data: ${JSON.stringify({ type: "chunk", text: e.chunk })}\n\n`);
        } catch {
          /* dead connection — cleaned up on close */
        }
      };
      // End the stream when the agent finishes, so an attach client exits cleanly.
      const onUpdate = (v: { id: string; state: string }) => {
        if (v.id !== id || v.state !== "done") return;
        try {
          res.write(`data: ${JSON.stringify({ type: "end", state: v.state })}\n\n`);
          res.end();
        } catch {
          /* already closed */
        }
      };
      ptyRegistry.on("output", onOut);
      ptyRegistry.on("update", onUpdate);
      req.on("close", () => {
        ptyRegistry.off("output", onOut);
        ptyRegistry.off("update", onUpdate);
      });
      return;
    }
    if (req.method === "POST" && url.startsWith("/api/agents/pty/")) {
      if (denyRemote("control")) return;
      const rest = url.slice("/api/agents/pty/".length);
      const slash = rest.indexOf("/");
      const id = decodeURIComponent(slash >= 0 ? rest.slice(0, slash) : rest);
      const action = slash >= 0 ? rest.slice(slash + 1) : "";
      let pBody = "";
      for await (const chunk of req) pBody += chunk.toString("utf8");
      let payload: { text?: unknown } = {};
      try { payload = pBody ? JSON.parse(pBody) : {}; } catch { /* tolerate */ }
      let ok = false;
      if (action === "send" && typeof payload.text === "string") ok = ptyRegistry.send(id, payload.text);
      else if (action === "cancel") ok = ptyRegistry.cancel(id);
      else {
        res.writeHead(400, { "content-type": "text/plain" });
        res.end("action must be send|cancel");
        return;
      }
      res.writeHead(ok ? 200 : 404, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok }));
      return;
    }

    // Recent ambient sense events, for the island's "recently sensed" list.
    if (req.method === "GET" && url === "/api/sense/recent") {
      const events = readSenseEvents().slice(-30).reverse(); // newest first
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ events }));
      return;
    }
    if (req.method === "POST" && url === "/api/consent/revoke-all") {
      revokeAll();
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, grants: listGrants() }));
      return;
    }
    if (
      req.method === "POST" &&
      (url === "/api/consent/grant" || url === "/api/consent/revoke")
    ) {
      let cBody = "";
      for await (const chunk of req) cBody += chunk.toString("utf8");
      let payload: { signal?: unknown };
      try {
        payload = JSON.parse(cBody || "{}");
      } catch {
        res.writeHead(400, { "content-type": "text/plain" });
        res.end("bad json");
        return;
      }
      const signal = payload.signal;
      // Only the canonical sense signals are togglable from the UI.
      if (typeof signal !== "string" || !SENSE_SIGNALS.includes(signal)) {
        res.writeHead(400, { "content-type": "text/plain" });
        res.end(`signal must be one of: ${SENSE_SIGNALS.join(", ")}`);
        return;
      }
      if (url === "/api/consent/grant") grant(signal);
      else revoke(signal);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, grants: listGrants() }));
      return;
    }

    // Cross-agent session snapshot (O1). Returns every active session
    // across all integrations, normalized. activity (Tier 2) is present
    // when the integration runs at visibility ≥ "activity".
    if (req.method === "GET" && url === "/api/agents/sessions") {
      // Mark idle claude sessions as adoptable: not currently live (no running
      // owner ⇒ `claude --resume` is safe) and not already a LISA-controlled row.
      const live = liveClaudeSessionIds();
      const sessions = hub.list().map((s) => ({
        ...s,
        lastMtime: new Date(s.lastMtime).toISOString(),
        ...(s.agent === "claude-code" && !s.controllable && !live.has(s.sessionId)
          ? { resumable: true }
          : {}),
      }));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ sessions }));
      return;
    }

    // L6 — cross-agent "while you were away" recap, synthesized from the
    // journal. ?sinceMinutes=N (default 120) bounds the window.
    if (req.method === "GET" && url.startsWith("/api/agents/recap")) {
      const q = new URL(url, "http://localhost").searchParams;
      const mins = Math.max(1, Math.min(1440, Number(q.get("sinceMinutes")) || 120));
      const { eventsSince } = await import("../orchestrator/journal.js");
      const now = Date.now();
      const recap = buildRecap(eventsSince(now - mins * 60_000), now - mins * 60_000, now);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ recap, text: formatRecap(recap), sinceMinutes: mins }));
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
const CACHE = 'lisa-v8-music';
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
  // Network-first for / and the manifest — the app shell. The server sends the
  // shell with no-store precisely so an update shows immediately; the old
  // stale-while-revalidate here re-introduced a stale shell (a GUI update took
  // two refreshes to appear). So: always try the network (fresh shell + refresh
  // the cache), and fall back to the cached shell only when offline.
  if (url.pathname === '/' || url.pathname === '/manifest.webmanifest') {
    event.respondWith(
      caches.open(CACHE).then((cache) =>
        fetch(event.request).then((res) => {
          if (res.ok) cache.put(event.request, res.clone());
          return res;
        }).catch(() => cache.match(event.request))
      )
    );
  }
});
`);
      return;
    }

    if (req.method === "GET" && url === "/session") {
      const chat = await ctxForRequest();
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: chat.session.id, model: opts.model }));
      return;
    }

    if (req.method === "GET" && url === "/events") {
      const chat = await ctxForRequest();
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      res.write(`data: ${JSON.stringify({ type: "hello", session: chat.session.id })}\n\n`);
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
      const { messages, hasMore } = await (await ctxForRequest()).session.readMessagePage(page, pageSize);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ messages, hasMore, page }));
      return;
    }

    if (req.method === "GET" && url === "/api/sessions") {
      // Lisa's own chat sessions on disk — drives the sidebar footer count
      // badge. (Was missing → the badge fetch 404'd and stayed a placeholder.)
      const { listSessionsOnDisk } = await import("../sessions/list.js");
      const sessions = await listSessionsOnDisk();
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ sessions }));
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

    // ── Personal knowledge base (docs/PLAN_KNOWLEDGE_BASE_v1.0.md) ──────
    if (req.method === "GET" && url.startsWith("/api/kb/search")) {
      const q = new URL(url, "http://localhost").searchParams.get("q") ?? "";
      const { searchKb } = await import("../kb/search.js");
      const hits = q.trim() ? await searchKb(q, 25) : [];
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ hits }));
      return;
    }
    if (req.method === "GET" && url.startsWith("/api/kb/entry")) {
      const p = new URL(url, "http://localhost").searchParams;
      const layer = p.get("layer") === "wiki" ? "wiki" : "sources";
      const { readEntry } = await import("../kb/store.js");
      const entry = await readEntry(layer, p.get("slug") ?? "").catch(() => null);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ entry }));
      return;
    }
    if (req.method === "GET" && url === "/api/kb") {
      const { listEntries } = await import("../kb/store.js");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ entries: await listEntries() }));
      return;
    }
    if (req.method === "POST" && url === "/api/kb/add") {
      let body = "";
      for await (const chunk of req) body += chunk.toString("utf8");
      let payload: { title?: string; content?: string; tags?: string[]; origin?: string };
      try {
        payload = JSON.parse(body || "{}");
      } catch {
        res.writeHead(400, { "content-type": "text/plain" });
        res.end("bad json");
        return;
      }
      const content = (payload.content ?? "").trim();
      if (!content) {
        res.writeHead(400, { "content-type": "text/plain" });
        res.end("empty content");
        return;
      }
      const title = (payload.title ?? "").trim() || content.split("\n")[0]!.slice(0, 60) || "capture";
      const { addSource } = await import("../kb/store.js");
      const entry = await addSource({ title, body: content, tags: payload.tags, origin: payload.origin || "chat" });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, entry: { layer: entry.layer, slug: entry.slug, title: entry.title } }));
      return;
    }
    if (req.method === "POST" && url === "/api/kb/remove") {
      let body = "";
      for await (const chunk of req) body += chunk.toString("utf8");
      let payload: { layer?: string; slug?: string };
      try {
        payload = JSON.parse(body || "{}");
      } catch {
        res.writeHead(400, { "content-type": "text/plain" });
        res.end("bad json");
        return;
      }
      const layer = payload.layer === "wiki" ? "wiki" : "sources";
      const { removeEntry } = await import("../kb/store.js");
      const removed = await removeEntry(layer, payload.slug ?? "").catch(() => false);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: removed }));
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

    // ── Coding plans (CODING_PLANS Phase 5b): detect, show usage, pick a
    //    delegation target. Detection is presence-only (no secrets read); the
    //    POST writes LISA_CODING_PLAN, not the model — her own loop is unchanged.
    if (req.method === "GET" && url === "/api/plans") {
      const nowMs = Date.now();
      const sel = selectedPlan();
      const plans = detectPlans().map((p) => {
        const row: Record<string, unknown> = {
          id: p.id,
          label: p.label,
          cli: p.cli,
          detail: p.detail,
          available: p.available,
          loggedIn: p.loggedIn,
          mark: planMark(p),
          selected: p.id === sel,
        };
        if (p.available) {
          const u = planUsage(p.id, nowMs);
          if (u && (u.windowTokens || u.todayTokens)) row.usage = formatUsage(u);
        }
        return row;
      });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ plans, selected: sel }));
      return;
    }

    if (req.method === "POST" && url === "/api/plans/select") {
      let body = "";
      for await (const chunk of req) body += chunk.toString("utf8");
      let payload: { plan?: unknown };
      try {
        payload = JSON.parse(body || "{}");
      } catch {
        res.writeHead(400, { "content-type": "text/plain" });
        res.end("bad json");
        return;
      }
      const raw = typeof payload.plan === "string" ? payload.plan.trim().toLowerCase() : "";
      const planId =
        raw === "" || raw === "none"
          ? ""
          : (parsePlanRef(raw) ?? ((PLAN_IDS as readonly string[]).includes(raw) ? raw : null));
      if (planId === null) {
        res.writeHead(400, { "content-type": "text/plain" });
        res.end("unknown plan — use claude | codex | copilot | none");
        return;
      }
      try {
        await saveConfigEnv({ LISA_CODING_PLAN: planId });
      } catch (err) {
        res.writeHead(500, { "content-type": "text/plain" });
        res.end((err as Error).message);
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, selected: planId || null }));
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

    // Room gramophone playlist: bundled tracks + the user's ~/.lisa/music/*.mp3.
    if (req.method === "GET" && url === "/api/room/music") {
      const tracks = (await listRoomMusic(MUSIC_DIR)).map(toPublicTrack);
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify(tracks));
      return;
    }
    // Stream one track by opaque id, with HTTP Range support so seeking works.
    // The id is resolved back to a path only via listRoomMusic, so there is no
    // path-traversal surface even for user drop-in files.
    if (req.method === "GET" && url.startsWith("/api/room/music/file/")) {
      const id = decodeURIComponent(url.slice("/api/room/music/file/".length));
      const track = (await listRoomMusic(MUSIC_DIR)).find((t) => t.id === id);
      if (!track) {
        res.writeHead(404, { "content-type": "text/plain" });
        res.end("no such track");
        return;
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
            return;
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
      const chat = await ctxForRequest();
      let body = "";
      for await (const chunk of req) body += chunk.toString("utf8");
      let message: string;
      let files: Array<{ name: string; mediaType: string; data: string }> | undefined;
      try {
        // Every other endpoint guards its JSON.parse — this one used to be the
        // only one that didn't, and a malformed body left the socket hanging.
        const parsed = JSON.parse(body) as {
          message?: unknown;
          files?: Array<{ name: string; mediaType: string; data: string }>;
        };
        if (typeof parsed.message !== "string" || !parsed.message.trim()) {
          throw new Error("missing message");
        }
        message = parsed.message;
        files = parsed.files;
      } catch (err) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: `bad request: ${(err as Error).message}` }));
        return;
      }
      // User just talked — reset the idle watcher + stamp focus freshness.
      try { getIdleWatcher(60 * 60_000).tick(); } catch {}
      lastUserMessageAt = Date.now();
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      // Guard writes: once the client disconnects the socket is gone, and a bare
      // res.write would throw "write after end" from inside the agent loop.
      const send = (event: object) => {
        if (res.writableEnded || res.destroyed) return;
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      };
      // Per-turn cancellation: if the client disconnects (taps Stop / closes the
      // app), abort THIS turn's agent so it stops burning tokens and the next
      // queued turn isn't stuck behind an abandoned run.
      const turnAbort = new AbortController();
      req.on("close", () => turnAbort.abort());
      const onMood = (slug: string) => send({ type: "mood", slug });
      moodBus.on("mood", onMood);
      // Send the current mood immediately so a fresh tab knows where to start.
      send({ type: "mood", slug: moodBus.current() });
      const runTurn = async (): Promise<void> => {
        // runAgent emits an error event for a failed turn AND rethrows; without
        // this guard the catch below would send a second, identical error event
        // (the client used to render the same error twice).
        let errorSent = false;
        // Track whether the turn produced anything visible. A model call can
        // return a clean, successful turn with zero text and zero tools (e.g. a
        // provider hiccup returns an empty completion). Without a signal the
        // client can only guess ("(no response)"); we emit an explicit `empty`
        // event so it can offer a retry instead of a dead end.
        let anyText = false;
        let anyTool = false;
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
              // Abort on server shutdown OR this client disconnecting (Stop).
              signal: AbortSignal.any([abort.signal, turnAbort.signal]),
              log: () => {},
            },
            history: chat.history,
            userMessage: message,
            userFiles: files,
            model: opts.model,
            thinking: opts.thinking,
            onEvent: (ev) => {
              if (ev.type === "text_delta" && ev.text) {
                anyText = true;
                send({ type: "text", text: ev.text });
              }
              if (ev.type === "tool_call_start")
                anyTool = true;
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
              if (ev.type === "error") {
                errorSent = true;
                send({ type: "error", message: ev.message ?? "" });
              }
            },
            // Same plugin hook wiring as the CLI turn — PreToolUse can block,
            // PostToolUse can rewrite. (Was CLI-only; web tool calls bypassed
            // every configured hook.)
            preToolHook: hooks.length === 0 ? undefined : async (name, input) => {
              const r = await fireHooks(
                "PreToolUse",
                hooks,
                { TOOL_NAME: name, TOOL_INPUT: JSON.stringify(input), SESSION_ID: chat.session.id, LISA_HOME: lisaHome(), CLAUDE_PROJECT_DIR: process.cwd() },
                process.cwd(),
              );
              if (r.blocked.length > 0) return { block: r.blocked.join("; ") };
            },
            postToolHook: hooks.length === 0 ? undefined : async (name, input, result, isError) => {
              const r = await fireHooks(
                "PostToolUse",
                hooks,
                {
                  TOOL_NAME: name,
                  TOOL_INPUT: JSON.stringify(input),
                  TOOL_RESULT: result,
                  TOOL_ERROR: isError ? "1" : "",
                  SESSION_ID: chat.session.id,
                  LISA_HOME: lisaHome(),
                  CLAUDE_PROJECT_DIR: process.cwd(),
                },
                process.cwd(),
              );
              if (r.rewriteResult != null) return { rewriteResult: r.rewriteResult };
            },
            onMessagePersist: (m) => chat.session.appendMessage(m),
            hotReload: {
              initialFingerprint: fresh.fingerprint,
              rebuild: rebuildPrompt,
            },
          });
          chat.history.length = 0;
          chat.history.push(...result.history);
          if (!anyText && !anyTool && !errorSent) send({ type: "empty" });
          send({ type: "done" });
        } catch (err) {
          if (!errorSent) send({ type: "error", message: (err as Error).message });
        } finally {
          moodBus.off("mood", onMood);
          res.end();
        }
      };
      // Queue behind any in-flight turn ON THIS CONTEXT (per-uid, so one
      // account's long turn never blocks another's); the SSE stream stays open
      // while we wait, so the second tab just sees its reply start later.
      const job = chat.chain.then(runTurn, runTurn);
      chat.chain = job.then(
        () => {},
        () => {},
      );
      await job;
      return;
    }

    if (req.method === "POST" && url === "/reflect") {
      const chat = await ctxForRequest();
      try {
        const r = await reflectOnSession({
          history: chat.history,
          sessionId: chat.session.id,
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
  server.listen(opts.port, host);
  return server;
}

/**
 * Mac Island Phase 1 — web widget served at GET /island.
 *
 * Designed to be opened in a tiny always-on-top browser window (Arc small
 * window, Vivaldi PWA, Safari split). Subscribes to /events for live mood +
 * idle pulses, polls /api/island/ping for richer state (current desire,
 * unread flag). See docs/MAC_ISLAND_PLAN.md.
 *
 * No build step, no framework — single string of inline HTML/CSS/JS.
 */

export const ISLAND_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Lisa · island</title>
<link rel="manifest" href="/manifest.webmanifest">
<style>
  :root {
    color-scheme: dark;
    --bg: rgba(8, 12, 24, 0.92);
    --bg-strong: rgba(8, 12, 24, 0.96);
    --fg: #e6e8ee;
    --fg-dim: #9ba3b8;
    --fg-faint: #6b7280;
    --accent: #6ad4ff;
    --accent-warm: #ffd066;
    --accent-dream: #b487ff;
    --accent-claude: #ff8c42;
    --border: rgba(255, 255, 255, 0.08);
    /* 1px top inner highlight that reads as a glass bevel */
    --hairline: rgba(255, 255, 255, 0.12);
    /* Layered materials — a soft vertical gradient gives the panels depth
       instead of a flat fill, closer to the macOS Notch look. */
    --pill-grad: linear-gradient(180deg, rgba(28, 35, 56, 0.94) 0%, rgba(10, 14, 28, 0.94) 100%);
    --panel-grad: linear-gradient(180deg, rgba(22, 28, 46, 0.96) 0%, rgba(9, 13, 25, 0.97) 72%);
    --shadow-pill: 0 8px 24px rgba(0, 0, 0, 0.45), 0 1px 0 var(--hairline) inset;
    --shadow-panel: 0 18px 50px rgba(0, 0, 0, 0.55), 0 1px 0 var(--hairline) inset;
    /* Gentle overshoot easing for a springy, alive feel. */
    --spring: cubic-bezier(0.22, 1, 0.36, 1);
  }
  html, body {
    margin: 0;
    padding: 0;
    background: transparent;
    overflow: hidden;
    height: 100vh;
    font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif;
    -webkit-font-smoothing: antialiased;
    color: var(--fg);
    user-select: none;
    cursor: default;
  }
  body {
    display: flex;
    flex-direction: column;
    align-items: center;
    padding: 4px 8px;
  }

  #pill {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    background: var(--pill-grad);
    border: 1px solid var(--border);
    border-radius: 22px;
    padding: 5px 14px 5px 5px;
    backdrop-filter: blur(20px) saturate(1.4);
    -webkit-backdrop-filter: blur(20px) saturate(1.4);
    box-shadow: var(--shadow-pill);
    cursor: pointer;
    transition: transform 260ms var(--spring), box-shadow 260ms var(--spring);
    max-width: 280px;
  }
  /* Lift toward the cursor (the old rule pushed it *down*, which read as
     a press). Subtle scale + deeper shadow sells the float. */
  #pill:hover {
    transform: translateY(-1px) scale(1.015);
    box-shadow: 0 14px 32px rgba(0, 0, 0, 0.5), 0 1px 0 rgba(255, 255, 255, 0.16) inset;
  }
  #pill:active { transform: translateY(0) scale(0.99); }

  /* Avatar is an <img> not a background-image — more reliable in
     WKWebView and lets us crop into the face via object-position.
     The 512×512 source has ~15% transparent padding around the
     character; we scale up via object-fit + anchor toward the top
     so the face dominates the small circle.
     pointer-events: none + draggable=false so the img never steals
     or hijacks mouse events from the pill (HTML <img> default is
     draggable, which interferes with our Swift-side click/drag
     resolution). */
  #avatar {
    width: 36px;
    height: 36px;
    border-radius: 50%;
    object-fit: cover;
    object-position: 50% 22%;
    background: #15192a;
    flex-shrink: 0;
    image-rendering: pixelated;
    border: 1px solid rgba(255, 255, 255, 0.10);
    box-shadow: 0 0 0 2px rgba(106, 212, 255, 0.10);
    pointer-events: none;
    -webkit-user-drag: none;
    user-select: none;
  }

  #label {
    font-size: 13px;
    font-weight: 600;
    letter-spacing: 0.02em;
    color: var(--fg);
  }

  #dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: transparent;
    flex-shrink: 0;
  }
  #dot.thinking       { background: var(--accent);         animation: pulse 1.2s ease-in-out infinite; }
  #dot.dreaming       { background: var(--accent-dream);   animation: pulse 2.4s ease-in-out infinite; }
  #dot.unread         { background: var(--accent-warm); }
  /* Phase 2: pill dot reflects the strongest signal across all
     Claude sessions. */
  /* working = a calm slow breathe (it's running, not actionable);
     waiting = solid + a soft halo that draws the eye ("needs you"). */
  #dot.claude-working { background: var(--accent-claude);  opacity: 1; animation: breathe 2.6s ease-in-out infinite; }
  #dot.claude-waiting { background: var(--accent-claude);  opacity: 1; animation: needsYou 2s ease-in-out infinite; }
  #dot.claude-error   { background: #ff5577;               animation: pulse 0.8s ease-in-out infinite; }
  #dot.offline        { background: var(--fg-faint); }

  @keyframes pulse {
    0%, 100% { opacity: 0.35; }
    50%      { opacity: 1; }
  }
  /* Gentle breathing for "working" — present but not jumpy. */
  @keyframes breathe {
    0%, 100% { opacity: 0.55; }
    50%      { opacity: 1; }
  }
  /* "needs you" — solid dot with a pulsing warm halo, more prominent than
     working without the harsh on/off flash. */
  @keyframes needsYou {
    0%, 100% { box-shadow: 0 0 0 0 rgba(255, 140, 66, 0); }
    50%      { box-shadow: 0 0 7px 2px rgba(255, 140, 66, 0.65); }
  }

  /* Expanded panel — appears below the pill on hover/click.
     The native LisaIsland.app window is a fixed 360×440 pt; the pill
     takes the top ~58pt (height + 8pt margin around). The expand
     panel fills the rest. When content (long ★ reflection + many
     active Claude sessions + their state trails when row-open)
     exceeds that, the panel scrolls internally rather than letting
     anything clip out of the window. */
  #expand {
    margin-top: 10px;
    width: 336px;
    max-height: calc(100vh - 70px);
    overflow-y: auto;
    overscroll-behavior: contain;
    background: var(--panel-grad);
    border: 1px solid var(--border);
    border-radius: 18px;
    padding: 16px 18px;
    backdrop-filter: blur(24px) saturate(1.4);
    -webkit-backdrop-filter: blur(24px) saturate(1.4);
    box-shadow: var(--shadow-panel);
    font-size: 12.5px;
    line-height: 1.55;
    box-sizing: border-box;
    opacity: 0;
    transform: translateY(-6px) scale(0.985);
    transform-origin: top center;
    pointer-events: none;
    transition: opacity 240ms var(--spring), transform 240ms var(--spring);
  }
  body.expanded #expand {
    opacity: 1;
    transform: none;
    pointer-events: auto;
  }
  /* Subtle scrollbar — visible only while scrolling/hovering. The
     default WKWebView scrollbar is too chunky for a 336px panel. */
  #expand::-webkit-scrollbar { width: 6px; }
  #expand::-webkit-scrollbar-track { background: transparent; }
  #expand::-webkit-scrollbar-thumb {
    background: rgba(255, 255, 255, 0.10);
    border-radius: 3px;
  }
  #expand::-webkit-scrollbar-thumb:hover {
    background: rgba(255, 255, 255, 0.20);
  }

  /* Stack section blocks with consistent vertical rhythm. */
  #expand > div + div { margin-top: 14px; }

  .section-label {
    color: var(--accent);
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.10em;
    font-size: 10.5px;
    margin-bottom: 8px;
  }
  .section-body {
    color: var(--fg-dim);
    word-wrap: break-word;
  }

  #idle-section { display: none; }
  body.has-unread #idle-section { display: block; }
  #idle-body {
    background: rgba(255, 208, 102, 0.07);
    border-left: 2px solid var(--accent-warm);
    padding: 8px 12px;
    border-radius: 6px;
    color: var(--fg);
    /* No inner max-height — the outer #expand panel scrolls if total
       content overflows the window. One scrollbar, not nested. */
    white-space: pre-wrap;
  }

  /* Claude Code section — appears when there's active Claude Code activity */
  #claude-section { display: none; }
  body.has-claude #claude-section { display: block; }
  #claude-section .section-label { color: var(--accent-claude); }
  #claude-list {
    list-style: none;
    padding: 4px 0;
    margin: 0;
    border-left: 2px solid var(--accent-claude);
    background: rgba(255, 140, 66, 0.06);
    border-radius: 6px;
    /* No inner overflow either — outer #expand scrolls. Avoids the
       nested-scrollbar UX where the user scrolls inside this card by
       accident and can't reach the action buttons below. */
  }
  #claude-list li {
    padding: 8px 12px;
    color: var(--fg);
    font-size: 11.5px;
    display: flex;
    flex-direction: column;
    gap: 4px;
    cursor: pointer;
    transition: background 120ms ease;
  }
  #claude-list li:hover { background: rgba(255, 140, 66, 0.10); }
  #claude-list li + li { border-top: 1px solid rgba(255, 140, 66, 0.10); }
  /* Row "head" — the pip + project + relative-time line. Always rendered.
     Stays as a horizontal flex strip even when the row is expanded; the
     trail + actions render BELOW it because the parent <li> is flex-column. */
  #claude-list .head {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  #claude-list .proj { font-weight: 600; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  /* Relative-time reads as a small pill chip (cf. the "<1m" chip in the
     reference) — sits cleaner against the row than bare text. */
  #claude-list .when {
    color: var(--fg-dim);
    flex-shrink: 0;
    font-variant-numeric: tabular-nums;
    font-size: 10px;
    padding: 2px 7px;
    border-radius: 999px;
    background: rgba(255, 255, 255, 0.05);
    border: 1px solid rgba(255, 255, 255, 0.07);
  }
  #claude-list .empty { padding: 8px 12px; color: var(--fg-faint); font-style: italic; }
  /* O2 — Tier-2 activity line: what the session is structurally doing. */
  #claude-list .act {
    margin: 4px 0 0 18px;
    padding: 5px 9px;
    font-size: 10.5px;
    color: var(--fg-dim);
    font-family: ui-monospace, "SF Mono", Menlo, monospace;
    /* Inset monospace card with an accent rail — echoes the reference's
       code-diff panel without needing the actual diff content. */
    background: rgba(255, 255, 255, 0.035);
    border: 1px solid rgba(255, 255, 255, 0.05);
    border-left: 2px solid rgba(255, 140, 66, 0.5);
    border-radius: 7px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* Phase 2 — per-session state pip prefix */
  #claude-list .pip {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    flex-shrink: 0;
    background: var(--fg-faint);
    margin-right: 4px;
  }
  #claude-list .pip.working { background: var(--accent-claude); opacity: 1; animation: breathe 2.6s ease-in-out infinite; }
  #claude-list .pip.waiting { background: var(--accent-claude); opacity: 1; animation: needsYou 2s ease-in-out infinite; }
  #claude-list .pip.error   { background: #ff5577; }
  #claude-list .pip.unknown { background: var(--fg-faint); }

  /* Phase 3 — state transition trail, shown below the row head when
     the parent <li> has the .row-open class. */
  #claude-list .trail {
    display: none;
    margin: 4px 0 0 14px;
    padding: 6px 0 2px;
    border-top: 1px dashed rgba(255, 140, 66, 0.18);
    font-size: 10px;
    color: var(--fg-faint);
    line-height: 1.7;
    word-spacing: 0.05em;
  }
  #claude-list li.row-open .trail { display: block; }

  /* Phase 3.5 — inline action row when the session is expanded */
  #claude-list .actions {
    display: none;
    margin: 6px 0 0 14px;
    gap: 6px;
    flex-wrap: wrap;
  }
  #claude-list li.row-open .actions { display: flex; }
  #claude-list .actions button {
    flex: 0 0 auto;
    background: rgba(255, 140, 66, 0.10);
    border: 1px solid rgba(255, 140, 66, 0.22);
    color: var(--fg);
    padding: 4px 8px;
    border-radius: 6px;
    font-size: 10.5px;
    cursor: pointer;
    font-family: inherit;
  }
  #claude-list .actions button:hover { background: rgba(255, 140, 66, 0.16); }
  #claude-list .actions button:disabled { opacity: 0.35; cursor: not-allowed; }
  #claude-list .trail .tdot {
    display: inline-block;
    width: 5px;
    height: 5px;
    border-radius: 50%;
    margin-right: 4px;
    vertical-align: 0;
    background: var(--fg-faint);
  }
  #claude-list .trail .tdot.working { background: var(--accent-claude); }
  #claude-list .trail .tdot.waiting { background: var(--accent-claude); opacity: 0.7; }
  #claude-list .trail .tdot.error   { background: #ff5577; }
  /* (older stub removed — .head is a real flex strip now, see above) */

  /* Phase 3 — notification opt-in chip */
  #notify-cta {
    display: none;
    margin-top: 10px;
    padding: 8px 12px;
    border-radius: 10px;
    background: rgba(255, 140, 66, 0.12);
    border: 1px solid rgba(255, 140, 66, 0.30);
    font-size: 11px;
    color: var(--fg);
    text-align: center;
    cursor: pointer;
    transition: background 120ms ease;
  }
  #notify-cta:hover { background: rgba(255, 140, 66, 0.18); }
  body.notify-default #notify-cta { display: block; }

  #actions {
    display: flex;
    gap: 8px;
    margin-top: 4px;
  }
  button {
    flex: 1;
    background: rgba(255, 255, 255, 0.06);
    border: 1px solid var(--border);
    color: var(--fg);
    padding: 9px 12px;
    border-radius: 11px;
    font-size: 11.5px;
    font-weight: 550;
    cursor: pointer;
    font-family: inherit;
    transition: background 160ms var(--spring), transform 160ms var(--spring), box-shadow 160ms var(--spring);
  }
  button:hover  { background: rgba(255, 255, 255, 0.11); transform: translateY(-1px); }
  button:active { background: rgba(255, 255, 255, 0.16); transform: translateY(0); }
  button.muted  { opacity: 0.6; }
  /* Primary CTA — accent-filled with a soft glow, the way the reference
     elevates its main action above the secondary ones. */
  #btn-open {
    background: linear-gradient(180deg, rgba(106, 212, 255, 0.22), rgba(106, 212, 255, 0.12));
    border-color: rgba(106, 212, 255, 0.35);
    color: #d6f3ff;
    box-shadow: 0 4px 14px rgba(106, 212, 255, 0.12);
  }
  #btn-open:hover {
    background: linear-gradient(180deg, rgba(106, 212, 255, 0.30), rgba(106, 212, 255, 0.16));
    box-shadow: 0 6px 18px rgba(106, 212, 255, 0.22);
  }

  /* Offline state — desaturate + dim */
  body.offline #avatar { filter: grayscale(1); opacity: 0.5; }
  body.offline #label  { color: var(--fg-faint); }

  /* Agents-advisor card (cross-agent suggestions with actions) */
  #advisor-section { display: none; }
  body.has-advisor #advisor-section { display: block; }
  #advisor-list { list-style: none; margin: 0; padding: 0; }
  #advisor-list li { display: flex; flex-direction: column; gap: 4px; padding: 4px 0; }
  #advisor-list .advisor-text { font-size: 11px; line-height: 1.35; }
  #advisor-list .advisor-text.urgent { font-weight: 600; }
  #advisor-list .advisor-actions { display: flex; gap: 6px; }
  #advisor-list .advisor-actions button {
    font: inherit; font-size: 10px; padding: 2px 8px; border-radius: 6px;
    border: 1px solid var(--line, rgba(255,255,255,0.15));
    background: transparent; color: inherit; cursor: pointer;
  }
  #advisor-list .advisor-actions button.primary {
    background: var(--accent, #5b8cff); border-color: transparent; color: #fff;
  }
  #advisor-list .advisor-actions button:hover { filter: brightness(1.1); }
  /* Screen-advisor suggestion card */
  #suggestion-section { display: none; }
  body.has-suggestion #suggestion-section { display: block; }
  #suggestion-title { font-weight: 600; margin: 2px 0 3px; }
  #suggestion-rationale { font-size: 11px; color: var(--fg-faint); margin-bottom: 6px; }
  #suggestion-act {
    width: 100%; padding: 6px 8px; border: 0; border-radius: 7px; cursor: pointer;
    font: inherit; font-size: 12px; font-weight: 600;
    background: var(--accent, #5b8cff); color: #fff;
  }
  #suggestion-act:hover { filter: brightness(1.08); }
  /* a soft glow on the pill dot when a fresh suggestion is waiting */
  body.has-suggestion #dot { background: var(--accent, #5b8cff); opacity: 1; }
</style>
</head>
<body>
  <div id="pill" role="button" tabindex="0" aria-label="Lisa island">
    <img id="avatar" alt="" draggable="false" src="/assets/lisa/neutral.png" />
    <div id="label">Lisa</div>
    <div id="dot" aria-hidden="true"></div>
  </div>
  <div id="expand" role="region" aria-label="Lisa status detail">
    <div id="desire-section">
      <div class="section-label">currently wanting</div>
      <div class="section-body" id="desire-body">—</div>
    </div>
    <div id="idle-section">
      <div class="section-label">★ while you were away</div>
      <div id="idle-body"></div>
    </div>
    <div id="suggestion-section">
      <div class="section-label">💡 suggested next step</div>
      <div id="suggestion-title"></div>
      <div id="suggestion-rationale"></div>
      <button id="suggestion-act" type="button">Optimize ▸</button>
    </div>
    <div id="advisor-section">
      <div class="section-label">🛰 across your agents</div>
      <ul id="advisor-list"></ul>
    </div>
    <div id="claude-section">
      <div class="section-label">claude code · <span id="claude-count">0</span> active</div>
      <ul id="claude-list"></ul>
      <div id="notify-cta" role="button" tabindex="0">🔔 Notify me when Claude is waiting</div>
    </div>
    <div id="actions">
      <button id="btn-open">Open chat</button>
      <button id="btn-dismiss" class="muted">Dismiss ★</button>
    </div>
  </div>

<script>
(() => {
  const pill         = document.getElementById('pill');
  const avatar       = document.getElementById('avatar');
  const dot          = document.getElementById('dot');
  const expand       = document.getElementById('expand');
  const desireBody   = document.getElementById('desire-body');
  const idleBody     = document.getElementById('idle-body');
  const claudeList   = document.getElementById('claude-list');
  const claudeCount  = document.getElementById('claude-count');
  const notifyCta    = document.getElementById('notify-cta');
  const btnOpen      = document.getElementById('btn-open');
  const btnDismiss   = document.getElementById('btn-dismiss');
  const suggTitle    = document.getElementById('suggestion-title');
  const suggRationale= document.getElementById('suggestion-rationale');
  const suggAct      = document.getElementById('suggestion-act');
  const body         = document.body;

  const state = {
    mood: 'neutral',
    online: false,
    unread: false,
    idleText: '',
    desire: null,
    thinking: false,
    dreaming: false,
    claudeSessions: [],  // [{project, sessionId, lastMtime}, …]
    suggestion: null,    // {title, rationale, task, at} from the screen advisor
    advisor: [],         // [{id, category, urgency, text, action}] from the cross-agent advisor
  };

  // 30-min activity window matches the watcher's ACTIVE_WINDOW_MS.
  const CLAUDE_ACTIVE_WINDOW_MS = 30 * 60 * 1000;

  // Phase 3 — in-memory state transition history per session.
  // Map<sessionId, [{state, reason, ts}, …]> capped at MAX_HISTORY.
  // Pure UI memory; not persisted, not transmitted.
  const stateHistory = new Map();
  const MAX_HISTORY = 8;
  // Per-session opened-state for the inline trail in the expand list.
  const rowOpen = new Set();

  function recordStateHistory(sessionId, info) {
    let h = stateHistory.get(sessionId);
    if (!h) { h = []; stateHistory.set(sessionId, h); }
    const last = h[h.length - 1];
    if (last && last.state === info.state && last.reason === info.reason) {
      // Same state, just refresh timestamp — collapse repeats.
      last.ts = info.lastMtime;
      return false;
    }
    h.push({ state: info.state, reason: info.reason, ts: info.lastMtime });
    while (h.length > MAX_HISTORY) h.shift();
    return true; // transition happened
  }

  // ── Phase 3 — notifications (native via LisaIsland.app, or web fallback)
  // Fires "Claude is waiting in <project>" alerts when a session
  // transitions INTO waiting. Throttled per session so a flaky tool
  // that bounces between waiting/working doesn't spam.
  //
  // Phase 3.5: when running inside LisaIsland.app, we delegate to the
  // native UNUserNotificationCenter via postMessage — better permission
  // flow, integrates with macOS Focus / DnD. In a plain browser tab we
  // fall back to the Notification API.
  const NOTIFY_THROTTLE_MS = 60_000;
  const lastNotifyAt = new Map();
  const hasBridge = !!(window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.island);

  function notifPermission() {
    if (hasBridge) return 'granted'; // native side asks the user; we just request and trust
    return ('Notification' in window) ? Notification.permission : 'unsupported';
  }

  function refreshNotifyCta() {
    // The 🔔 chip is only needed when running in a browser AND
    // permission hasn't been answered yet. Native bridge handles its
    // own permission prompt.
    if (hasBridge) {
      body.classList.remove('notify-default');
      return;
    }
    body.classList.toggle('notify-default', notifPermission() === 'default');
  }

  function requestNotificationPermission() {
    if (hasBridge) {
      window.webkit.messageHandlers.island.postMessage({ type: 'ensure_notify_permission' });
      refreshNotifyCta();
      return;
    }
    if (!('Notification' in window) || Notification.permission !== 'default') {
      refreshNotifyCta();
      return;
    }
    Notification.requestPermission().then(() => refreshNotifyCta()).catch(() => {});
  }

  function maybeNotifyWaiting(prevState, info) {
    if (info.state !== 'waiting') return;
    if (prevState === 'waiting') return;     // already in this state
    const last = lastNotifyAt.get(info.sessionId) || 0;
    if (Date.now() - last < NOTIFY_THROTTLE_MS) return;
    lastNotifyAt.set(info.sessionId, Date.now());
    const reasonLabel = info.stateReason === 'permission' ? 'needs permission' : 'is waiting';
    const title = 'Claude ' + reasonLabel + ' in ' + info.project;
    const bodyText = info.sessionId.slice(0, 8) + ' · click to open Lisa';
    if (hasBridge) {
      window.webkit.messageHandlers.island.postMessage({
        type: 'notify',
        title: title,
        body: bodyText,
        sessionId: info.sessionId,
      });
      return;
    }
    if (notifPermission() !== 'granted') return;
    try {
      const n = new Notification(title, {
        body: bodyText,
        tag: 'lisa-claude-' + info.sessionId,
        icon: '/assets/lisa-mascot.png',
        silent: false,
      });
      n.onclick = () => { window.focus(); window.open('/', '_blank'); n.close(); };
    } catch (_) { /* unsupported, ignore */ }
  }
  function recentSessions() {
    const cutoff = Date.now() - CLAUDE_ACTIVE_WINDOW_MS;
    return state.claudeSessions.filter(
      (s) => new Date(s.lastMtime).getTime() >= cutoff
    );
  }
  /**
   * Phase 2: aggregate Claude state for the pill dot. Priority is
   * "loudest signal wins": an error anywhere dominates everything;
   * otherwise a "waiting" session beats a "working" session (because
   * "waiting" means Claude needs the user — more attention-worthy
   * than "working" which is passive observing).
   */
  function aggregateClaudeState() {
    const recent = recentSessions();
    if (recent.length === 0) return null;
    if (recent.some((s) => s.state === 'error'))   return 'error';
    if (recent.some((s) => s.state === 'waiting')) return 'waiting';
    if (recent.some((s) => s.state === 'working')) return 'working';
    return null;
  }

  function setAvatar(slug) {
    if (!slug) return;
    state.mood = slug;
    // Use the <img> src attribute — far more reliable than CSS
    // background-image in WKWebView, and lets the browser's standard
    // image cache + retry logic do its thing.
    avatar.src = '/assets/lisa/' + encodeURIComponent(slug) + '.png';
  }

  function refreshDot() {
    dot.className = '';
    // Priority: LISA's own state (offline / thinking / dreaming / unread)
    // always wins over the Claude-Code-monitor indicator — the pill is
    // primarily about her, the Claude dot is a quieter "by the way".
    if (!state.online)  { dot.classList.add('offline');  return; }
    if (state.thinking) { dot.classList.add('thinking'); return; }
    if (state.dreaming) { dot.classList.add('dreaming'); return; }
    if (state.unread)   { dot.classList.add('unread');   return; }
    const claude = aggregateClaudeState();
    if (claude === 'error')   { dot.classList.add('claude-error');   return; }
    if (claude === 'waiting') { dot.classList.add('claude-waiting'); return; }
    if (claude === 'working') { dot.classList.add('claude-working'); return; }
  }

  function refreshPanel() {
    body.classList.toggle('offline',   !state.online);
    body.classList.toggle('has-unread', state.unread);
    body.classList.toggle('has-claude', state.claudeSessions.length > 0);
    desireBody.textContent = state.desire || '(nothing actively pursued)';
    idleBody.textContent   = state.idleText || '';
    btnDismiss.classList.toggle('muted', !state.unread);
    btnDismiss.disabled = !state.unread;
    body.classList.toggle('has-suggestion', !!state.suggestion);
    if (state.suggestion) {
      suggTitle.textContent = state.suggestion.title || '';
      suggRationale.textContent = state.suggestion.rationale || '';
    }
    body.classList.toggle('has-advisor', state.advisor.length > 0);
    renderAdvisorList();
    renderClaudeList();
  }

  // ── Cross-agent advisor card ───────────────────────────────────────
  // Each suggestion gets at most two buttons: the action (never auto-runs —
  // "open" reveals the folder, everything else prefills the chat composer
  // with a concrete ask so the user confirms by sending) and ✕ dismiss
  // (persisted server-side; repeated dismissals down-weight the category).
  function advisorPrefill(s) {
    const a = s.action || {};
    const arg = a.arg || '';
    switch (a.kind) {
      case 'approve':
        return 'One of my agent sessions is waiting for permission: "' + s.text + '". ' +
          'Inspect it' + (arg ? ' (inspect_agent ' + arg + ')' : '') +
          ' and tell me exactly what it wants to run and whether it looks safe.';
      case 'serialize':
        return 'Two of my agents may be about to collide: "' + s.text + '". ' +
          'Propose how to serialize them — do not schedule or cancel anything until I confirm.';
      case 'dispatch':
        return s.text + ' — list the pending actionable desires and propose a dispatch plan. ' +
          'Do not dispatch anything until I confirm.';
      case 'cancel':
        return 'Consider cancelling this: "' + s.text + '". Show me the dispatch details first ' +
          'and wait for my confirmation.';
      default: // 'look' and anything new
        return 'Look into this for me: "' + s.text + '"' +
          (arg && arg !== 'stuck' ? ' (session ' + arg + ')' : '') + ' — and report back.';
    }
  }

  function renderAdvisorList() {
    const list = document.getElementById('advisor-list');
    if (!list) return;
    while (list.firstChild) list.removeChild(list.firstChild);
    for (const s of state.advisor.slice(0, 3)) {
      const li = document.createElement('li');
      const text = document.createElement('div');
      text.className = 'advisor-text' + (s.urgency === 'urgent' ? ' urgent' : '');
      text.textContent = (s.urgency === 'urgent' ? '⚠ ' : '') + s.text;
      li.appendChild(text);
      const actions = document.createElement('div');
      actions.className = 'advisor-actions';
      const a = s.action || null;
      if (a && a.kind === 'open' && a.arg && String(a.arg).startsWith('/')) {
        const openBtn = document.createElement('button');
        openBtn.type = 'button';
        openBtn.className = 'primary';
        openBtn.textContent = '📁 ' + (a.label || 'Open');
        openBtn.title = a.arg;
        openBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          if (hasBridge) {
            window.webkit.messageHandlers.island.postMessage({ type: 'open_path', path: a.arg });
          } else {
            navigator.clipboard.writeText(a.arg).catch(() => {});
          }
        });
        actions.appendChild(openBtn);
      } else if (a) {
        const actBtn = document.createElement('button');
        actBtn.type = 'button';
        actBtn.className = 'primary';
        actBtn.textContent = (a.label || 'Ask Lisa') + ' ▸';
        actBtn.title = 'Prefills the chat — nothing runs until you send';
        actBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          openFull(advisorPrefill(s));
        });
        actions.appendChild(actBtn);
      }
      const dismissBtn = document.createElement('button');
      dismissBtn.type = 'button';
      dismissBtn.textContent = '✕';
      dismissBtn.title = 'Dismiss — repeated dismissals teach the advisor to quiet this category';
      dismissBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        state.advisor = state.advisor.filter((x) => x.id !== s.id);
        refreshPanel();
        try {
          await fetch('/api/advisor/dismiss', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ id: s.id, category: s.category }),
          });
        } catch (_) {}
      });
      actions.appendChild(dismissBtn);
      li.appendChild(actions);
      list.appendChild(li);
    }
  }

  function relativeTime(iso) {
    const ms = Date.now() - new Date(iso).getTime();
    if (ms < 30_000)             return 'just now';
    if (ms < 60_000)             return Math.round(ms / 1000) + 's ago';
    if (ms < 3600_000)           return Math.round(ms / 60_000) + 'm ago';
    return Math.round(ms / 3600_000) + 'h ago';
  }

  // O2 — compact one-line summary of a session's Tier-2 activity. Structural
  // only (tool names, last command, basename of a touched file). Returns ''
  // when there's no activity (e.g. visibility=metadata).
  function basename(p) {
    if (!p) return '';
    const parts = String(p).split('/');
    return parts[parts.length - 1] || p;
  }
  function formatActivity(s) {
    const a = s.activity;
    if (!a) return '';
    if (a.pendingPermission) return '⚠ wants to run ' + a.pendingPermission;
    const bits = [];
    if (a.lastError) bits.push('✗ ' + a.lastError);
    if (a.lastCommandName) bits.push('$ ' + a.lastCommandName);
    const tool = a.lastTools && a.lastTools.length ? a.lastTools[a.lastTools.length - 1] : '';
    const file = a.filesTouched && a.filesTouched.length ? basename(a.filesTouched[a.filesTouched.length - 1]) : '';
    if (tool && file) bits.push(tool + ' ' + file);
    else if (tool) bits.push(tool);
    else if (file) bits.push(file);
    return bits.join(' · ');
  }

  function renderClaudeList() {
    const recent = recentSessions();
    claudeCount.textContent = String(recent.length);
    while (claudeList.firstChild) claudeList.removeChild(claudeList.firstChild);
    if (recent.length === 0) {
      const li = document.createElement('li');
      li.className = 'empty';
      li.textContent = '(idle)';
      claudeList.appendChild(li);
      return;
    }
    // Sort: errors first, then waiting, then working, then by mtime.
    const stateRank = { error: 0, waiting: 1, working: 2, unknown: 3 };
    const rows = recent.slice().sort((a, b) => {
      const ra = stateRank[a.state] ?? 9;
      const rb = stateRank[b.state] ?? 9;
      if (ra !== rb) return ra - rb;
      return new Date(b.lastMtime).getTime() - new Date(a.lastMtime).getTime();
    }).slice(0, 5);
    for (const s of rows) {
      const li = document.createElement('li');
      if (rowOpen.has(s.sessionId)) li.classList.add('row-open');
      // pip + project + relative-time render as a single horizontal
      // .head strip. The trail + actions render BELOW the head when
      // the row is open (li is flex-column).
      const head = document.createElement('div');
      head.className = 'head';
      const pip = document.createElement('span');
      pip.className = 'pip ' + (s.state || 'unknown');
      const proj = document.createElement('span');
      proj.className = 'proj';
      proj.textContent = s.project;
      const when = document.createElement('span');
      when.className = 'when';
      when.textContent = relativeTime(s.lastMtime);
      head.appendChild(pip);
      head.appendChild(proj);
      head.appendChild(when);
      li.appendChild(head);

      // O2 (Tier 2) — one-line structural activity under the row head.
      // "what it's doing" without any conversation content.
      const actLine = formatActivity(s);
      if (actLine) {
        const act = document.createElement('div');
        act.className = 'act';
        act.textContent = actLine;
        li.appendChild(act);
      }

      // Phase 3 — collapsible state-transition trail
      const trail = document.createElement('div');
      trail.className = 'trail';
      renderTrail(trail, s);
      li.appendChild(trail);

      // Phase 3.5 — action buttons (Open in Finder / Copy resume)
      const actions = document.createElement('div');
      actions.className = 'actions';
      renderActions(actions, s);
      li.appendChild(actions);

      li.title = s.state + (s.stateReason ? ' (' + s.stateReason + ')' : '')
               + ' · ' + s.sessionId
               + '\\nclick: expand timeline · double-click: copy sessionId';
      li.addEventListener('click', () => {
        if (rowOpen.has(s.sessionId)) rowOpen.delete(s.sessionId);
        else rowOpen.add(s.sessionId);
        renderClaudeList();
      });
      li.addEventListener('dblclick', async (ev) => {
        ev.stopPropagation();
        try { await navigator.clipboard.writeText(s.sessionId); } catch (_) {}
      });
      claudeList.appendChild(li);
    }
  }

  /**
   * Phase 3.5 — render the inline action buttons for one Claude session.
   * Each session has a cwd (from .cwd top-level field in the jsonl)
   * and a sessionId. We expose two actions:
   *   - Open in Finder  — opens the cwd folder
   *   - Copy resume cmd — clipboard: cd "<cwd>" && claude --resume <sid>
   */
  function renderActions(container, s) {
    const cwd = s.cwd || '';
    const hasCwd = cwd.startsWith('/');

    const openBtn = document.createElement('button');
    openBtn.type = 'button';
    openBtn.textContent = '📁 Open folder';
    openBtn.disabled = !hasCwd;
    openBtn.title = hasCwd ? cwd : 'No cwd recorded in this session';
    openBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!hasCwd) return;
      if (window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.island) {
        window.webkit.messageHandlers.island.postMessage({
          type: 'open_path',
          path: cwd,
        });
      } else {
        // Browser fallback: copy the path so the user can paste in Finder.
        navigator.clipboard.writeText(cwd).catch(() => {});
      }
    });
    container.appendChild(openBtn);

    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.textContent = '📋 Resume cmd';
    copyBtn.disabled = !hasCwd;
    const cmd = hasCwd
      ? 'cd ' + JSON.stringify(cwd) + ' && claude --resume ' + s.sessionId
      : 'claude --resume ' + s.sessionId;
    copyBtn.title = cmd;
    copyBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      try {
        await navigator.clipboard.writeText(cmd);
        const orig = copyBtn.textContent;
        copyBtn.textContent = '✓ copied';
        setTimeout(() => { copyBtn.textContent = orig; }, 1200);
      } catch (_) {}
    });
    container.appendChild(copyBtn);
  }

  function renderTrail(container, s) {
    const h = stateHistory.get(s.sessionId) || [];
    if (h.length === 0) {
      container.textContent = '(no transitions recorded yet)';
      return;
    }
    // Render newest first so the right-most reads as "right now".
    const ordered = h.slice();
    for (let i = 0; i < ordered.length; i++) {
      const entry = ordered[i];
      const tdot = document.createElement('span');
      tdot.className = 'tdot ' + (entry.state || 'unknown');
      container.appendChild(tdot);
      const span = document.createElement('span');
      span.textContent = entry.state + ' · ' + relativeTime(entry.ts);
      container.appendChild(span);
      if (i < ordered.length - 1) {
        const sep = document.createElement('span');
        sep.textContent = '  →  ';
        sep.style.color = 'rgba(255,255,255,0.15)';
        container.appendChild(sep);
      }
    }
  }

  function expandPanel(open) {
    if (body.classList.contains('expanded') === open) return;
    body.classList.toggle('expanded', open);
    // Tell the native container (LisaIsland.app, Phase 2.2+) so it can
    // resize its NSWindow — the pill window is sized just for the pill
    // when collapsed, and grows to host the expand panel on open.
    // Falls back gracefully when running in a plain browser tab.
    if (window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.island) {
      window.webkit.messageHandlers.island.postMessage({
        type: open ? 'expand' : 'collapse'
      });
    }
  }

  // ── Interaction ────────────────────────────────────────────────────
  //
  // When running inside LisaIsland.app (Phase 2.1+), the native window
  // owns drag and click-vs-drag resolution: Swift's IslandWindow
  // intercepts mouseDown in sendEvent and runs a synchronous
  // mouseDragged loop. If movement > 4px → drag (setFrameOrigin each
  // tick, no IPC roundtrip). If no movement → Swift synthesizes
  // pill.click() here so this click handler still fires.
  //
  // In a plain browser tab there's no native container — the click
  // handler runs normally. Hover-to-expand also works in both modes:
  // when the native window is in "passthrough" state for the
  // non-pill area, mouseenter still fires on the WKWebView once the
  // cursor crosses INTO the pill region.

  let hoverTimer = null;
  pill.addEventListener('mouseenter', () => {
    clearTimeout(hoverTimer);
    hoverTimer = setTimeout(() => expandPanel(true), 250);
  });
  pill.addEventListener('mouseleave', () => {
    clearTimeout(hoverTimer);
    // Don't collapse if the mouse just moved into the expand panel.
    setTimeout(() => {
      if (!expand.matches(':hover')) expandPanel(false);
    }, 200);
  });
  expand.addEventListener('mouseleave', () => expandPanel(false));

  pill.addEventListener('click', (e) => {
    e.preventDefault();
    expandPanel(!body.classList.contains('expanded'));
  });
  pill.addEventListener('dblclick', (e) => {
    e.preventDefault();
    openFull();
  });

  function openFull(prefill) {
    // If a Swift container is present (Phase 2), prefer to delegate. Pass the
    // optional prefill text so the app can drop it into the chat composer.
    if (window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.island) {
      window.webkit.messageHandlers.island.postMessage({ type: 'open_full_gui', prefill: prefill || '' });
    } else {
      window.open(prefill ? '/?prefill=' + encodeURIComponent(prefill) : '/', '_blank');
    }
  }
  btnOpen.addEventListener('click', (e) => { e.stopPropagation(); openFull(); });

  // Optimize ▸ — prefill the suggested task into the chat for the user to
  // confirm (and then Lisa can dispatch a coding agent). Never auto-runs.
  if (suggAct) {
    suggAct.addEventListener('click', (e) => {
      e.stopPropagation();
      const s = state.suggestion;
      if (!s) return;
      const prompt =
        s.task +
        '\\n\\n(Suggested from my screen: "' + s.title + '". ' +
        'If this is worth doing, dispatch a coding agent for it — confirm the repo/dir with me first.)';
      openFull(prompt);
    });
  }
  btnDismiss.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (!state.unread) return;
    try { await fetch('/api/island/dismiss-unread', { method: 'POST' }); } catch (_) {}
    state.unread = false;
    state.idleText = '';
    refreshDot();
    refreshPanel();
  });

  // ── Server polling for richer state ────────────────────────────────
  let backoff = 5_000;
  async function pollPing() {
    try {
      const r = await fetch('/api/island/ping', { cache: 'no-store' });
      if (!r.ok) throw new Error('not ok');
      const j = await r.json();
      state.online  = !!j.online;
      state.unread  = !!j.has_unread_idle_message;
      state.idleText = j.last_idle_message_text || '';
      state.desire  = j.current_desire || null;
      if (j.mood) setAvatar(j.mood);
      backoff = 5_000;
    } catch (_) {
      state.online = false;
    }
    refreshDot();
    refreshPanel();
  }

  // ── SSE subscription for instant pulses ────────────────────────────
  let es = null;
  function subscribe() {
    try { if (es) es.close(); } catch (_) {}
    es = new EventSource('/events');
    es.addEventListener('open', () => {
      state.online = true;
      refreshDot();
      refreshPanel();
    });
    es.addEventListener('message', (ev) => {
      let m;
      try { m = JSON.parse(ev.data); } catch (_) { return; }
      switch (m.type) {
        case 'mood':
          setAvatar(m.slug);
          break;
        case 'chat_start':
          state.thinking = true;
          refreshDot();
          break;
        case 'chat_end':
          state.thinking = false;
          refreshDot();
          break;
        case 'idle_start':
          state.dreaming = true;
          refreshDot();
          break;
        case 'idle_done':
        case 'idle_error':
          state.dreaming = false;
          refreshDot();
          break;
        case 'idle_message':
          state.dreaming = false;
          state.unread = true;
          state.idleText = (m.text || '').slice(0, 1000);
          refreshDot();
          refreshPanel();
          // One subtle pulse so a watching user notices.
          document.body.animate(
            [{ opacity: 0.7 }, { opacity: 1 }, { opacity: 0.85 }],
            { duration: 600, iterations: 2 },
          );
          break;
        case 'screen_suggestion':
          if (m.title && m.task) {
            state.suggestion = { title: m.title, rationale: m.rationale || '', task: m.task, at: m.at };
            refreshPanel();
            // gentle pulse + auto-expand so a watching user notices
            expandPanel(true);
            document.body.animate(
              [{ opacity: 0.75 }, { opacity: 1 }],
              { duration: 500, iterations: 2 },
            );
          }
          break;
        case 'advisor_suggestions':
          state.advisor = Array.isArray(m.suggestions) ? m.suggestions : [];
          refreshPanel();
          break;
        case 'claude_session_update':
          upsertClaudeSession({
            project: m.projectLabel,
            projectEncoded: m.projectEncoded,
            sessionId: m.sessionId,
            lastMtime: m.ts,
            state: m.state || 'unknown',
            stateReason: m.stateReason || '',
            cwd: m.cwd || '',
          });
          refreshDot();
          refreshPanel();
          break;
      }
    });
    es.addEventListener('error', () => {
      state.online = false;
      refreshDot();
      refreshPanel();
      // Auto-retry: SSE EventSource reconnects on its own, but if the page
      // server is down entirely we'll keep firing 'error' until it's back.
    });
  }

  // ── Claude Code session helpers ────────────────────────────────────

  function upsertClaudeSession(s) {
    const idx = state.claudeSessions.findIndex(
      (x) => x.sessionId === s.sessionId
    );
    const prevState = idx >= 0 ? state.claudeSessions[idx].state : null;
    if (idx >= 0) state.claudeSessions[idx] = s;
    else state.claudeSessions.push(s);
    pruneClaudeSessions();

    // Phase 3 — record transition + maybe notify on entering "waiting".
    const transitioned = recordStateHistory(s.sessionId, {
      state: s.state,
      reason: s.stateReason,
      lastMtime: s.lastMtime,
    });
    if (transitioned) maybeNotifyWaiting(prevState, s);
  }

  function pruneClaudeSessions() {
    const cutoff = Date.now() - CLAUDE_ACTIVE_WINDOW_MS;
    state.claudeSessions = state.claudeSessions.filter(
      (s) => new Date(s.lastMtime).getTime() >= cutoff
    );
  }

  async function fetchClaudeSessions() {
    try {
      const r = await fetch('/api/claude/sessions', { cache: 'no-store' });
      if (!r.ok) return;
      const j = await r.json();
      if (Array.isArray(j.sessions)) {
        state.claudeSessions = j.sessions.map((s) => ({
          project: s.project,
          projectEncoded: s.projectEncoded,
          sessionId: s.sessionId,
          lastMtime: s.lastMtime,
          state: s.state || 'unknown',
          stateReason: s.stateReason || '',
          cwd: s.cwd || '',
        }));
        // Phase 3 — seed each session's history with its current state
        // so the trail isn't empty on first open. Doesn't notify (no
        // transition implied by initial load).
        for (const s of state.claudeSessions) {
          recordStateHistory(s.sessionId, {
            state: s.state,
            reason: s.stateReason,
            lastMtime: s.lastMtime,
          });
        }
      }
    } catch (_) {
      // server might not yet have the endpoint (older LISA) — silent
    }
  }

  // Phase 3 — notification permission opt-in. The CTA is only visible
  // when permission is in the default (un-asked) state.
  notifyCta.addEventListener('click', (e) => {
    e.stopPropagation();
    requestNotificationPermission();
  });
  notifyCta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') requestNotificationPermission();
  });

  // ── Bootstrap ──────────────────────────────────────────────────────
  setAvatar('neutral');
  pollPing();
  fetchClaudeSessions().then(() => { refreshDot(); refreshPanel(); });
  subscribe();
  refreshNotifyCta();
  // A fresh island picks up the most recent screen-advisor suggestion (if the
  // feature is on and one was made before this widget loaded).
  fetch('/api/screen-advisor/latest', { cache: 'no-store' })
    .then((r) => r.ok ? r.json() : null)
    .then((j) => { if (j && j.suggestion) { state.suggestion = j.suggestion; refreshPanel(); } })
    .catch(() => {});
  // …and the latest cross-agent advisor suggestions.
  fetch('/api/advisor/latest', { cache: 'no-store' })
    .then((r) => r.ok ? r.json() : null)
    .then((j) => {
      if (j && Array.isArray(j.suggestions) && j.suggestions.length) {
        state.advisor = j.suggestions;
        refreshPanel();
      }
    })
    .catch(() => {});
  // Lightweight resync — covers cases where SSE silently disconnected
  // (laptop sleep, network blip) and we need to refresh state.
  setInterval(pollPing, 30_000);
  setInterval(fetchClaudeSessions, 60_000);
  // Re-render every 15s so "Xs ago" / "Xm ago" labels stay fresh and
  // stale sessions fall off the list without a fresh update event.
  setInterval(() => {
    pruneClaudeSessions();
    refreshDot();
    refreshPanel();
  }, 15_000);
})();
</script>
</body>
</html>
`;

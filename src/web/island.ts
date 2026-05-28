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
    --fg: #e4e4e6;
    --fg-dim: #9ba3b8;
    --fg-faint: #6b7280;
    --accent: #6ad4ff;
    --accent-warm: #ffd066;
    --accent-dream: #b487ff;
    --accent-claude: #ff8c42;
    --border: rgba(255, 255, 255, 0.06);
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
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 22px;
    padding: 5px 14px 5px 5px;
    backdrop-filter: blur(20px);
    -webkit-backdrop-filter: blur(20px);
    box-shadow: 0 6px 20px rgba(0, 0, 0, 0.4);
    cursor: pointer;
    transition: transform 200ms ease, opacity 200ms ease;
    max-width: 280px;
  }
  #pill:hover { transform: translateY(1px); }

  #avatar {
    width: 30px;
    height: 30px;
    border-radius: 50%;
    background-color: #15192a;
    background-size: cover;
    background-position: center;
    flex-shrink: 0;
    image-rendering: pixelated;
    border: 1px solid var(--border);
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
  #dot.claude-working { background: var(--accent-claude);  animation: pulse 1.8s ease-in-out infinite; }
  #dot.claude-waiting { background: var(--accent-claude); }  /* solid — "needs you" */
  #dot.claude-error   { background: #ff5577;               animation: pulse 0.8s ease-in-out infinite; }
  #dot.offline        { background: var(--fg-faint); }

  @keyframes pulse {
    0%, 100% { opacity: 0.35; }
    50%      { opacity: 1; }
  }

  /* Expanded panel — appears below the pill on hover/click */
  #expand {
    margin-top: 8px;
    width: 308px;
    background: var(--bg-strong);
    border: 1px solid var(--border);
    border-radius: 16px;
    padding: 12px 14px;
    backdrop-filter: blur(20px);
    -webkit-backdrop-filter: blur(20px);
    box-shadow: 0 12px 36px rgba(0, 0, 0, 0.5);
    font-size: 12px;
    line-height: 1.5;
    box-sizing: border-box;
    opacity: 0;
    transform: translateY(-4px);
    pointer-events: none;
    transition: opacity 200ms ease, transform 200ms ease;
  }
  body.expanded #expand {
    opacity: 1;
    transform: none;
    pointer-events: auto;
  }

  .section-label {
    color: var(--accent);
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    font-size: 10px;
    margin-bottom: 4px;
  }
  .section-body {
    color: var(--fg-dim);
    margin-bottom: 10px;
    word-wrap: break-word;
  }
  .section-body:last-child { margin-bottom: 0; }

  #idle-section { display: none; }
  body.has-unread #idle-section { display: block; }
  #idle-body {
    background: rgba(255, 208, 102, 0.07);
    border-left: 2px solid var(--accent-warm);
    padding: 6px 10px;
    margin-bottom: 10px;
    border-radius: 4px;
    color: var(--fg);
    max-height: 96px;
    overflow-y: auto;
    white-space: pre-wrap;
  }

  /* Claude Code section — appears when there's active Claude Code activity */
  #claude-section { display: none; }
  body.has-claude #claude-section { display: block; }
  #claude-section .section-label { color: var(--accent-claude); }
  #claude-list {
    list-style: none;
    padding: 0;
    margin: 0 0 10px;
    border-left: 2px solid var(--accent-claude);
    background: rgba(255, 140, 66, 0.06);
    border-radius: 4px;
    overflow: hidden;
  }
  #claude-list li {
    padding: 5px 10px;
    color: var(--fg);
    font-size: 11px;
    display: flex;
    justify-content: space-between;
    gap: 8px;
    cursor: pointer;
    transition: background 120ms ease;
  }
  #claude-list li:hover { background: rgba(255, 140, 66, 0.10); }
  #claude-list li + li { border-top: 1px solid rgba(255, 140, 66, 0.10); }
  #claude-list .proj { font-weight: 600; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  #claude-list .when { color: var(--fg-dim); flex-shrink: 0; font-variant-numeric: tabular-nums; }
  #claude-list .empty { padding: 6px 10px; color: var(--fg-faint); font-style: italic; }

  /* Phase 2 — per-session state pip prefix */
  #claude-list .pip {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    flex-shrink: 0;
    background: var(--fg-faint);
    margin-right: 2px;
  }
  #claude-list .pip.working { background: var(--accent-claude); animation: pulse 1.8s ease-in-out infinite; }
  #claude-list .pip.waiting { background: var(--accent-claude); }
  #claude-list .pip.error   { background: #ff5577; }
  #claude-list .pip.unknown { background: var(--fg-faint); }

  /* Phase 3 — state transition trail, shown below the row when its
     parent <li> has the .expanded class. */
  #claude-list .trail {
    display: none;
    margin: 4px 0 0 14px;
    padding: 4px 0 0;
    border-top: 1px dashed rgba(255, 140, 66, 0.18);
    font-size: 10px;
    color: var(--fg-faint);
    line-height: 1.6;
  }
  #claude-list li.row-open .trail { display: block; }
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
  #claude-list li > .head { display: contents; }

  /* Phase 3 — notification opt-in chip */
  #notify-cta {
    display: none;
    margin-top: 8px;
    padding: 6px 10px;
    border-radius: 8px;
    background: rgba(255, 140, 66, 0.12);
    border: 1px solid rgba(255, 140, 66, 0.30);
    font-size: 10.5px;
    color: var(--fg);
    text-align: center;
    cursor: pointer;
    transition: background 120ms ease;
  }
  #notify-cta:hover { background: rgba(255, 140, 66, 0.18); }
  body.notify-default #notify-cta { display: block; }

  #actions {
    display: flex;
    gap: 6px;
    margin-top: 4px;
  }
  button {
    flex: 1;
    background: rgba(255, 255, 255, 0.05);
    border: 1px solid var(--border);
    color: var(--fg);
    padding: 6px 10px;
    border-radius: 8px;
    font-size: 11px;
    cursor: pointer;
    font-family: inherit;
    transition: background 150ms ease;
  }
  button:hover  { background: rgba(255, 255, 255, 0.10); }
  button:active { background: rgba(255, 255, 255, 0.15); }
  button.muted  { opacity: 0.5; }

  /* Offline state — desaturate + dim */
  body.offline #avatar { filter: grayscale(1); opacity: 0.5; }
  body.offline #label  { color: var(--fg-faint); }
</style>
</head>
<body>
  <div id="pill" role="button" tabindex="0" aria-label="Lisa island">
    <div id="avatar" aria-hidden="true"></div>
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

  // ── Phase 3 — Notification API ───────────────────────────────────
  // Fires "Claude needs you in <project>" notifications when a session
  // transitions INTO waiting (i.e., Claude finished and the user is
  // expected to respond). Throttled per session so a flaky tool that
  // bounces between waiting/working doesn't spam. Permission opt-in
  // via the chip in the expand panel.
  const NOTIFY_THROTTLE_MS = 60_000;
  const lastNotifyAt = new Map();

  function notifPermission() {
    return ('Notification' in window) ? Notification.permission : 'unsupported';
  }

  function refreshNotifyCta() {
    body.classList.toggle('notify-default', notifPermission() === 'default');
  }

  function requestNotificationPermission() {
    if (!('Notification' in window) || Notification.permission !== 'default') {
      refreshNotifyCta();
      return;
    }
    Notification.requestPermission().then(() => refreshNotifyCta()).catch(() => {});
  }

  function maybeNotifyWaiting(prevState, info) {
    if (info.state !== 'waiting') return;
    if (prevState === 'waiting') return;     // already in this state
    if (notifPermission() !== 'granted') return;
    const last = lastNotifyAt.get(info.sessionId) || 0;
    if (Date.now() - last < NOTIFY_THROTTLE_MS) return;
    lastNotifyAt.set(info.sessionId, Date.now());
    try {
      const reasonLabel = info.reason === 'permission' ? 'needs permission' : 'is waiting';
      const n = new Notification('Claude ' + reasonLabel + ' in ' + info.project, {
        body: info.sessionId.slice(0, 8) + ' · click to open Lisa',
        tag: 'lisa-claude-' + info.sessionId, // replaces older for same session
        icon: '/assets/lisa-mascot.png',
        silent: false,
      });
      n.onclick = () => {
        window.focus();
        if (window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.island) {
          window.webkit.messageHandlers.island.postMessage({ type: 'open_full_gui' });
        } else {
          window.open('/', '_blank');
        }
        n.close();
      };
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
    avatar.style.backgroundImage = "url('/assets/lisa/" + encodeURIComponent(slug) + ".png')";
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
    renderClaudeList();
  }

  function relativeTime(iso) {
    const ms = Date.now() - new Date(iso).getTime();
    if (ms < 30_000)             return 'just now';
    if (ms < 60_000)             return Math.round(ms / 1000) + 's ago';
    if (ms < 3600_000)           return Math.round(ms / 60_000) + 'm ago';
    return Math.round(ms / 3600_000) + 'h ago';
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
      const pip = document.createElement('span');
      pip.className = 'pip ' + (s.state || 'unknown');
      const proj = document.createElement('span');
      proj.className = 'proj';
      proj.textContent = s.project;
      const when = document.createElement('span');
      when.className = 'when';
      when.textContent = relativeTime(s.lastMtime);
      li.appendChild(pip);
      li.appendChild(proj);
      li.appendChild(when);

      // Phase 3 — collapsible state-transition trail
      const trail = document.createElement('div');
      trail.className = 'trail';
      renderTrail(trail, s);
      li.appendChild(trail);

      li.title = s.state + (s.stateReason ? ' (' + s.stateReason + ')' : '')
               + ' · ' + s.sessionId
               + '\nclick: expand timeline · double-click: copy sessionId';
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
    body.classList.toggle('expanded', open);
  }

  // ── Interaction ────────────────────────────────────────────────────
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

  function openFull() {
    // If a Swift container is present (Phase 2), prefer to delegate.
    if (window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.island) {
      window.webkit.messageHandlers.island.postMessage({ type: 'open_full_gui' });
    } else {
      window.open('/', '_blank');
    }
  }
  btnOpen.addEventListener('click', (e) => { e.stopPropagation(); openFull(); });
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
        case 'claude_session_update':
          // Watcher noticed activity in ~/.claude/projects/. Splice the
          // updated session into our local list (with its newly-derived
          // state) and re-render.
          upsertClaudeSession({
            project: m.projectLabel,
            projectEncoded: m.projectEncoded,
            sessionId: m.sessionId,
            lastMtime: m.ts,
            state: m.state || 'unknown',
            stateReason: m.stateReason || '',
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

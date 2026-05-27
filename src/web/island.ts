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
  #dot.thinking { background: var(--accent);     animation: pulse 1.2s ease-in-out infinite; }
  #dot.dreaming { background: var(--accent-dream); animation: pulse 2.4s ease-in-out infinite; }
  #dot.unread   { background: var(--accent-warm); }
  #dot.offline  { background: var(--fg-faint); }

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
    <div id="actions">
      <button id="btn-open">Open chat</button>
      <button id="btn-dismiss" class="muted">Dismiss ★</button>
    </div>
  </div>

<script>
(() => {
  const pill        = document.getElementById('pill');
  const avatar      = document.getElementById('avatar');
  const dot         = document.getElementById('dot');
  const expand      = document.getElementById('expand');
  const desireBody  = document.getElementById('desire-body');
  const idleBody    = document.getElementById('idle-body');
  const btnOpen     = document.getElementById('btn-open');
  const btnDismiss  = document.getElementById('btn-dismiss');
  const body        = document.body;

  const state = {
    mood: 'neutral',
    online: false,
    unread: false,
    idleText: '',
    desire: null,
    thinking: false,
    dreaming: false,
  };

  function setAvatar(slug) {
    if (!slug) return;
    state.mood = slug;
    avatar.style.backgroundImage = "url('/assets/lisa/" + encodeURIComponent(slug) + ".png')";
  }

  function refreshDot() {
    dot.className = '';
    if (!state.online)      { dot.classList.add('offline');  return; }
    if (state.thinking)     { dot.classList.add('thinking'); return; }
    if (state.dreaming)     { dot.classList.add('dreaming'); return; }
    if (state.unread)       { dot.classList.add('unread');   return; }
  }

  function refreshPanel() {
    body.classList.toggle('offline',   !state.online);
    body.classList.toggle('has-unread', state.unread);
    desireBody.textContent = state.desire || '(nothing actively pursued)';
    idleBody.textContent   = state.idleText || '';
    btnDismiss.classList.toggle('muted', !state.unread);
    btnDismiss.disabled = !state.unread;
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

  // ── Bootstrap ──────────────────────────────────────────────────────
  setAvatar('neutral');
  pollPing();
  subscribe();
  // Lightweight resync — covers cases where SSE silently disconnected
  // (laptop sleep, network blip) and we need to refresh state.
  setInterval(pollPing, 30_000);
})();
</script>
</body>
</html>
`;

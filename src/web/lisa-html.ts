/**
 * Lisa.app chat HTML — the main /web shell.
 *
 * Extracted out of server.ts so the visual layer (CSS + body markup +
 * client JS) can evolve as one piece without bloating the server module.
 *
 * Design language follows reference/mockups/lisa-app-redesign.html:
 *   - Glass-morphism dark UI with cyan (#6ad4ff) brand accent
 *   - 280px sidebar (identity card · currently wanting · Claude monitor ·
 *     last reflection · SOUL/SKILLS/MEMORY/TOOLS row · session badge)
 *   - Right pane: chat log + composer
 *
 * IDs preserved from the previous pixel-art shell so the existing
 * client-side JS (history loading, mood updates, modal panels, birth
 * ritual, cfg gate, attachments, send + SSE streaming) keeps working
 * unchanged:
 *   log, input, form, sendBtn, sessionId, fileInput, attachPreview,
 *   mascot, mascotTag, modalBg, modalTitle, modalBody, modalClose,
 *   cfgOverlay, cfgForm, cfgAnthropic, cfgOpenai, cfgSave, cfgError,
 *   birthOverlay, birthSteps, birthFinal, birthEnter, birthError,
 *   attachBtn
 *
 * New IDs for the sidebar live blocks (wired in the trailing
 * "sidebar live wiring" script section):
 *   identitySub, sbDesire, sbClaudeCard, sbClaudeCount, sbClaudeRows,
 *   sbReflection, sbReflectionBody, sbSessionBadge
 */

import { MAIN_CSS } from "./lisa-css.js";
import { MAIN_CLIENT_JS } from "./lisa-client.js";

export const MAIN_HTML = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>LISA</title>
<link rel="manifest" href="/manifest.webmanifest">
<meta name="theme-color" content="#07091a">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="LISA">
<link rel="apple-touch-icon" href="/assets/lisa-mascot.png">
<link rel="icon" type="image/png" href="/assets/lisa-mascot.png">
<style>
${MAIN_CSS}
</style>
</head><body>

<div class="frame">

  <!-- ╔════════════════ Title bar (drag zone) ════════════════╗ -->
  <div class="titlebar">
    <span>Lisa</span><span class="session-tag" id="titlebarSession"></span>
  </div>

  <!-- ╔════════════════ Sidebar ════════════════╗ -->
  <aside class="sidebar">

    <!-- LISA workspace -->
    <div class="ws-pill">
      <span class="ws-dot"></span>
      <span class="ws-name">LISA workspace</span>
      <span class="ws-ico">⌄</span>
    </div>

    <!-- Identity card -->
    <div class="identity">
      <div class="avatar-wrap">
        <img id="mascot" src="/assets/lisa-mascot.png" alt="Lisa" draggable="false">
      </div>
      <div>
        <h1>Lisa</h1>
        <p class="sub" id="identitySub">—</p>
        <div class="mood" id="mascotTag">neutral</div>
      </div>
    </div>

    <!-- Primary navigation (view switcher — wired in setupConsole) -->
    <nav class="nav-list" id="navList">
      <button class="nav-item active" type="button" data-view="chat"><span class="nav-ico">◍</span>Chat</button>
      <button class="nav-item" type="button" data-view="dashboard"><span class="nav-ico">▦</span>Dashboard</button>
      <button class="nav-item" type="button" data-view="control"><span class="nav-ico">⌘</span>Control<span class="nav-tag" id="navAgentCount">0</span></button>
      <button class="nav-item" type="button" data-view="reve"><span class="nav-ico">☾</span>Rêve</button>
      <button class="nav-item" type="button" data-view="sense"><span class="nav-ico">◉</span>Sense</button>
      <button class="nav-item" type="button" data-view="memory"><span class="nav-ico">✦</span>Memory</button>
    </nav>

    <!-- Currently wanting -->
    <div class="sb-section">
      <h2>currently wanting</h2>
      <p class="body-text" id="sbDesire">—</p>
    </div>

    <!-- Claude Code monitor -->
    <div class="card tint-claude" id="sbClaudeCard">
      <div class="h">
        <div class="left">agents</div>
        <div class="count">▶︎ <span id="sbClaudeCount">0</span></div>
      </div>
      <button id="sbDelegateBtn" class="delegate-btn" type="button" title="Start an agent">
        ＋ delegate a task
      </button>
      <div id="sbClaudeRows">
        <div class="session-empty">(idle)</div>
      </div>
    </div>

    <!-- Last reflection (collapsed pointer to the most recent ★) -->
    <div class="card tint-idle" id="sbReflection" style="display:none;">
      <div class="h">
        <div class="left">★ last reflection</div>
      </div>
      <p style="margin:0; font-size:11.5px; color:var(--fg-2); line-height:1.5;" id="sbReflectionBody"></p>
    </div>

    <!-- SOUL / SKILLS / MEMORY / TOOLS row -->
    <div class="badges">
      <button class="badge" type="button" data-panel="soul"><img src="/assets/icon-soul.png" alt="">SOUL</button>
      <button class="badge" type="button" data-panel="skills"><img src="/assets/icon-skill.png" alt="">SKILLS</button>
      <button class="badge" type="button" data-panel="memory"><img src="/assets/icon-memory.png" alt="">MEMORY</button>
      <button class="badge" type="button" data-panel="tools"><img src="/assets/icon-tool.png" alt="">TOOLS</button>
      <button class="badge" type="button" data-panel="plans"><img src="/assets/icon-tool.png" alt="">PLANS</button>
    </div>

    <!-- Proactive autonomy toggle (master switch — wired in setupConsole) -->
    <div class="proactive-toggle" id="proactiveToggle" role="switch" aria-checked="false" tabindex="0" title="Let Lisa watch and act on her own when you're away">
      <span class="pt-label">Proactive</span>
      <span class="pt-track"><span class="pt-knob"></span></span>
    </div>

    <!-- Footer: current session id -->
    <div class="sb-footer">
      <span class="session-id" id="sessionId">—</span>
      <span class="badge-count" id="sbSessionBadge" title="total sessions">·</span>
    </div>
  </aside>

  <!-- ╔════════════════ Main pane ════════════════╗ -->
  <div class="main">

    <!-- Chat view (default home) — log + attachments + composer -->
    <div class="view active" id="viewChat">

    <!-- Chat log (messages, tool blocks, idle blocks injected here) -->
    <div id="log"></div>

    <!-- Attachment chip strip (above composer) -->
    <div id="attachPreview"></div>

    <!-- Composer -->
    <form id="form">
      <label id="attachBtn" title="Attach file (or paste images directly into the textarea)">
        <input type="file" id="fileInput" accept="image/*,.pdf,.txt,.md,.csv,.json" multiple>
        📎
      </label>
      <button type="button" id="captureBtn" title="Screenshot for Lisa (⌃⌥S anywhere)">📷</button>
      <button type="button" id="recordBtn" title="Dictate — speak and Lisa drops polished text in the box (hold to record a summary)">🎙</button>
      <textarea id="input" placeholder="Talk to Lisa…  (Enter to send · Shift+Enter for newline)" autofocus></textarea>
      <button type="submit" id="sendBtn">
        <img src="/assets/icon-send.png" alt="">
        SEND →
      </button>
    </form>
    </div><!-- /#viewChat -->

    <!-- Console views (populated lazily by setupConsole in lisa-client.ts) -->
    <section class="view" id="viewDashboard"></section>
    <section class="view" id="viewControl"></section>
    <section class="view" id="viewReve"></section>
    <section class="view" id="viewSense"></section>
    <section class="view" id="viewMemory"></section>
  </div>
</div>

<!-- ╔════════════════ Overlays ════════════════╗ -->

<div class="modal-bg" id="modalBg">
  <div class="modal">
    <div class="modal-head">
      <div class="modal-title" id="modalTitle">…</div>
      <button class="modal-close" id="modalClose">Close · esc</button>
    </div>
    <div class="modal-body" id="modalBody">…</div>
  </div>
</div>

<!-- API key config overlay (shown if no key configured yet) -->
<div class="cfg-overlay" id="cfgOverlay">
  <div class="cfg-card">
    <div class="cfg-stars">✦  ✦  ✦  ✦  ✦</div>
    <div class="cfg-title">SET · API · KEY</div>
    <div class="cfg-sub">
      Lisa needs an Anthropic API key to wake up.<br>
      <a href="https://console.anthropic.com/" target="_blank" rel="noopener">Get one at console.anthropic.com</a>
    </div>
    <form id="cfgForm">
      <label class="cfg-field">
        <span class="cfg-label">ANTHROPIC_API_KEY</span>
        <input class="cfg-input" id="cfgAnthropic" type="password" autocomplete="off"
               spellcheck="false" placeholder="sk-ant-..." required>
      </label>
      <label class="cfg-field">
        <span class="cfg-label">OPENAI_API_KEY <span class="opt">(optional · for gpt-* models)</span></span>
        <input class="cfg-input" id="cfgOpenai" type="password" autocomplete="off"
               spellcheck="false" placeholder="sk-...">
      </label>
      <div class="cfg-help">
        Saved to <code>~/.lisa/config.env</code> with mode 0600. Stays on this machine.
      </div>
      <div class="cfg-actions">
        <button class="cfg-save" id="cfgSave" type="submit">SAVE &amp; CONTINUE</button>
      </div>
      <div class="cfg-error" id="cfgError"></div>
    </form>
  </div>
</div>

<!-- Birth ritual full-screen overlay -->
<div class="birth-overlay" id="birthOverlay">
  <div class="birth-content">
    <div class="birth-stars">✦  ✦  ✦  ✦  ✦</div>
    <div class="birth-title">B I R T H · R I T U A L</div>
    <div id="birthSteps"></div>
    <div class="birth-final" id="birthFinal"></div>
    <button class="birth-enter" id="birthEnter">ENTER</button>
    <div class="birth-error" id="birthError"></div>
    <div class="birth-stars" style="margin-top: 24px;">✦  ✦  ✦  ✦  ✦</div>
  </div>
</div>

<script>
${MAIN_CLIENT_JS}
</script>
</body></html>`;

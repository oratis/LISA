/**
 * Lisa Room — an ambient, state-driven living space served at GET /room.
 *
 * A cozy pixel-art room where Lisa "lives". Unlike a scripted waifu wallpaper,
 * every layer here is driven by Lisa's REAL state: her current mood sprite,
 * whether she's thinking (chat_start/end), dreaming (Reve idle_*), what she's
 * pursuing (current_desire), the local time-of-day, and weather-flavored moods.
 *
 * Design: docs/PLAN_ROOM_v1.0.md. Renderer is a layered 2.5D diorama built from
 * plain DOM + CSS (no framework, no canvas, no bundler) — the same self-contained
 * pattern as src/web/island.ts. The three room backgrounds (day/dusk/night) and
 * Lisa's FULL-BODY character sprites are generated pixel art under /assets/room/.
 * Lisa is a full-body sprite (not a bust): an idle spritesheet (lisa-idle.png,
 * 2 frames: eyes open | closed — breathing via CSS, blink flips the frame) plus
 * pose sprites for sitting (lisa-sit.png) and sleeping (lisa-sleep.png), swapped
 * by mood/state. Sprites were generated via the "anchor → keyframes → chroma-key
 * + foot-anchor" pipeline (cf. Ludo.ai / chongdashu/ai-game-spritesheets):
 * gemini-2.5-flash-image made a full-body anchor from her existing face sprite,
 * pose/blink frames were edited from it for consistency, then keyed + normalized.
 *
 * Data sources (all pre-existing, shared with the Island):
 *   - SSE  GET /events            → mood / chat_start / chat_end / idle_* pulses
 *   - poll GET /api/island/ping   → { online, mood, current_desire, unread, ... }
 *   - POST /api/island/dismiss-unread → mark the "letter" read
 */

export const ROOM_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
<title>Lisa · room</title>
<link rel="manifest" href="/manifest.webmanifest">
<style>
  :root {
    color-scheme: dark;
    --fg: #eef1f8;
    --fg-dim: #b9c0d4;
    --fg-faint: #7f8aa3;
    --accent: #6ad4ff;
    --accent-warm: #ffd066;
    --accent-dream: #b487ff;
    --ink: rgba(6, 9, 18, 0.72);
    --spring: cubic-bezier(0.22, 1, 0.36, 1);
    --stage: min(100vh, 100vw);
  }
  * { box-sizing: border-box; }
  html, body {
    margin: 0; padding: 0; height: 100%; overflow: hidden;
    background: #0a0e1a;
    font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif;
    -webkit-font-smoothing: antialiased;
    color: var(--fg); user-select: none; cursor: default;
  }

  /* Backdrop fills the whole viewport with a soft, blurred, darkened zoom of
     the current room art, so wide or tall windows never show empty bars. */
  #backdrop {
    position: fixed; inset: 0; z-index: 0;
    background-size: cover; background-position: center;
    filter: blur(30px) brightness(0.42) saturate(1.15); transform: scale(1.25);
    transition: background-image 1400ms ease;
  }
  /* The room is a square shown IN FULL (contain), anchored to the floor at the
     viewport bottom, so every %-positioned prop stays glued to the art at any
     window shape. Side/top gaps are covered by #backdrop. */
  #stage {
    position: fixed; left: 50%; bottom: 0; z-index: 1;
    width: min(100vw, 100vh); height: min(100vw, 100vh);
    transform: translateX(-50%);
    will-change: transform;
  }

  /* Background time-of-day layers — two stacked so we can crossfade. A slight
     scale hides the art's dark vignette border (cover over-scan). */
  .bg {
    position: absolute; inset: 0;
    background-size: cover; background-position: center;
    transform: scale(1.06);
    opacity: 0; transition: opacity 1400ms ease;
    image-rendering: pixelated;
  }
  .bg.show { opacity: 1; }
  #bg-day   { background-image: url('/assets/room/room-day.png'); }
  #bg-dusk  { background-image: url('/assets/room/room-dusk.png'); }
  #bg-night { background-image: url('/assets/room/room-night.png'); }

  /* Lighting / mood wash over the whole scene. Tint + vignette driven by state. */
  #lighting {
    position: absolute; inset: 0; pointer-events: none;
    mix-blend-mode: soft-light; opacity: 0.0;
    transition: opacity 1200ms ease, background 1600ms ease;
    background: radial-gradient(120% 90% at 50% 40%, transparent 40%, rgba(0,0,0,0.5) 100%);
  }
  #vignette {
    position: absolute; inset: 0; pointer-events: none;
    box-shadow: inset 0 0 min(18vmin,180px) min(6vmin,60px) rgba(4,6,14,0.55);
  }

  /* Lisa herself — composited standing on the rug, centered. Her 512² sprite is
     a transparent bust; we anchor her bottom near the rug and let her breathe. */
  /* Lisa — a FULL-BODY animated sprite standing on the rug (not a bust). The
     idle sheet has 2 frames (eyes open | eyes closed) side by side; breathing
     is a CSS transform, blinking flips the background frame. Pose swaps
     (sit / sleep) change the image + box size. Foot-anchored so she stands
     on the floor. */
  #lisa-wrap {
    position: absolute; left: 47%; bottom: 6.5%;
    transform: translateX(-50%);
    transition: left 1000ms var(--spring), bottom 1000ms var(--spring);
    pointer-events: none;
  }
  #shadow {
    position: absolute; left: 50%; bottom: -1%; transform: translateX(-50%);
    width: 20vmin; height: 3vmin;
    background: radial-gradient(50% 50% at 50% 50%, rgba(0,0,0,0.5), transparent 72%);
    filter: blur(3px); transition: width 800ms ease;
  }
  #lisa {
    width: 31vmin; height: 46vmin;              /* standing box (512:768 aspect) */
    background-image: url('/assets/room/lisa-idle.png');
    background-repeat: no-repeat; background-size: 200% 100%; background-position: 0% 0%;
    image-rendering: pixelated;
    transform-origin: 50% 100%;
    animation: breathe 4.4s ease-in-out infinite;
    filter: drop-shadow(0 10px 10px rgba(0,0,0,0.32));
    cursor: pointer; pointer-events: auto;
    -webkit-user-drag: none; user-select: none;
    transition: width 700ms var(--spring), height 700ms var(--spring), filter 500ms ease;
  }
  #lisa.blink { background-position: 100% 0%; }
  @keyframes breathe {
    0%, 100% { transform: scaleY(1)     translateY(0); }
    50%      { transform: scaleY(1.014) translateY(-0.3%); }
  }
  #lisa:hover { filter: drop-shadow(0 0 16px rgba(106,212,255,0.55)) drop-shadow(0 10px 10px rgba(0,0,0,0.4)); }

  /* Sitting with her laptop — coding / reading / focused moods. */
  #lisa-wrap.sit #lisa {
    background-image: url('/assets/room/lisa-sit.png');
    background-size: 100% 100%; background-position: 0 0;
    width: 30vmin; height: 34vmin; animation-duration: 5.8s;
  }
  #lisa-wrap.sit #lisa.blink { background-position: 0 0; }
  #lisa-wrap.sit #shadow { width: 22vmin; }
  /* Sleeping / curled up — Reve / napping. */
  #lisa-wrap.sleep #lisa {
    background-image: url('/assets/room/lisa-sleep.png');
    background-size: 100% 100%; background-position: 0 0;
    width: 34vmin; height: 24vmin; animation-duration: 6.6s;
  }
  #lisa-wrap.sleep #lisa.blink { background-position: 0 0; }
  #lisa-wrap.sleep #shadow { width: 26vmin; }

  /* Monitor glow — sits over the desk's screen; pulses while she's thinking. */
  #glow-monitor {
    position: absolute; left: 13.5%; top: 51.5%; width: 12%; height: 10%;
    border-radius: 40%;
    background: radial-gradient(50% 50% at 50% 50%, rgba(106,212,255,0.55), transparent 70%);
    opacity: 0; pointer-events: none; filter: blur(6px);
    transition: opacity 500ms ease;
  }
  body.thinking #glow-monitor { animation: monitorPulse 1.6s ease-in-out infinite; }
  @keyframes monitorPulse { 0%,100% { opacity: 0.25; } 50% { opacity: 0.85; } }

  /* Dreaming — dim the room and float Z's above Lisa. */
  body.dreaming #lighting { opacity: 0.9; background: radial-gradient(120% 90% at 50% 35%, rgba(40,20,80,0.25) 20%, rgba(2,3,10,0.78) 100%); }
  #zzz { position: absolute; left: 58%; bottom: 52%; pointer-events: none; opacity: 0; transition: opacity 600ms; }
  body.dreaming #zzz { opacity: 1; }
  #zzz span {
    position: absolute; color: var(--accent-dream); font-weight: 700;
    font-size: min(3.4vmin, 34px); text-shadow: 0 0 8px rgba(180,135,255,0.6);
    animation: floatZ 3.4s ease-in-out infinite;
  }
  #zzz span:nth-child(2) { left: 2.4vmin; animation-delay: 1.1s; font-size: min(2.4vmin,24px); }
  #zzz span:nth-child(3) { left: 4.4vmin; animation-delay: 2.2s; font-size: min(1.8vmin,18px); }
  @keyframes floatZ {
    0%   { transform: translateY(0) scale(0.8); opacity: 0; }
    30%  { opacity: 1; }
    100% { transform: translateY(-6vmin) scale(1.1); opacity: 0; }
  }

  /* The "letter" — Lisa's ★ while-you-were-away message, left on the desk. */
  #letter {
    position: absolute; left: 20.5%; top: 60%; width: 6.5%; height: 5%;
    cursor: pointer; opacity: 0; transform: translateY(6px) scale(0.9);
    transition: opacity 500ms var(--spring), transform 500ms var(--spring);
    pointer-events: none;
  }
  body.unread #letter { opacity: 1; transform: none; pointer-events: auto; }
  #letter .env {
    position: absolute; inset: 0; border-radius: 12%;
    background: linear-gradient(180deg, #fff6e6, #ffe6b8);
    box-shadow: 0 2px 6px rgba(0,0,0,0.4), 0 0 0 1px rgba(140,90,20,0.4) inset;
  }
  #letter .env::after {
    content: ""; position: absolute; left: 8%; right: 8%; top: 12%; height: 46%;
    border-top: 2px solid rgba(160,110,40,0.7);
    border-left: 2px solid rgba(160,110,40,0.55);
    border-right: 2px solid rgba(160,110,40,0.55);
    transform: skewY(0.001deg); clip-path: polygon(0 0, 50% 60%, 100% 0);
  }
  #letter .halo {
    position: absolute; inset: -60%; border-radius: 50%;
    background: radial-gradient(50% 50% at 50% 50%, rgba(255,208,102,0.55), transparent 70%);
    animation: letterPulse 2.2s ease-in-out infinite; z-index: -1;
  }
  @keyframes letterPulse { 0%,100% { opacity: 0.35; transform: scale(0.9); } 50% { opacity: 0.9; transform: scale(1.08); } }

  /* Weather / ambient particles live here (built in JS). */
  #weather { position: absolute; inset: 0; pointer-events: none; overflow: hidden; }
  .drop {
    position: absolute; top: -6%; width: 1.5px; height: min(3.4vmin,34px);
    background: linear-gradient(transparent, rgba(180,210,255,0.55));
    animation: fall linear infinite;
  }
  @keyframes fall { to { transform: translateY(115vmin); } }
  .flake {
    position: absolute; top: -4%; border-radius: 50%;
    background: rgba(255,255,255,0.9); box-shadow: 0 0 4px rgba(255,255,255,0.6);
    animation: drift linear infinite;
  }
  @keyframes drift { to { transform: translateY(115vmin) translateX(4vmin); } }
  .fly {
    position: absolute; width: 4px; height: 4px; border-radius: 50%;
    background: rgba(255,224,140,0.95); box-shadow: 0 0 8px 2px rgba(255,208,102,0.7);
    animation: wander ease-in-out infinite alternate;
  }
  @keyframes wander {
    from { transform: translate(0,0); opacity: 0.3; }
    to   { transform: translate(3vmin,-3vmin); opacity: 1; }
  }

  /* ── UI chrome (minimal, floats over the scene) ─────────────────────── */
  #topbar {
    position: fixed; top: 0; left: 0; right: 0; z-index: 20;
    display: flex; align-items: center; gap: 10px;
    padding: 14px 18px;
    background: linear-gradient(180deg, rgba(4,6,14,0.55), transparent);
    pointer-events: none;
  }
  #status {
    display: inline-flex; align-items: center; gap: 9px;
    padding: 7px 14px; border-radius: 999px;
    background: var(--ink); border: 1px solid rgba(255,255,255,0.09);
    backdrop-filter: blur(14px) saturate(1.3); -webkit-backdrop-filter: blur(14px) saturate(1.3);
    box-shadow: 0 6px 20px rgba(0,0,0,0.4); pointer-events: auto;
  }
  #dot { width: 8px; height: 8px; border-radius: 50%; background: var(--fg-faint); flex-shrink: 0; }
  #dot.online   { background: var(--accent-warm); }
  #dot.thinking { background: var(--accent);       animation: blink 1.2s ease-in-out infinite; }
  #dot.dreaming { background: var(--accent-dream); animation: blink 2.4s ease-in-out infinite; }
  #dot.offline  { background: var(--fg-faint); }
  @keyframes blink { 0%,100% { opacity: 0.35; } 50% { opacity: 1; } }
  #status .name { font-weight: 700; letter-spacing: 0.02em; }
  #status .doing { color: var(--fg-dim); font-size: 13px; }
  #spacer { flex: 1; }
  .chip {
    pointer-events: auto; cursor: pointer;
    padding: 7px 12px; border-radius: 999px; font-size: 12.5px; font-weight: 600;
    color: var(--fg); background: var(--ink); border: 1px solid rgba(255,255,255,0.09);
    backdrop-filter: blur(14px); -webkit-backdrop-filter: blur(14px);
    transition: background 160ms, transform 160ms var(--spring);
  }
  .chip:hover { background: rgba(106,212,255,0.16); transform: translateY(-1px); }

  /* Desire ticker — what she's currently pursuing, bottom center. */
  #desire {
    position: fixed; left: 50%; bottom: 18px; transform: translateX(-50%);
    max-width: min(86vw, 620px); z-index: 20;
    display: none; align-items: center; gap: 8px;
    padding: 9px 16px; border-radius: 14px;
    background: var(--ink); border: 1px solid rgba(255,255,255,0.08);
    backdrop-filter: blur(14px); -webkit-backdrop-filter: blur(14px);
    box-shadow: 0 8px 24px rgba(0,0,0,0.45);
    font-size: 13px; color: var(--fg-dim);
  }
  body.has-desire #desire { display: flex; }
  #desire .star { color: var(--accent-warm); flex-shrink: 0; }
  #desire .txt { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

  /* Reading modal for the letter. */
  #reader {
    position: fixed; inset: 0; z-index: 40; display: none;
    align-items: center; justify-content: center; padding: 24px;
    background: rgba(4,6,14,0.6); backdrop-filter: blur(6px);
  }
  #reader.open { display: flex; }
  #reader .card {
    max-width: 460px; width: 100%; max-height: 70vh; overflow-y: auto;
    background: linear-gradient(180deg, #fbf3df, #f3e6c8); color: #2a2010;
    border-radius: 16px; padding: 22px 24px;
    box-shadow: 0 30px 80px rgba(0,0,0,0.6);
    font-size: 14.5px; line-height: 1.65; white-space: pre-wrap;
  }
  #reader .card h3 {
    margin: 0 0 12px; font-size: 12px; letter-spacing: 0.14em; text-transform: uppercase;
    color: #9a7a30;
  }
  #reader .card .close {
    margin-top: 16px; display: inline-block; cursor: pointer;
    padding: 7px 14px; border-radius: 10px; font-weight: 600; font-size: 13px;
    background: #2a2010; color: #fbf3df;
  }

  /* Offline curtain. */
  #offline {
    position: fixed; inset: 0; z-index: 30; display: none;
    flex-direction: column; align-items: center; justify-content: center; gap: 14px;
    background: rgba(4,6,14,0.72); backdrop-filter: blur(4px);
    color: var(--fg-dim);
  }
  body.offline #offline { display: flex; }
  body.offline #stage { filter: grayscale(0.7) brightness(0.5); transition: filter 800ms; }
  #offline .z { font-size: 40px; opacity: 0.7; }

  @media (prefers-reduced-motion: reduce) {
    #lisa, #zzz span, #glow-monitor, .drop, .flake, .fly, #letter .halo { animation: none !important; }
  }
</style>
</head>
<body>
  <div id="backdrop"></div>
  <div id="stage">
    <div class="bg" id="bg-day"></div>
    <div class="bg" id="bg-dusk"></div>
    <div class="bg" id="bg-night"></div>
    <div id="glow-monitor"></div>
    <div id="weather"></div>
    <div id="lighting"></div>
    <div id="lisa-wrap">
      <div id="shadow"></div>
      <div id="lisa" role="img" aria-label="Lisa"></div>
      <div id="zzz"><span>Z</span><span>Z</span><span>Z</span></div>
    </div>
    <div id="letter" role="button" aria-label="Read Lisa's note">
      <div class="halo"></div><div class="env"></div>
    </div>
    <div id="vignette"></div>
  </div>

  <div id="topbar">
    <div id="status">
      <span id="dot"></span>
      <span class="name">Lisa</span>
      <span class="doing" id="doing">at home</span>
    </div>
    <div id="spacer"></div>
    <div class="chip" id="chip-chat">Talk to her ▸</div>
  </div>

  <div id="desire"><span class="star">✦</span><span class="txt" id="desire-txt"></span></div>

  <div id="reader"><div class="card">
    <h3>★ while you were away</h3>
    <div id="reader-text"></div>
    <span class="close" id="reader-close">Close</span>
  </div></div>

  <div id="offline">
    <div class="z">☾</div>
    <div>Lisa is asleep</div>
    <div class="chip" id="chip-wake">Wake her — run <code>lisa serve --web</code></div>
  </div>

<script>
(() => {
  var $ = function (id) { return document.getElementById(id); };
  var body = document.body;
  var lisa = $('lisa'), doing = $('doing'), dot = $('dot');
  var stage = $('stage');

  var state = {
    mood: 'neutral', online: false, thinking: false, dreaming: false,
    unread: false, idleText: '', desire: null, tod: null,
  };

  // ── Mood → a short "what she's doing" caption. Keeps the room honest:
  // the caption reflects her real current sprite, nothing invented. ───────
  var CAPTION = {
    'working-coding': 'coding', 'working-debugging': 'debugging',
    'working-typing': 'writing', 'working-writing': 'writing',
    'working-research': 'reading up', 'studying': 'studying',
    'reading-book': 'reading', 'thinking-pose': 'thinking', 'thoughtful': 'thinking',
    'gaming': 'gaming', 'watching-movie': 'watching a movie', 'watching-anime': 'watching anime',
    'phone-call': 'on a call', 'video-call': 'on a call', 'livestreaming': 'streaming',
    'napping': 'napping', 'sleeping': 'asleep', 'cooking': 'cooking', 'dancing': 'dancing',
    'happy': 'in a good mood', 'laughing': 'laughing', 'giggling': 'amused',
    'sad': 'a little down', 'crying': 'upset', 'angry': 'frustrated', 'annoyed': 'a bit annoyed',
    'excited': 'excited', 'loving': 'happy you\\'re here', 'grateful': 'grateful',
    'sleepy': 'sleepy', 'shy': 'a little shy', 'surprised': 'surprised', 'neutral': 'at home',
  };
  // Weather-flavored moods → particle mode.
  function weatherOf(slug) {
    if (!slug) return null;
    if (/rain|storm/.test(slug)) return 'rain';
    if (/snow|winter-cold/.test(slug)) return 'snow';
    return null;
  }

  // ── Time of day → which background shows. Reve/dreaming forces night mood. ─
  function timeOfDay() {
    var h = new Date().getHours();
    if (state.dreaming) return 'night';
    if (h >= 7 && h < 17) return 'day';
    if ((h >= 17 && h < 20) || (h >= 5 && h < 7)) return 'dusk';
    return 'night';
  }
  function applyTOD() {
    var tod = timeOfDay();
    if (tod === state.tod) return;
    state.tod = tod;
    ['day', 'dusk', 'night'].forEach(function (t) {
      $('bg-' + t).classList.toggle('show', t === tod);
    });
    $('backdrop').style.backgroundImage = "url('/assets/room/room-" + tod + ".png')";
    // Warmth of the lighting wash by time of day.
    var light = $('lighting');
    if (!body.classList.contains('dreaming')) {
      if (tod === 'night') { light.style.opacity = '0.5'; light.style.background = 'radial-gradient(120% 90% at 32% 62%, rgba(255,180,90,0.20) 12%, rgba(3,5,14,0.62) 100%)'; }
      else if (tod === 'dusk') { light.style.opacity = '0.35'; light.style.background = 'radial-gradient(120% 90% at 50% 45%, rgba(255,150,120,0.14) 20%, rgba(20,12,30,0.45) 100%)'; }
      else { light.style.opacity = '0.16'; light.style.background = 'radial-gradient(120% 90% at 60% 30%, rgba(255,244,210,0.14) 20%, rgba(10,14,26,0.3) 100%)'; }
    }
    rebuildAmbient();
  }

  // ── Full-body pose. The sprite is pose-based (stand / sit / sleep); facial
  // mood nuance is carried by the caption + lighting, not 114 faces. ─────────
  var lisaWrap = $('lisa-wrap');
  function poseFor() {
    if (state.dreaming) return 'sleep';
    var m = state.mood || '';
    if (/sleep|nap/.test(m)) return 'sleep';
    if (/working|studying|research|typing|writing|reading|gaming|watching/.test(m)) return 'sit';
    return 'stand';
  }
  function applyPose() {
    var p = poseFor();
    lisaWrap.classList.toggle('sit', p === 'sit');
    lisaWrap.classList.toggle('sleep', p === 'sleep');
  }
  function setMood(slug) {
    if (!slug) return;
    state.mood = slug;
    applyPose();
    refreshCaption();
    refreshWeather();
  }
  // Blink: briefly flip to the eyes-closed frame, only while standing idle.
  function scheduleBlink() {
    setTimeout(function () {
      if (poseFor() === 'stand' && !document.hidden) {
        lisa.classList.add('blink');
        setTimeout(function () { lisa.classList.remove('blink'); }, 130);
      }
      scheduleBlink();
    }, 2600 + Math.random() * 3400);
  }
  function refreshCaption() {
    if (!state.online) { doing.textContent = 'away'; return; }
    if (state.dreaming) { doing.textContent = 'dreaming…'; return; }
    if (state.thinking) { doing.textContent = 'thinking…'; return; }
    doing.textContent = CAPTION[state.mood] || 'at home';
  }
  function refreshDot() {
    dot.className = '';
    if (!state.online) dot.classList.add('offline');
    else if (state.thinking) dot.classList.add('thinking');
    else if (state.dreaming) dot.classList.add('dreaming');
    else dot.classList.add('online');
  }

  // ── Ambient particles (weather + night fireflies) ──────────────────────
  var weather = $('weather');
  function clearAmbient() { while (weather.firstChild) weather.removeChild(weather.firstChild); }
  function refreshWeather() { rebuildAmbient(); }
  function rebuildAmbient() {
    clearAmbient();
    var w = weatherOf(state.mood);
    if (w === 'rain') {
      for (var i = 0; i < 70; i++) {
        var d = document.createElement('div'); d.className = 'drop';
        d.style.left = (Math.random() * 100) + '%';
        d.style.animationDuration = (0.5 + Math.random() * 0.5) + 's';
        d.style.animationDelay = (Math.random() * 2) + 's';
        d.style.opacity = (0.3 + Math.random() * 0.5);
        weather.appendChild(d);
      }
    } else if (w === 'snow') {
      for (var j = 0; j < 60; j++) {
        var f = document.createElement('div'); f.className = 'flake';
        var s = 2 + Math.random() * 4;
        f.style.width = s + 'px'; f.style.height = s + 'px';
        f.style.left = (Math.random() * 100) + '%';
        f.style.animationDuration = (5 + Math.random() * 6) + 's';
        f.style.animationDelay = (Math.random() * 6) + 's';
        weather.appendChild(f);
      }
    } else if (state.tod === 'night' && !state.dreaming) {
      // Fireflies only at night for a touch of life.
      for (var k = 0; k < 12; k++) {
        var fly = document.createElement('div'); fly.className = 'fly';
        fly.style.left = (10 + Math.random() * 80) + '%';
        fly.style.top = (30 + Math.random() * 55) + '%';
        fly.style.animationDuration = (2.5 + Math.random() * 3) + 's';
        fly.style.animationDelay = (Math.random() * 3) + 's';
        weather.appendChild(fly);
      }
    }
  }

  // ── Desire + letter ────────────────────────────────────────────────────
  function refreshDesire() {
    body.classList.toggle('has-desire', !!state.desire && state.online && !state.dreaming);
    if (state.desire) $('desire-txt').textContent = 'she wants to ' + String(state.desire).replace(/^to\\s+/i, '');
  }
  function refreshLetter() { body.classList.toggle('unread', state.unread); }

  $('letter').addEventListener('click', function () {
    $('reader-text').textContent = state.idleText || '(she left before writing anything)';
    $('reader').classList.add('open');
  });
  $('reader-close').addEventListener('click', function () { $('reader').classList.remove('open'); });
  $('reader').addEventListener('click', function (e) { if (e.target === $('reader')) $('reader').classList.remove('open'); });

  function dismissUnread() {
    fetch('/api/island/dismiss-unread', { method: 'POST' }).catch(function () {});
    state.unread = false; state.idleText = ''; refreshLetter();
  }
  // Reading the letter marks it read.
  $('reader-close').addEventListener('click', dismissUnread);

  // ── Open the full chat (native bridge if inside a Lisa app window). ──────
  function openChat() {
    if (window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.island) {
      window.webkit.messageHandlers.island.postMessage({ type: 'open_full_gui', prefill: '' });
    } else { window.open('/', '_blank'); }
  }
  $('chip-chat').addEventListener('click', openChat);
  lisa.addEventListener('click', openChat);

  // ── Gentle parallax: bg drifts opposite the cursor, Lisa drifts less. ────
  var px = 0, py = 0, tx = 0, ty = 0;
  window.addEventListener('mousemove', function (e) {
    tx = (e.clientX / window.innerWidth - 0.5);
    ty = (e.clientY / window.innerHeight - 0.5);
  });
  function raf() {
    px += (tx - px) * 0.06; py += (ty - py) * 0.06;
    stage.style.transform = 'translateX(-50%) translate(' + (-px * 14) + 'px,' + (-py * 8) + 'px)';
    requestAnimationFrame(raf);
  }
  requestAnimationFrame(raf);

  // ── Server state: ping snapshot + SSE pulses (shared with the Island). ───
  function applyPing(j) {
    state.online = !!j.online;
    state.unread = !!j.has_unread_idle_message;
    state.idleText = j.last_idle_message_text || '';
    state.desire = j.current_desire || null;
    if (j.mood) setMood(j.mood);
    body.classList.toggle('offline', !state.online);
    refreshDot(); refreshCaption(); refreshDesire(); refreshLetter();
  }
  function pollPing() {
    fetch('/api/island/ping', { cache: 'no-store' })
      .then(function (r) { if (!r.ok) throw 0; return r.json(); })
      .then(applyPing)
      .catch(function () { state.online = false; body.classList.add('offline'); refreshDot(); refreshCaption(); });
  }

  function subscribe() {
    var es = new EventSource('/events');
    es.addEventListener('open', function () { state.online = true; body.classList.remove('offline'); refreshDot(); });
    es.addEventListener('message', function (ev) {
      var m; try { m = JSON.parse(ev.data); } catch (e) { return; }
      switch (m.type) {
        case 'mood': setMood(m.slug); break;
        case 'chat_start': state.thinking = true; body.classList.add('thinking'); refreshDot(); refreshCaption(); break;
        case 'chat_end':   state.thinking = false; body.classList.remove('thinking'); refreshDot(); refreshCaption(); break;
        case 'idle_start': state.dreaming = true; body.classList.add('dreaming'); applyTOD(); applyPose(); refreshDot(); refreshCaption(); refreshDesire(); break;
        case 'idle_done':
        case 'idle_error': state.dreaming = false; body.classList.remove('dreaming'); applyTOD(); applyPose(); refreshDot(); refreshCaption(); refreshDesire(); break;
        case 'idle_message':
          state.dreaming = false; body.classList.remove('dreaming'); applyTOD(); applyPose();
          state.unread = true; state.idleText = (m.text || '').slice(0, 4000);
          refreshDot(); refreshCaption(); refreshLetter();
          document.body.animate([{ filter: 'brightness(1.25)' }, { filter: 'brightness(1)' }], { duration: 700 });
          break;
      }
    });
    es.addEventListener('error', function () { state.online = false; body.classList.add('offline'); refreshDot(); });
  }

  // ── Boot ────────────────────────────────────────────────────────────────
  setMood('neutral');
  applyTOD();
  applyPose();
  scheduleBlink();
  pollPing();
  subscribe();
  setInterval(pollPing, 30000);
  setInterval(applyTOD, 60000);   // re-check time-of-day each minute
})();
</script>
</body>
</html>
`;

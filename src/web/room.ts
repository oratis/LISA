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
 * pose sprites for sitting (lisa-sit.png) and sleeping curled up in the armchair
 * (lisa-sleep-sofa.png), swapped by mood/state. Sprites were generated via the "anchor → keyframes → chroma-key
 * + foot-anchor" pipeline (cf. Ludo.ai / chongdashu/ai-game-spritesheets):
 * gemini-2.5-flash-image made a full-body anchor from her existing face sprite,
 * pose/blink frames were edited from it for consistency, then keyed + normalized.
 *
 * Data sources (all pre-existing, shared with the Island):
 *   - SSE  GET /events            → mood / chat_start / chat_end / idle_* pulses
 *   - poll GET /api/island/ping   → { online, mood, current_desire, unread, ... }
 *   - POST /api/island/dismiss-unread → mark the "letter" read
 */

import { renderMarkdown, MD_RENDER_CSS } from "./md-render.js";

export const ROOM_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
<title>Lisa · room</title>
<link rel="manifest" href="/manifest.webmanifest">
<style>
${MD_RENDER_CSS}
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
  /* .bg layer images are set in JS (renderBg) from the chosen room theme. */

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
    position: absolute; left: 49.7%; bottom: 7.5%;
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

  /* Sitting with her laptop — coding / reading / focused moods. contain +
     bottom-anchor keeps her slim proportions (no stretch) whatever the crop. */
  #lisa-wrap.sit #lisa {
    background-image: url('/assets/room/lisa-sit.png');
    background-size: contain; background-position: center bottom; background-repeat: no-repeat;
    width: 30vmin; height: 34vmin; animation-duration: 5.8s;
  }
  #lisa-wrap.sit #lisa.blink { background-position: center bottom; }
  #lisa-wrap.sit #shadow { width: 20vmin; }
  /* Sleeping — curled up napping in the armchair (Reve / napping). She glides
     over to the sofa on the right (the wrap's left/bottom transition) and curls
     up; no floor shadow since she's up on the cushion, not the rug. */
  #lisa-wrap.sleep { left: 69.5%; bottom: 31.5%; }
  #lisa-wrap.sleep #lisa {
    background-image: url('/assets/room/lisa-sleep-sofa.png');
    background-size: contain; background-position: center bottom; background-repeat: no-repeat;
    width: 17vmin; height: 26vmin; animation-duration: 6.6s;
  }
  #lisa-wrap.sleep #lisa.blink { background-position: center bottom; }
  #lisa-wrap.sleep #shadow { opacity: 0; }

  /* Presence beat (Phase B) — she looks up and meets your eyes. Single frame,
     swapped in for ~1.6s when you open the room / focus the window / hover. */
  #lisa.lookup {
    background-image: url('/assets/room/lisa-lookup.png');
    background-size: 100% 100%; background-position: 0 0;
    filter: drop-shadow(0 0 14px rgba(106,212,255,0.45)) drop-shadow(0 10px 10px rgba(0,0,0,0.32));
  }
  /* Ambient activities at the standing spot (Phase C) — single-frame poses she
     drifts through on her own when idle (reading / tea / music / stretch). */
  #lisa-wrap.act-read    #lisa { background-image: url('/assets/room/lisa-read.png');    background-size: 100% 100%; background-position: 0 0; }
  #lisa-wrap.act-tea     #lisa { background-image: url('/assets/room/lisa-tea.png');     background-size: 100% 100%; background-position: 0 0; }
  #lisa-wrap.act-stretch #lisa { background-image: url('/assets/room/lisa-stretch.png'); background-size: 100% 100%; background-position: 0 0; }
  #lisa-wrap.act-listen  #lisa { background-image: url('/assets/room/lisa-listen.png');  background-size: 100% 100%; background-position: 0 0; }
  #lisa-wrap.act-window  #lisa { background-image: url('/assets/room/lisa-window.png');  background-size: 100% 100%; background-position: 0 0; }
  /* Night (Phase D): she changes into pajamas for the evening — plain standing
     idle only; activities keep the hoodie. Single frame, so no blink. */
  #lisa-wrap.pjs #lisa { background-image: url('/assets/room/lisa-pajamas.png'); background-size: 100% 100%; background-position: 0 0; }
  #lisa-wrap.pjs #lisa.blink { background-position: 0 0; }

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
  #zzz { position: absolute; left: 73%; bottom: 60%; pointer-events: none; opacity: 0; transition: opacity 600ms; }
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
  /* Count badge when several ★ notes have piled up on the desk (Phase D). */
  #letter .count {
    position: absolute; top: -34%; right: -34%;
    min-width: 1.5em; height: 1.5em; padding: 0 0.32em; box-sizing: border-box;
    border-radius: 999px; background: var(--accent-warm); color: #3a2a00;
    font-size: min(1.7vmin, 15px); font-weight: 800; line-height: 1;
    display: none; align-items: center; justify-content: center;
    box-shadow: 0 1px 5px rgba(0,0,0,0.45);
  }
  body.multi #letter .count { display: flex; }

  /* Phase D: the bookshelf is a clickable hotspot — "what she's been thinking
     about" surfaces her REAL current desire (object-as-interface, in-client). */
  #shelf {
    position: absolute; left: 17%; top: 21%; width: 21%; height: 37%;
    cursor: pointer; pointer-events: auto; border-radius: 8px;
    transition: background 220ms ease, box-shadow 220ms ease;
  }
  #shelf:hover {
    background: radial-gradient(60% 50% at 50% 50%, rgba(106,212,255,0.12), transparent 72%);
    box-shadow: 0 0 24px rgba(106,212,255,0.10) inset;
  }
  #recall {
    position: fixed; inset: 0; z-index: 40; display: none;
    align-items: center; justify-content: center; padding: 24px;
    background: rgba(4,6,14,0.6); backdrop-filter: blur(6px);
  }
  #recall.open { display: flex; }
  #recall .rcard {
    max-width: 420px; width: 100%;
    background: var(--ink); border: 1px solid rgba(255,255,255,0.10);
    border-radius: 16px; padding: 22px 24px;
    box-shadow: 0 30px 80px rgba(0,0,0,0.6);
    font-size: 14.5px; line-height: 1.6; color: var(--fg);
  }
  #recall .rcard h3 {
    margin: 0 0 12px; font-size: 12px; letter-spacing: 0.14em; text-transform: uppercase;
    color: var(--accent);
  }
  #recall .rclose {
    margin-top: 16px; display: inline-block; cursor: pointer;
    padding: 7px 14px; border-radius: 10px; font-weight: 600; font-size: 13px;
    background: rgba(106,212,255,0.16); color: var(--fg);
  }

  /* ── Gramophone — a clickable prop that opens the music player. ── */
  #gramophone {
    position: absolute; left: 85%; bottom: 7.5%;
    width: 14vmin; height: 21vmin;            /* sprite is 506:770 ≈ 0.657 */
    background: url('/assets/room/gramophone.png') no-repeat center bottom / contain;
    image-rendering: pixelated;
    cursor: pointer; pointer-events: auto;
    transform-origin: 50% 100%;
    filter: drop-shadow(0 6px 8px rgba(0,0,0,0.4));
    transition: transform 300ms var(--spring), filter 400ms ease;
  }
  #gramophone:hover, #gramophone:focus-visible {
    transform: translateY(-2%) scale(1.03);
    filter: drop-shadow(0 0 12px rgba(255,208,102,0.55)) drop-shadow(0 8px 8px rgba(0,0,0,0.4));
    outline: none;
  }
  body.music #gramophone {
    filter: drop-shadow(0 0 14px rgba(255,208,102,0.5)) drop-shadow(0 6px 8px rgba(0,0,0,0.4));
    animation: gramo-bob 3.2s ease-in-out infinite;
  }
  @keyframes gramo-bob { 0%,100% { transform: translateY(0); } 50% { transform: translateY(-1.4%); } }
  /* musical-note motes drifting from the horn while music plays */
  #notes { position: absolute; left: 87%; bottom: 24%; pointer-events: none; opacity: 0; transition: opacity 500ms; }
  body.music #notes { opacity: 1; }
  #notes span {
    position: absolute; color: var(--accent-warm); font-weight: 700;
    text-shadow: 0 0 6px rgba(255,208,102,0.6); opacity: 0;
    animation: note-rise 3.6s ease-in infinite;
  }
  #notes span:nth-child(1) { left: 0; font-size: min(3vmin,26px); }
  #notes span:nth-child(2) { left: 2.4vmin; animation-delay: 1.2s; font-size: min(2.2vmin,20px); }
  #notes span:nth-child(3) { left: -1.8vmin; animation-delay: 2.4s; font-size: min(2.6vmin,22px); }
  @keyframes note-rise {
    0%   { transform: translateY(0) rotate(-10deg); opacity: 0; }
    18%  { opacity: 0.95; }
    100% { transform: translateY(-9vmin) rotate(12deg); opacity: 0; }
  }

  /* ── Music player overlay (mirrors #recall/#reader; slides up from bottom). ── */
  #player {
    position: fixed; inset: 0; z-index: 40; display: none;
    align-items: flex-end; justify-content: center;
    background: rgba(4,6,14,0.55); backdrop-filter: blur(6px); -webkit-backdrop-filter: blur(6px);
  }
  #player.open { display: flex; }
  #player .pcard {
    width: min(92vw, 460px); max-height: 82vh; margin-bottom: max(18px, 5vh);
    background: rgba(15,19,32,0.97); border: 1px solid rgba(255,255,255,0.10);
    border-radius: 20px; padding: 18px 20px 16px;
    box-shadow: 0 24px 70px rgba(0,0,0,0.6);
    display: flex; flex-direction: column; gap: 12px; color: var(--fg);
    animation: pslide 320ms var(--spring);
  }
  @keyframes pslide { from { transform: translateY(24px); opacity: 0.4; } to { transform: none; opacity: 1; } }
  #player .phead { display: flex; align-items: center; gap: 8px; }
  #player .phead h3 { margin: 0; flex: 1; font-size: 12px; letter-spacing: 0.14em; text-transform: uppercase; color: var(--accent); }
  #player .pclose { cursor: pointer; font-size: 18px; line-height: 1; color: var(--fg-faint); padding: 2px 6px; border-radius: 8px; }
  #player .pclose:hover { color: var(--fg); background: rgba(255,255,255,0.08); }
  .np { min-height: 2.4em; }
  .np-title { font-weight: 700; font-size: 16px; }
  .np-mood { color: var(--fg-faint); font-size: 12px; margin-top: 2px; }
  .seekwrap { display: flex; flex-direction: column; gap: 3px; }
  #player input[type=range] { -webkit-appearance: none; appearance: none; width: 100%; height: 4px; border-radius: 4px; background: rgba(255,255,255,0.16); cursor: pointer; }
  #player input[type=range]::-webkit-slider-thumb { -webkit-appearance: none; width: 13px; height: 13px; border-radius: 50%; background: var(--accent); box-shadow: 0 0 8px rgba(106,212,255,0.6); }
  .times { display: flex; justify-content: space-between; font-size: 11px; color: var(--fg-faint); font-variant-numeric: tabular-nums; }
  .transport { display: flex; align-items: center; justify-content: center; gap: 12px; }
  .tbtn { border: none; background: rgba(255,255,255,0.06); color: var(--fg); width: 40px; height: 40px; border-radius: 50%; font-size: 15px; cursor: pointer; display: grid; place-items: center; transition: background 160ms, transform 160ms; }
  .tbtn:hover { background: rgba(255,255,255,0.14); }
  .tbtn:active { transform: scale(0.92); }
  .tbtn.big { width: 52px; height: 52px; font-size: 20px; background: var(--accent); color: #06121a; }
  .tbtn.on { background: rgba(106,212,255,0.22); color: var(--accent); }
  .volwrap { display: flex; align-items: center; gap: 10px; }
  .volwrap span { cursor: pointer; font-size: 15px; width: 20px; text-align: center; }
  .moods { display: flex; gap: 6px; flex-wrap: wrap; }
  .mchip { font-size: 12px; padding: 4px 10px; border-radius: 999px; background: rgba(255,255,255,0.06); color: var(--fg-dim); cursor: pointer; }
  .mchip.on { background: rgba(106,212,255,0.2); color: var(--accent); }
  .plist { overflow-y: auto; display: flex; flex-direction: column; gap: 1px; max-height: 34vh; margin: 0 -6px; }
  .prow { display: flex; align-items: center; gap: 8px; padding: 8px 10px; border-radius: 10px; cursor: pointer; font-size: 13.5px; }
  .prow:hover { background: rgba(255,255,255,0.06); }
  .prow.active { background: rgba(106,212,255,0.14); color: var(--accent); }
  .prow .pi { width: 14px; font-size: 11px; color: var(--fg-faint); text-align: center; flex-shrink: 0; }
  .prow.active .pi { color: var(--accent); }
  .prow .pt { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .prow .pm { font-size: 10px; color: var(--fg-faint); flex-shrink: 0; }
  .plist .pempty { padding: 14px 10px; font-size: 12.5px; color: var(--fg-faint); line-height: 1.5; }
  .plist .pempty code { background: rgba(255,255,255,0.08); padding: 1px 5px; border-radius: 5px; }
  .license { font-size: 10.5px; color: var(--fg-faint); line-height: 1.4; min-height: 1.3em; }

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
    <div id="letter" role="button" aria-label="Read Lisa's notes">
      <div class="halo"></div><div class="env"></div>
      <div class="count" id="letter-count"></div>
    </div>
    <div id="shelf" role="button" aria-label="What Lisa has been thinking about" title="what she's been thinking about"></div>
    <div id="gramophone" role="button" tabindex="0" aria-label="Put on some music" title="Put on some music"></div>
    <div id="notes" aria-hidden="true"><span>&#9834;</span><span>&#9835;</span><span>&#9833;</span></div>
    <div id="vignette"></div>
  </div>

  <div id="topbar">
    <div id="status">
      <span id="dot"></span>
      <span class="name">Lisa</span>
      <span class="doing" id="doing">at home</span>
    </div>
    <div id="spacer"></div>
    <div class="chip" id="chip-theme" title="Redecorate the room" aria-label="Change room theme">❖</div>
    <div class="chip" id="chip-chat">Talk to her ▸</div>
  </div>

  <div id="desire"><span class="star">✦</span><span class="txt" id="desire-txt"></span></div>

  <div id="reader"><div class="card">
    <h3 id="reader-title">★ while you were away</h3>
    <div id="reader-text" class="md-render"></div>
    <span class="close" id="reader-close">Close</span>
  </div></div>

  <div id="recall"><div class="rcard">
    <h3>✦ on her mind</h3>
    <div id="recall-text"></div>
    <span class="rclose" id="recall-close">Close</span>
  </div></div>

  <div id="player"><div class="pcard">
    <div class="phead"><h3>♪ music</h3><div class="pclose" id="player-close" role="button" aria-label="Close">✕</div></div>
    <div class="np"><div class="np-title" id="np-title">—</div><div class="np-mood" id="np-mood"></div></div>
    <div class="seekwrap">
      <input type="range" id="seek" min="0" max="1000" value="0" step="1" aria-label="Seek">
      <div class="times"><span id="t-cur">0:00</span><span id="t-tot">0:00</span></div>
    </div>
    <div class="transport">
      <button class="tbtn" id="btn-shuffle" aria-label="Shuffle" title="Shuffle">🔀</button>
      <button class="tbtn" id="btn-prev" aria-label="Previous" title="Previous">⏮</button>
      <button class="tbtn big" id="btn-play" aria-label="Play or pause" title="Play / Pause">▶</button>
      <button class="tbtn" id="btn-next" aria-label="Next" title="Next">⏭</button>
      <button class="tbtn" id="btn-repeat" aria-label="Repeat" title="Repeat">🔁</button>
    </div>
    <div class="volwrap"><span id="btn-mute" role="button" aria-label="Mute">🔊</span><input type="range" id="vol" min="0" max="100" value="55" aria-label="Volume"></div>
    <div class="moods" id="moods"></div>
    <div class="plist" id="plist"></div>
    <div class="license" id="np-license"></div>
  </div></div>

  <div id="offline">
    <div class="z">☾</div>
    <div>Lisa is asleep</div>
    <div class="chip" id="chip-wake">Wake her — run <code>lisa serve --web</code></div>
  </div>

<script>
function __name(t){return t}
${renderMarkdown}
(() => {
  var $ = function (id) { return document.getElementById(id); };
  // Localize the reader's "while you were away" title to the UI language.
  (function () {
    var l = (navigator.language || 'en').toLowerCase();
    var t = l.indexOf('zh') === 0 ? '你不在的时候' : l.indexOf('ja') === 0 ? '不在のあいだに' : l.indexOf('ko') === 0 ? '자리를 비운 사이' : 'WHILE YOU WERE AWAY';
    var el = $('reader-title');
    if (el) el.textContent = '★ ' + t;
  })();
  var body = document.body;
  var lisa = $('lisa'), doing = $('doing'), dot = $('dot');
  var stage = $('stage');

  var state = {
    mood: 'neutral', online: false, thinking: false, dreaming: false,
    unread: false, idleText: '', desire: null, tod: null, activity: null,
    letters: [], theme: 'room',
  };
  // Room theme (换景) — persisted; the .bg layer images are built from the prefix.
  var THEMES = ['room', 'room2'];   // asset prefixes under /assets/room/
  try { var _t = localStorage.getItem('lisa-room-theme'); if (_t && THEMES.indexOf(_t) >= 0) state.theme = _t; } catch (e) {}

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
  function bgUrl(t) { return "url('/assets/room/" + state.theme + "-" + t + ".png')"; }
  function renderBg() {
    ['day', 'dusk', 'night'].forEach(function (t) {
      var el = $('bg-' + t);
      el.style.backgroundImage = bgUrl(t);
      el.classList.toggle('show', t === state.tod);
    });
    $('backdrop').style.backgroundImage = bgUrl(state.tod);
  }
  function applyTOD() {
    var tod = timeOfDay();
    if (tod === state.tod) return;
    state.tod = tod;
    renderBg();
    // Warmth of the lighting wash by time of day.
    var light = $('lighting');
    if (!body.classList.contains('dreaming')) {
      if (tod === 'night') { light.style.opacity = '0.5'; light.style.background = 'radial-gradient(120% 90% at 32% 62%, rgba(255,180,90,0.20) 12%, rgba(3,5,14,0.62) 100%)'; }
      else if (tod === 'dusk') { light.style.opacity = '0.35'; light.style.background = 'radial-gradient(120% 90% at 50% 45%, rgba(255,150,120,0.14) 20%, rgba(20,12,30,0.45) 100%)'; }
      else { light.style.opacity = '0.16'; light.style.background = 'radial-gradient(120% 90% at 60% 30%, rgba(255,244,210,0.14) 20%, rgba(10,14,26,0.3) 100%)'; }
    }
    rebuildAmbient();
    applyOutfit();
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
    clearActivityIfBusy();
    applyActivity();
  }

  // ── Phase C: autonomous ambient life. When she's idle-standing (no real work
  // or Reve signal), she drifts through gentle AT-HOME activities on her own —
  // honest "she's home, resting", never fabricated work or a fake mood. When a
  // real signal arrives (work mood / thinking / dreaming) the activity clears. ─
  var ACT = ['read', 'tea', 'listen', 'stretch', 'window'];
  var ACT_CAPTION = { read: 'reading', tea: 'having some tea', listen: 'listening to music', stretch: 'stretching', window: 'gazing out the window' };
  function idleEligible() {
    return state.online && !state.thinking && !state.dreaming && poseFor() === 'stand';
  }
  function applyActivity() {
    ACT.forEach(function (a) { lisaWrap.classList.toggle('act-' + a, state.activity === a); });
    applyOutfit();
  }
  function applyOutfit() {
    // Evening pajamas — plain standing idle at night only (activities keep the hoodie).
    lisaWrap.classList.toggle('pjs', state.tod === 'night' && poseFor() === 'stand' && !state.activity);
  }
  function clearActivityIfBusy() {
    if (state.activity && !idleEligible()) { state.activity = null; applyActivity(); }
  }
  function pickActivity() {
    // time-weighted; null = just stand and rest; avoid immediate repeat.
    var pool = state.tod === 'night' ? ['read', 'tea', 'listen', 'window', null]
             : state.tod === 'dusk'  ? ['tea', 'read', 'window', 'listen', 'stretch']
             :                         ['stretch', 'read', 'window', 'listen', null];
    var pick, tries = 0;
    do { pick = pool[Math.floor(Math.random() * pool.length)]; tries++; } while (pick === state.activity && tries < 5);
    return pick;
  }
  var ambientTimer = null;
  function ambientTick() {
    if (idleEligible()) state.activity = pickActivity();
    else state.activity = null;
    applyActivity(); refreshCaption();
    scheduleAmbient();
  }
  function scheduleAmbient() {
    clearTimeout(ambientTimer);
    ambientTimer = setTimeout(ambientTick, 22000 + Math.random() * 26000);
  }

  // ── Phase B: presence beat — she looks up and meets your eyes (BSide's most
  // praised "aliveness" moment). Fires on room open / window focus / hover,
  // only while she's plainly standing idle. ─────────────────────────────────
  var lookupTimer = null;
  function presenceBeat() {
    if (poseFor() !== 'stand' || state.activity || document.hidden) return;
    lisa.classList.add('lookup');
    clearTimeout(lookupTimer);
    lookupTimer = setTimeout(function () { lisa.classList.remove('lookup'); }, 1600);
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
      // Only the standing idle sheet has a blink frame — never during an
      // activity pose, the look-up beat, or a sit/sleep single-frame image.
      if (poseFor() === 'stand' && !state.activity && !lisa.classList.contains('lookup') && !lisaWrap.classList.contains('pjs') && !document.hidden) {
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
    if (state.activity) { doing.textContent = ACT_CAPTION[state.activity]; return; }
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
  function refreshLetter() {
    var n = state.letters.length;
    state.unread = n > 0;
    body.classList.toggle('unread', n > 0);
    body.classList.toggle('multi', n > 1);
    $('letter-count').textContent = n > 1 ? String(n) : '';
  }

  $('letter').addEventListener('click', function () {
    var notes = state.letters.length ? state.letters : (state.idleText ? [state.idleText] : []);
    // Newest first, gently divided by an <hr> when several have piled up. Notes
    // are Lisa's own Markdown reflections → render them (renderMarkdown injected
    // above), not raw text.
    $('reader-text').innerHTML = renderMarkdown(notes.length
      ? notes.slice().reverse().join('\\n\\n---\\n\\n')
      : '(she left before writing anything)');
    $('reader').classList.add('open');
  });
  $('reader-close').addEventListener('click', function () { $('reader').classList.remove('open'); });
  $('reader').addEventListener('click', function (e) { if (e.target === $('reader')) $('reader').classList.remove('open'); });

  function dismissUnread() {
    fetch('/api/island/dismiss-unread', { method: 'POST' }).catch(function () {});
    state.letters = []; state.unread = false; state.idleText = ''; refreshLetter();
  }
  // Reading the letter marks it read.
  $('reader-close').addEventListener('click', dismissUnread);

  // ── Phase D: bookshelf → recall her REAL current desire (in-client card). ──
  $('shelf').addEventListener('click', function () {
    $('recall-text').textContent = state.desire
      ? ('She\\'s been wanting to ' + String(state.desire).replace(/^to\\s+/i, '').replace(/\\s*$/, ''))
      : 'Nothing pressing on her mind right now — she\\'s just at home.';
    $('recall').classList.add('open');
  });
  function closeRecall() { $('recall').classList.remove('open'); }
  $('recall-close').addEventListener('click', closeRecall);
  $('recall').addEventListener('click', function (e) { if (e.target === $('recall')) closeRecall(); });

  // ── In-client action bridge — NEVER opens a browser. ────────────────────
  // Room usually runs as the #viewRoom iframe inside the main GUI, so the
  // primary path is postMessage → parent GUI (same WKWebView). Falls back to
  // the native bridge for a standalone window, and to a same-tab navigation
  // for a plain browser. window.open is intentionally gone (it spawned a
  // browser window when messageHandlers.island was absent in the iframe).
  function roomAction(action, payload) {
    payload = payload || {};
    // 1) Embedded in the GUI → let the parent handle it in-client.
    if (window.parent && window.parent !== window) {
      try {
        window.parent.postMessage(
          Object.assign({ type: 'lisa-room', action: action }, payload),
          location.origin);
        return;
      } catch (e) { /* cross-origin? fall through */ }
    }
    // 2) Standalone native window with a bridge (island or main 'lisa').
    var mh = window.webkit && window.webkit.messageHandlers;
    var bridge = mh && (mh.island || mh.lisa);
    if (bridge) {
      try { bridge.postMessage({ type: 'open_full_gui', prefill: payload.prefill || '' }); return; } catch (e) {}
    }
    // 3) Plain browser standalone /room → navigate the SAME tab (no new window).
    if (action === 'open-chat') {
      location.assign(payload.prefill ? '/?prefill=' + encodeURIComponent(payload.prefill) : '/');
    }
  }
  function openChat(prefill) { roomAction('open-chat', prefill ? { prefill: prefill } : {}); }
  $('chip-chat').addEventListener('click', function () { openChat(); });
  lisa.addEventListener('click', function () { openChat(); });

  // Redecorate (换景) — cycle the room theme, persisted across sessions.
  function cycleTheme() {
    state.theme = THEMES[(THEMES.indexOf(state.theme) + 1) % THEMES.length];
    try { localStorage.setItem('lisa-room-theme', state.theme); } catch (e) {}
    renderBg();
    document.body.animate([{ opacity: 0.5 }, { opacity: 1 }], { duration: 500 });
  }
  $('chip-theme').addEventListener('click', cycleTheme);

  // ── Gramophone music player ─────────────────────────────────────────────
  // A USER affordance (object-as-interface), not a readout of her state. Audio
  // only ever starts from a tap (the browser autoplay gate). body.music (the
  // gramophone glow + drifting notes) reflects the REAL event that sound is on.
  var pAudio = new Audio();
  pAudio.preload = 'metadata';
  var pTracks = [], pOrder = [], pOrderPos = -1, pSeeking = false, pLoaded = false;
  var pMood = 'all', pShuffle = false, pRepeat = 'all', pTargetVol = 0.55, pMuted = false, pFade = null;
  var PKEY = 'lisa-room-music';
  var MOOD_LABEL = { classical: '古典 · classical', light: '轻音乐 · light', classic: '经典 · classic', mine: '我的 · mine' };

  function pPrefsGet() { try { return JSON.parse(localStorage.getItem(PKEY) || '{}'); } catch (e) { return {}; } }
  function pPrefsSave() {
    try {
      var cur = pTracks[pOrder[pOrderPos]];
      localStorage.setItem(PKEY, JSON.stringify({
        vol: pTargetVol, muted: pMuted, shuffle: pShuffle, repeat: pRepeat, mood: pMood,
        trackId: cur ? cur.id : null, pos: pAudio.currentTime || 0
      }));
    } catch (e) {}
  }
  function fmtTime(s) { s = Math.max(0, Math.floor(s || 0)); var m = Math.floor(s / 60), r = s % 60; return m + ':' + (r < 10 ? '0' : '') + r; }
  function effVol() { return pMuted ? 0 : pTargetVol; }
  function pRamp(to) {
    if (pFade) { clearInterval(pFade); pFade = null; }
    var from = pAudio.volume, steps = 14, i = 0;
    pFade = setInterval(function () {
      i++; pAudio.volume = Math.max(0, Math.min(1, from + (to - from) * i / steps));
      if (i >= steps) { clearInterval(pFade); pFade = null; pAudio.volume = Math.max(0, Math.min(1, to)); }
    }, 35);
  }
  function pBuildOrder(keepId) {
    var view = [];
    for (var i = 0; i < pTracks.length; i++) if (pMood === 'all' || pTracks[i].mood === pMood) view.push(i);
    pOrder = view.slice();
    if (pShuffle) for (var j = pOrder.length - 1; j > 0; j--) { var k = Math.floor(Math.random() * (j + 1)), t = pOrder[j]; pOrder[j] = pOrder[k]; pOrder[k] = t; }
    pOrderPos = -1;
    if (keepId) for (var q = 0; q < pOrder.length; q++) if (pTracks[pOrder[q]].id === keepId) { pOrderPos = q; break; }
  }
  function pMoods() {
    var seen = {}, list = ['all'];
    for (var i = 0; i < pTracks.length; i++) if (!seen[pTracks[i].mood]) { seen[pTracks[i].mood] = 1; list.push(pTracks[i].mood); }
    var box = $('moods'); box.innerHTML = '';
    for (var m = 0; m < list.length; m++) (function (mood) {
      var c = document.createElement('div');
      c.className = 'mchip' + (pMood === mood ? ' on' : '');
      c.textContent = mood === 'all' ? 'all' : (MOOD_LABEL[mood] || mood);
      c.addEventListener('click', function () { pMood = mood; var cur = pTracks[pOrder[pOrderPos]]; pBuildOrder(cur ? cur.id : null); pRenderList(); pMoods(); pPrefsSave(); });
      box.appendChild(c);
    })(list[m]);
  }
  function pRenderList() {
    var box = $('plist'); box.innerHTML = '';
    if (!pOrder.length) {
      box.innerHTML = '<div class="pempty">No tracks here yet. Drop <code>.mp3</code> files into <code>~/.lisa/music/</code> and reopen — they appear as <b>我的 / mine</b>.</div>';
      return;
    }
    for (var i = 0; i < pOrder.length; i++) (function (pos) {
      var tr = pTracks[pOrder[pos]];
      var row = document.createElement('div');
      row.className = 'prow' + (pos === pOrderPos ? ' active' : '');
      row.innerHTML = '<span class="pi"></span><span class="pt"></span><span class="pm"></span>';
      row.querySelector('.pi').textContent = pos === pOrderPos ? '♪' : (pos + 1);
      row.querySelector('.pt').textContent = tr.title;
      row.querySelector('.pm').textContent = (MOOD_LABEL[tr.mood] || tr.mood).split(' ')[0];
      row.addEventListener('click', function () { pPlayAt(pos); });
      box.appendChild(row);
    })(i);
  }
  function pRenderNow() {
    var tr = pTracks[pOrder[pOrderPos]];
    $('np-title').textContent = tr ? tr.title : '—';
    $('np-mood').textContent = tr ? (MOOD_LABEL[tr.mood] || tr.mood) : '';
    $('np-license').textContent = tr && tr.attribution ? (tr.attribution + ' · ' + tr.license) : (tr && tr.license && tr.license !== 'user-provided' ? tr.license : '');
    $('btn-shuffle').className = 'tbtn' + (pShuffle ? ' on' : '');
    $('btn-repeat').className = 'tbtn' + (pRepeat !== 'off' ? ' on' : '');
    $('btn-repeat').textContent = pRepeat === 'one' ? '🔂' : '🔁';
    $('btn-mute').textContent = (pMuted || pTargetVol === 0) ? '🔇' : (pTargetVol < 0.5 ? '🔉' : '🔊');
  }
  function pPlayAt(pos) {
    if (pos < 0 || pos >= pOrder.length) return;
    pOrderPos = pos;
    var tr = pTracks[pOrder[pos]];
    pAudio.src = tr.url; pAudio.load(); pAudio.volume = 0;
    var pr = pAudio.play();
    if (pr && pr.then) pr.then(function () { pRamp(effVol()); }).catch(function () {}); else pRamp(effVol());
    pRenderNow(); pRenderList(); pPrefsSave();
  }
  function pToggle() {
    if (pOrderPos < 0) { if (pOrder.length) pPlayAt(0); return; }
    if (pAudio.paused) { var pr = pAudio.play(); if (pr && pr.then) pr.then(function () { pRamp(effVol()); }).catch(function () {}); else pRamp(effVol()); }
    else { pRamp(0); setTimeout(function () { if (pAudio.volume < 0.03) pAudio.pause(); }, 540); }
  }
  function pNext(auto) {
    if (!pOrder.length) return;
    if (pOrderPos + 1 < pOrder.length) pPlayAt(pOrderPos + 1);
    else if (pRepeat !== 'off' || !auto) pPlayAt(0);
    else { pRamp(0); setTimeout(function () { pAudio.pause(); }, 400); }
  }
  function pPrev() {
    if (!pOrder.length) return;
    if (pAudio.currentTime > 3) { pAudio.currentTime = 0; return; }
    pPlayAt(pOrderPos - 1 >= 0 ? pOrderPos - 1 : pOrder.length - 1);
  }
  pAudio.addEventListener('play', function () { document.body.classList.add('music'); $('btn-play').textContent = '⏸'; });
  pAudio.addEventListener('pause', function () { document.body.classList.remove('music'); $('btn-play').textContent = '▶'; pPrefsSave(); });
  pAudio.addEventListener('ended', function () { if (pRepeat === 'one') pPlayAt(pOrderPos); else pNext(true); });
  pAudio.addEventListener('timeupdate', function () {
    var d = pAudio.duration || 0;
    $('t-cur').textContent = fmtTime(pAudio.currentTime);
    $('t-tot').textContent = fmtTime(d);
    if (d && !pSeeking) $('seek').value = String(Math.round(pAudio.currentTime / d * 1000));
  });
  $('seek').addEventListener('input', function () { pSeeking = true; });
  $('seek').addEventListener('change', function () { var d = pAudio.duration || 0; if (d) pAudio.currentTime = (+$('seek').value) / 1000 * d; pSeeking = false; });
  $('vol').addEventListener('input', function () { pTargetVol = (+$('vol').value) / 100; pMuted = false; if (!pAudio.paused) pAudio.volume = effVol(); pRenderNow(); pPrefsSave(); });
  $('btn-mute').addEventListener('click', function () { pMuted = !pMuted; if (!pAudio.paused) pRamp(effVol()); pRenderNow(); pPrefsSave(); });
  $('btn-play').addEventListener('click', pToggle);
  $('btn-next').addEventListener('click', function () { pNext(false); });
  $('btn-prev').addEventListener('click', pPrev);
  $('btn-shuffle').addEventListener('click', function () { pShuffle = !pShuffle; var cur = pTracks[pOrder[pOrderPos]]; pBuildOrder(cur ? cur.id : null); pRenderNow(); pRenderList(); pPrefsSave(); });
  $('btn-repeat').addEventListener('click', function () { pRepeat = pRepeat === 'off' ? 'all' : (pRepeat === 'all' ? 'one' : 'off'); pRenderNow(); pPrefsSave(); });
  function pApplyPrefs() {
    var pr = pPrefsGet();
    if (typeof pr.vol === 'number') pTargetVol = pr.vol;
    pMuted = !!pr.muted; pShuffle = !!pr.shuffle;
    if (pr.repeat === 'off' || pr.repeat === 'all' || pr.repeat === 'one') pRepeat = pr.repeat;
    if (pr.mood) pMood = pr.mood;
    $('vol').value = String(Math.round(pTargetVol * 100));
    return pr;
  }
  function pEnsureLoaded(cb) {
    if (pLoaded) { if (cb) cb(); return; }
    var saved = pApplyPrefs();
    fetch('/api/room/music').then(function (r) { return r.json(); }).then(function (data) {
      pTracks = Array.isArray(data) ? data : []; pLoaded = true;
      pBuildOrder(saved.trackId || null); pMoods(); pRenderList(); pRenderNow();
      if (pOrderPos >= 0) {
        var tr = pTracks[pOrder[pOrderPos]];
        pAudio.src = tr.url; pAudio.volume = 0;
        if (saved.pos) pAudio.addEventListener('loadedmetadata', function once() { pAudio.removeEventListener('loadedmetadata', once); try { pAudio.currentTime = saved.pos; } catch (e) {} });
      }
      if (cb) cb();
    }).catch(function () { pLoaded = true; pTracks = []; pBuildOrder(null); pMoods(); pRenderList(); if (cb) cb(); });
  }
  function openPlayer() { pEnsureLoaded(); $('player').classList.add('open'); }
  function closePlayer() { $('player').classList.remove('open'); }
  $('gramophone').addEventListener('click', openPlayer);
  $('gramophone').addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openPlayer(); } });
  $('player-close').addEventListener('click', closePlayer);
  $('player').addEventListener('click', function (e) { if (e.target === $('player')) closePlayer(); });

  // ── Gentle parallax: bg drifts opposite the cursor, Lisa drifts less. ────
  var px = 0, py = 0, tx = 0, ty = 0;
  window.addEventListener('mousemove', function (e) {
    tx = (e.clientX / window.innerWidth - 0.5);
    ty = (e.clientY / window.innerHeight - 0.5);
  });
  function raf() {
    requestAnimationFrame(raf);
    // Don't burn frames or touch layout while the room isn't visible (it runs
    // as a hidden iframe when you're on another GUI view, or when backgrounded).
    if (document.hidden) return;
    px += (tx - px) * 0.06; py += (ty - py) * 0.06;
    stage.style.transform = 'translateX(-50%) translate(' + (-px * 14) + 'px,' + (-py * 8) + 'px)';
  }
  requestAnimationFrame(raf);

  // ── Server state: ping snapshot + SSE pulses (shared with the Island). ───
  function applyPing(j) {
    state.online = !!j.online;
    state.idleText = j.last_idle_message_text || '';
    state.desire = j.current_desire || null;
    // Seed the desk pile from the server's latest unread note once; live
    // idle_message events then accumulate on top within the session.
    if (j.has_unread_idle_message && state.idleText && state.letters.length === 0) {
      state.letters = [state.idleText];
    } else if (!j.has_unread_idle_message && state.letters.length <= 1) {
      state.letters = [];   // server cleared it and we didn't pile up live ones
    }
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
        case 'chat_start': state.thinking = true; body.classList.add('thinking'); clearActivityIfBusy(); refreshDot(); refreshCaption(); break;
        case 'chat_end':   state.thinking = false; body.classList.remove('thinking'); refreshDot(); refreshCaption(); break;
        case 'idle_start': state.dreaming = true; body.classList.add('dreaming'); applyTOD(); applyPose(); refreshDot(); refreshCaption(); refreshDesire(); break;
        case 'idle_done':
        case 'idle_error': state.dreaming = false; body.classList.remove('dreaming'); applyTOD(); applyPose(); refreshDot(); refreshCaption(); refreshDesire(); break;
        case 'idle_message':
          state.dreaming = false; body.classList.remove('dreaming'); applyTOD(); applyPose();
          var _txt = (m.text || '').slice(0, 4000);
          if (_txt) state.letters.push(_txt);
          if (state.letters.length > 12) state.letters = state.letters.slice(-12);  // cap the desk pile
          state.idleText = _txt;
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
  scheduleAmbient();                                   // Phase C: autonomous ambient life
  setTimeout(presenceBeat, 900);                       // Phase B: greet you on open
  document.addEventListener('visibilitychange', function () { if (!document.hidden) presenceBeat(); });
  window.addEventListener('focus', presenceBeat);
  lisa.addEventListener('mouseenter', presenceBeat);
  pollPing();
  subscribe();
  setInterval(pollPing, 30000);
  setInterval(applyTOD, 60000);   // re-check time-of-day each minute
})();
</script>
</body>
</html>
`;

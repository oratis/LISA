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
import type { ToolDefinition, StoredMessage } from "../types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ASSETS_DIR = path.join(__dirname, "assets");

const HTML = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>LISA</title>
<!-- PWA manifest + theming. Lets users add Lisa to their home screen on
     iOS Safari / Android Chrome and run her as a standalone app shell. -->
<link rel="manifest" href="/manifest.webmanifest">
<meta name="theme-color" content="#0a0d2b">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="LISA">
<link rel="apple-touch-icon" href="/assets/lisa-mascot.png">
<link rel="icon" type="image/png" href="/assets/lisa-mascot.png">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Press+Start+2P&family=VT323&display=swap" rel="stylesheet">
<style>
  :root {
    --bg: #0a0d2b;
    --panel: #1a1f4d;
    --panel-light: #2a3270;
    --border: #6a7ad9;
    --border-light: #a4b2ff;
    --text: #e7ecff;
    --text-dim: #8090c0;
    --you: #6cf6e1;
    --lisa: #ffd167;
    --tool: #ff7eb6;
    --error: #ff5c5c;
  }
  * { box-sizing: border-box; }
  html, body { height: 100%; margin: 0; }
  body {
    font-family: 'VT323', monospace;
    font-size: 22px;
    line-height: 1.25;
    color: var(--text);
    background-color: var(--bg);
    background-image: url('/assets/background-tile.png');
    background-repeat: repeat;
    background-size: 256px 256px;
    image-rendering: pixelated;
    overflow: hidden;
  }
  /* CRT scanlines + vignette */
  body::before {
    content: '';
    position: fixed;
    inset: 0;
    pointer-events: none;
    background:
      repeating-linear-gradient(
        to bottom,
        rgba(0,0,0,0) 0,
        rgba(0,0,0,0) 2px,
        rgba(0,0,0,0.18) 3px,
        rgba(0,0,0,0) 4px
      ),
      radial-gradient(ellipse at center, rgba(0,0,0,0) 60%, rgba(0,0,0,0.45) 100%);
    z-index: 1000;
  }

  .frame {
    display: grid;
    grid-template-columns: 280px 1fr;
    grid-template-rows: 64px 1fr 80px;
    grid-template-areas:
      "header header"
      "side   chat"
      "side   input";
    height: 100vh;
    padding: 20px;
    gap: 16px;
  }

  /* Reusable pixel-art bordered panel — chunky 4px outline + inset highlight */
  .panel {
    background: var(--panel);
    border: 4px solid var(--border);
    box-shadow:
      inset 2px 2px 0 var(--border-light),
      inset -2px -2px 0 #000,
      0 0 0 2px #000;
    image-rendering: pixelated;
  }

  header.panel {
    grid-area: header;
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0 16px;
  }
  .logo {
    font-family: 'Press Start 2P', monospace;
    font-size: 16px;
    color: var(--lisa);
    letter-spacing: 4px;
    text-shadow: 2px 2px 0 #000;
  }
  .logo .star { color: var(--you); animation: pulse 1s steps(2) infinite; }
  @keyframes pulse { 0%, 50% { opacity: 1; } 51%, 100% { opacity: 0.3; } }
  .badges {
    display: flex;
    gap: 14px;
    align-items: center;
    font-family: 'Press Start 2P', monospace;
    font-size: 9px;
    color: var(--text-dim);
  }
  .badge {
    display: flex;
    align-items: center;
    gap: 6px;
    background: transparent;
    border: 2px solid transparent;
    color: var(--text-dim);
    font-family: 'Press Start 2P', monospace;
    font-size: 9px;
    padding: 4px 8px;
    cursor: pointer;
    image-rendering: pixelated;
    box-shadow: none;
  }
  .badge:hover {
    color: var(--lisa);
    background: rgba(255, 209, 103, 0.1);
    border-color: var(--lisa);
  }
  .badge:active { transform: translate(1px, 1px); }
  .badge img { width: 24px; height: 24px; image-rendering: pixelated; }

  /* Modal panel for skills / memory / tools */
  .modal-bg {
    position: fixed; inset: 0;
    background: rgba(0, 0, 0, 0.7);
    display: none;
    align-items: center; justify-content: center;
    z-index: 100;
  }
  .modal-bg.open { display: flex; }
  .modal {
    background: var(--panel);
    border: 4px solid var(--border);
    box-shadow: inset 2px 2px 0 var(--border-light), inset -2px -2px 0 #000, 0 0 0 2px #000;
    max-width: 720px;
    width: 90vw;
    max-height: 80vh;
    display: flex;
    flex-direction: column;
    image-rendering: pixelated;
  }
  .modal-head {
    padding: 12px 16px;
    border-bottom: 2px solid var(--border);
    display: flex;
    justify-content: space-between;
    align-items: center;
  }
  .modal-title {
    font-family: 'Press Start 2P', monospace;
    font-size: 14px;
    color: var(--lisa);
    text-shadow: 2px 2px 0 #000;
  }
  .modal-close {
    background: var(--panel-light);
    border: 3px solid var(--border-light);
    box-shadow: inset 1px 1px 0 #fff5, inset -1px -1px 0 #0008;
    color: var(--text);
    font-family: 'Press Start 2P', monospace;
    font-size: 10px;
    padding: 6px 10px;
    cursor: pointer;
  }
  .modal-close:hover { background: var(--error); color: #fff; }
  .modal-body {
    padding: 16px;
    overflow-y: auto;
    font-family: 'VT323', monospace;
    font-size: 18px;
    line-height: 1.4;
  }
  .modal-body h3 {
    font-family: 'Press Start 2P', monospace;
    font-size: 11px;
    color: var(--you);
    margin: 12px 0 6px 0;
    border-bottom: 1px dashed var(--border);
    padding-bottom: 4px;
  }
  .modal-body h3:first-child { margin-top: 0; }
  .modal-body .item {
    padding: 6px 0;
    border-bottom: 1px dotted #ffffff15;
  }
  .modal-body .item:last-child { border: none; }
  .modal-body .name {
    color: var(--lisa);
    font-family: 'Press Start 2P', monospace;
    font-size: 10px;
  }
  .modal-body .desc { color: var(--text-dim); }
  .modal-body pre {
    background: #00000040;
    padding: 8px;
    border-left: 2px solid var(--border);
    white-space: pre-wrap;
    margin: 4px 0;
    color: var(--text);
  }
  .modal-body .empty { color: var(--text-dim); font-style: italic; }

  aside.panel {
    grid-area: side;
    display: flex;
    flex-direction: column;
    align-items: center;
    padding: 16px;
    gap: 12px;
  }
  .mascot-frame {
    width: 100%;
    aspect-ratio: 1;
    position: relative;
    border: 4px solid var(--border-light);
    background: linear-gradient(180deg, #2a3270 0%, #1a1f4d 100%);
    box-shadow: inset 0 0 0 2px #000, 0 0 0 2px #000;
    overflow: hidden;
  }
  .mascot {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    image-rendering: pixelated;
    object-fit: contain;
    transition: opacity 0.25s steps(4);
  }
  .mascot.fading { opacity: 0; }
  .mascot-tag {
    position: absolute;
    bottom: 4px;
    left: 4px;
    right: 4px;
    text-align: center;
    font-family: 'Press Start 2P', monospace;
    font-size: 8px;
    color: var(--lisa);
    text-shadow: 1px 1px 0 #000, -1px 1px 0 #000, 1px -1px 0 #000, -1px -1px 0 #000;
    background: rgba(10, 13, 43, 0.6);
    padding: 3px;
    pointer-events: none;
  }
  .name {
    font-family: 'Press Start 2P', monospace;
    font-size: 16px;
    color: var(--lisa);
    text-shadow: 2px 2px 0 #000;
  }
  .status {
    font-size: 18px;
    color: var(--you);
  }
  .status .dot {
    display: inline-block;
    width: 10px;
    height: 10px;
    background: var(--you);
    margin-right: 6px;
    box-shadow: 0 0 6px var(--you);
    animation: pulse 1s steps(2) infinite;
  }
  .session-id {
    margin-top: auto;
    font-size: 14px;
    color: var(--text-dim);
    word-break: break-all;
    text-align: center;
  }

  main.panel {
    grid-area: chat;
    overflow: hidden;
    display: flex;
    flex-direction: column;
    padding: 16px;
  }
  #log {
    flex: 1;
    overflow-y: auto;
    white-space: pre-wrap;
    word-break: break-word;
    padding-right: 8px;
  }
  #log::-webkit-scrollbar { width: 12px; }
  #log::-webkit-scrollbar-track { background: var(--panel); }
  #log::-webkit-scrollbar-thumb { background: var(--border); border: 2px solid var(--panel); }

  .role {
    font-family: 'Press Start 2P', monospace;
    font-size: 11px;
    margin-top: 12px;
    margin-bottom: 4px;
    text-shadow: 1px 1px 0 #000;
  }
  .role.you   { color: var(--you); }
  .role.lisa  { color: var(--lisa); }
  .tool-block {
    margin: 8px 0;
    padding: 8px 12px;
    background: rgba(255, 126, 182, 0.08);
    border-left: 4px solid var(--tool);
    box-shadow: inset 1px 1px 0 #0006;
    font-size: 18px;
  }
  .tool-block.tool-error {
    background: rgba(255, 92, 92, 0.12);
    border-left-color: var(--error);
  }
  .tool-head {
    color: var(--tool);
    font-family: 'Press Start 2P', monospace;
    font-size: 11px;
    display: flex;
    gap: 8px;
    align-items: center;
  }
  .tool-block.tool-error .tool-head { color: var(--error); }
  .tool-icon { font-size: 14px; }
  .tool-spinner { color: var(--text-dim); font-size: 14px; }
  .tool-input {
    color: var(--text);
    margin-top: 4px;
    padding-left: 22px;
    font-family: 'VT323', monospace;
    word-break: break-all;
  }
  .tool-result {
    color: var(--text-dim);
    margin-top: 6px;
    padding-left: 22px;
    font-size: 16px;
    max-height: 100px;
    overflow: hidden;
    white-space: pre-wrap;
    word-break: break-word;
    font-family: 'VT323', monospace;
    border-top: 1px dashed var(--border);
    padding-top: 4px;
  }
  .thinking {
    color: var(--text-dim);
    font-style: italic;
    margin-top: 6px;
    animation: pulse 1.2s steps(3) infinite;
  }
  .err { color: var(--error); margin-top: 6px; }
  .msg { display: block; }
  @keyframes blink { 50% { opacity: 0; } }

  .idle-block {
    margin: 14px 0;
    padding: 10px 12px;
    background: rgba(108, 246, 225, 0.06);
    border-left: 3px solid var(--you);
    border-radius: 0;
    font-size: 19px;
    color: var(--text);
    font-family: 'VT323', monospace;
    animation: idleFade 0.6s ease-out;
  }
  @keyframes idleFade {
    from { opacity: 0; transform: translateY(-4px); }
    to { opacity: 1; transform: translateY(0); }
  }
  .idle-block .idle-head {
    color: var(--you);
    font-family: 'Press Start 2P', monospace;
    font-size: 9px;
    margin-bottom: 6px;
    letter-spacing: 2px;
  }
  .idle-block .idle-time {
    color: var(--text-dim);
    font-size: 13px;
    margin-left: 6px;
  }
  .idle-pulse {
    color: var(--text-dim);
    font-style: italic;
    margin: 8px 0;
    animation: pulse 1.5s steps(3) infinite;
  }

  #attachPreview {
    grid-area: input;
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    padding: 0 4px 4px;
    min-height: 0;
  }
  #attachPreview:empty { display: none; }
  .attach-chip {
    background: var(--panel-light);
    border: 2px solid var(--border);
    color: var(--text);
    font-size: 9px;
    padding: 3px 6px;
    display: flex;
    align-items: center;
    gap: 4px;
    font-family: 'Press Start 2P', monospace;
  }
  .attach-rm {
    background: none;
    border: none;
    color: var(--you);
    cursor: pointer;
    font-size: 11px;
    padding: 0;
    line-height: 1;
    box-shadow: none;
    font-family: inherit;
  }
  .attach-rm:hover { background: none; color: #f55; }
  #attachBtn {
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 20px;
    cursor: pointer;
    padding: 4px 8px;
    background: var(--panel);
    border: 4px solid var(--border);
    box-shadow:
      inset 2px 2px 0 #000,
      inset -2px -2px 0 var(--border-light),
      0 0 0 2px #000;
    user-select: none;
    flex-shrink: 0;
  }
  #attachBtn:hover { background: var(--border); }
  .attach-label { font-size: 9px; opacity: 0.7; margin-left: 4px; }
  form#form {
    grid-area: input;
    display: grid;
    grid-template-columns: auto 1fr 120px;
    gap: 16px;
    align-items: start;
  }
  textarea {
    background: var(--panel);
    border: 4px solid var(--border);
    box-shadow:
      inset 2px 2px 0 #000,
      inset -2px -2px 0 var(--border-light),
      0 0 0 2px #000;
    color: var(--text);
    font: inherit;
    padding: 12px;
    resize: none;
    image-rendering: pixelated;
  }
  textarea:focus {
    outline: none;
    border-color: var(--you);
  }
  button {
    background: var(--panel-light);
    border: 4px solid var(--border-light);
    box-shadow:
      inset 2px 2px 0 #fff5,
      inset -2px -2px 0 #0008,
      0 0 0 2px #000;
    color: var(--text);
    font-family: 'Press Start 2P', monospace;
    font-size: 12px;
    cursor: pointer;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 6px;
    padding: 8px;
    image-rendering: pixelated;
    transition: transform 0.05s steps(1);
  }
  button img { width: 36px; height: 36px; image-rendering: pixelated; }
  button:hover {
    background: var(--border);
    color: #000;
  }
  button:active {
    transform: translate(2px, 2px);
    box-shadow:
      inset 2px 2px 0 #0008,
      inset -2px -2px 0 #fff5,
      0 0 0 2px #000;
  }
  button:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  /* Mobile + PWA standalone */
  @media (max-width: 720px) {
    body {
      /* Honor iOS safe area when running standalone (notch / home indicator). */
      padding-top: env(safe-area-inset-top);
      padding-bottom: env(safe-area-inset-bottom);
    }
    .frame {
      grid-template-columns: 1fr;
      grid-template-rows: 56px auto 1fr auto;
      grid-template-areas: "header" "side" "chat" "input";
      /* Account for safe areas inside the frame too, so input never hides
         behind iOS home indicator. */
      min-height: calc(100dvh - env(safe-area-inset-top) - env(safe-area-inset-bottom));
    }
    aside.panel {
      flex-direction: row;
      flex-wrap: wrap;
      gap: 8px;
      padding: 8px;
    }
    .mascot { width: 80px; }
    /* Inputs grow with content on mobile; keep cap so it doesn't cover chat. */
    .input-area textarea {
      min-height: 44px;
      max-height: 35vh;
      font-size: 16px; /* prevents iOS Safari auto-zoom on focus */
    }
    /* Chat scroll area uses dynamic viewport height to handle the
       ever-changing iOS Safari toolbar without the bottom getting cut off. */
    .chat {
      max-height: calc(100dvh - 240px);
    }
    /* Header inspector buttons get tighter on narrow screens. */
    .badge { padding: 4px 6px; font-size: 10px; }
    .badge img { width: 14px; height: 14px; }
  }
  /* PWA standalone-specific tweaks (also fires on installed Lisa). */
  @media (display-mode: standalone) {
    body { background: var(--bg); }
  }

  /* ── Birth ritual full-screen overlay ──────────────────────────────── */
  .birth-overlay {
    position: fixed;
    inset: 0;
    background:
      radial-gradient(ellipse at center, rgba(40, 30, 80, 0.95) 0%, rgba(5, 5, 20, 1) 70%),
      url('/assets/background-tile.png');
    background-size: cover, 256px 256px;
    background-repeat: no-repeat, repeat;
    z-index: 9999;
    display: none;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: 32px;
    image-rendering: pixelated;
  }
  .birth-overlay.open { display: flex; }
  .birth-overlay::before {
    content: '';
    position: absolute;
    inset: 0;
    pointer-events: none;
    background: repeating-linear-gradient(
      to bottom,
      rgba(0,0,0,0) 0,
      rgba(0,0,0,0) 2px,
      rgba(0,0,0,0.25) 3px,
      rgba(0,0,0,0) 4px
    );
    z-index: 1;
  }
  .birth-content {
    position: relative;
    z-index: 2;
    width: min(800px, 95vw);
    max-height: 90vh;
    overflow-y: auto;
  }
  .birth-stars {
    text-align: center;
    color: var(--lisa);
    font-family: 'Press Start 2P', monospace;
    font-size: 14px;
    letter-spacing: 8px;
    text-shadow: 0 0 8px var(--lisa);
    animation: starBlink 1.5s steps(3) infinite;
  }
  @keyframes starBlink {
    0%, 30%, 100% { opacity: 1; }
    50% { opacity: 0.4; }
  }
  .birth-title {
    text-align: center;
    color: var(--you);
    font-family: 'Press Start 2P', monospace;
    font-size: 22px;
    letter-spacing: 6px;
    margin: 24px 0 32px;
    text-shadow: 2px 2px 0 #000, 0 0 12px var(--you);
  }
  .birth-step {
    margin: 14px 0;
    padding: 10px 16px;
    border-left: 3px solid var(--border);
    background: rgba(20, 20, 50, 0.5);
    opacity: 0;
    transform: translateY(8px);
    transition: opacity 0.4s ease-out, transform 0.4s ease-out;
  }
  .birth-step.shown {
    opacity: 1;
    transform: translateY(0);
  }
  .birth-step.active {
    border-left-color: var(--lisa);
    background: rgba(255, 209, 103, 0.08);
    animation: stepGlow 1.2s ease-in-out infinite alternate;
  }
  @keyframes stepGlow {
    from { box-shadow: inset 2px 0 0 var(--lisa); }
    to { box-shadow: inset 6px 0 12px var(--lisa); }
  }
  .birth-step.done { border-left-color: var(--you); }
  .birth-step .step-name {
    font-family: 'Press Start 2P', monospace;
    font-size: 11px;
    color: var(--text-dim);
    text-transform: uppercase;
    margin-bottom: 4px;
  }
  .birth-step.active .step-name { color: var(--lisa); }
  .birth-step.done .step-name { color: var(--you); }
  .birth-step .step-detail {
    color: var(--text);
    font-size: 19px;
    font-family: 'VT323', monospace;
    word-break: break-word;
  }
  .birth-step .step-cursor {
    display: inline-block;
    width: 8px;
    background: var(--lisa);
    height: 0.9em;
    vertical-align: middle;
    animation: blink 0.8s steps(2) infinite;
  }
  .birth-final {
    margin-top: 36px;
    text-align: center;
    color: var(--lisa);
    font-family: 'Press Start 2P', monospace;
    font-size: 16px;
    text-shadow: 0 0 10px var(--lisa);
    animation: starBlink 2s steps(3) infinite;
    opacity: 0;
    transition: opacity 0.6s ease-in;
  }
  .birth-final.shown { opacity: 1; }
  .birth-enter {
    margin: 24px auto 0;
    display: block;
    background: var(--panel-light);
    border: 4px solid var(--lisa);
    box-shadow: inset 2px 2px 0 #fff5, inset -2px -2px 0 #0008, 0 0 16px var(--lisa);
    color: var(--lisa);
    font-family: 'Press Start 2P', monospace;
    font-size: 14px;
    padding: 14px 32px;
    cursor: pointer;
    letter-spacing: 4px;
    opacity: 0;
    transition: opacity 0.6s ease-in;
  }
  .birth-enter.shown { opacity: 1; }
  .birth-enter:hover { background: var(--lisa); color: #000; }
  .birth-error {
    color: var(--error);
    text-align: center;
    margin-top: 24px;
    font-family: 'Press Start 2P', monospace;
    font-size: 11px;
  }

  /* ── API key config overlay (shown when no key is set yet) ─────────── */
  .cfg-overlay {
    position: fixed;
    inset: 0;
    background:
      radial-gradient(ellipse at center, rgba(40, 30, 80, 0.95) 0%, rgba(5, 5, 20, 1) 70%),
      url('/assets/background-tile.png');
    background-size: cover, 256px 256px;
    background-repeat: no-repeat, repeat;
    z-index: 9998;
    display: none;
    align-items: center;
    justify-content: center;
    padding: 32px;
    image-rendering: pixelated;
  }
  .cfg-overlay.open { display: flex; }
  .cfg-overlay::before {
    content: '';
    position: absolute;
    inset: 0;
    pointer-events: none;
    background: repeating-linear-gradient(
      to bottom,
      rgba(0,0,0,0) 0,
      rgba(0,0,0,0) 2px,
      rgba(0,0,0,0.25) 3px,
      rgba(0,0,0,0) 4px
    );
    z-index: 1;
  }
  .cfg-card {
    position: relative;
    z-index: 2;
    width: min(560px, 95vw);
    background: var(--panel);
    border: 4px solid var(--border);
    box-shadow: inset 2px 2px 0 var(--border-light), inset -2px -2px 0 #000, 0 0 0 2px #000, 0 0 24px rgba(108, 246, 225, 0.25);
    padding: 28px 32px;
    image-rendering: pixelated;
  }
  .cfg-stars {
    text-align: center;
    color: var(--lisa);
    font-family: 'Press Start 2P', monospace;
    font-size: 12px;
    letter-spacing: 6px;
    text-shadow: 0 0 8px var(--lisa);
    animation: starBlink 1.5s steps(3) infinite;
  }
  .cfg-title {
    text-align: center;
    color: var(--you);
    font-family: 'Press Start 2P', monospace;
    font-size: 16px;
    letter-spacing: 4px;
    margin: 16px 0 6px;
    text-shadow: 2px 2px 0 #000, 0 0 10px var(--you);
  }
  .cfg-sub {
    text-align: center;
    color: var(--text-dim);
    font-family: 'VT323', monospace;
    font-size: 18px;
    margin-bottom: 22px;
    line-height: 1.35;
  }
  .cfg-sub a { color: var(--lisa); text-decoration: underline; }
  .cfg-field {
    display: block;
    margin: 14px 0;
  }
  .cfg-label {
    display: block;
    font-family: 'Press Start 2P', monospace;
    font-size: 10px;
    color: var(--lisa);
    margin-bottom: 6px;
    letter-spacing: 1px;
  }
  .cfg-label .opt {
    color: var(--text-dim);
    font-size: 8px;
    margin-left: 6px;
    letter-spacing: 0;
  }
  .cfg-input {
    width: 100%;
    background: var(--panel);
    border: 3px solid var(--border);
    box-shadow:
      inset 2px 2px 0 #000,
      inset -2px -2px 0 var(--border-light),
      0 0 0 2px #000;
    color: var(--text);
    font-family: 'VT323', monospace;
    font-size: 18px;
    padding: 10px 12px;
    image-rendering: pixelated;
  }
  .cfg-input:focus {
    outline: none;
    border-color: var(--you);
  }
  .cfg-help {
    color: var(--text-dim);
    font-family: 'VT323', monospace;
    font-size: 14px;
    margin-top: 4px;
  }
  .cfg-actions {
    margin-top: 22px;
    display: flex;
    justify-content: center;
  }
  .cfg-save {
    background: var(--panel-light);
    border: 4px solid var(--lisa);
    box-shadow: inset 2px 2px 0 #fff5, inset -2px -2px 0 #0008, 0 0 12px var(--lisa);
    color: var(--lisa);
    font-family: 'Press Start 2P', monospace;
    font-size: 12px;
    padding: 12px 28px;
    cursor: pointer;
    letter-spacing: 3px;
    image-rendering: pixelated;
  }
  .cfg-save:hover { background: var(--lisa); color: #000; }
  .cfg-save:active { transform: translate(2px, 2px); }
  .cfg-save:disabled { opacity: 0.55; cursor: wait; }
  .cfg-error {
    color: var(--error);
    font-family: 'Press Start 2P', monospace;
    font-size: 10px;
    text-align: center;
    margin-top: 14px;
    min-height: 14px;
  }
  .cfg-foot {
    margin-top: 18px;
    text-align: center;
    color: var(--text-dim);
    font-family: 'VT323', monospace;
    font-size: 14px;
    line-height: 1.4;
  }
  .cfg-foot code {
    color: var(--text);
    background: rgba(0, 0, 0, 0.3);
    padding: 1px 4px;
  }
</style>
</head><body>
<div class="frame">
  <header class="panel">
    <div class="logo"><span class="star">★</span> LISA <span class="star">★</span></div>
    <div class="badges">
      <button class="badge" type="button" data-panel="soul"><img src="/assets/icon-soul.png" alt=""> SOUL</button>
      <button class="badge" type="button" data-panel="skills"><img src="/assets/icon-skill.png" alt=""> SKILLS</button>
      <button class="badge" type="button" data-panel="memory"><img src="/assets/icon-memory.png" alt=""> MEMORY</button>
      <button class="badge" type="button" data-panel="tools"><img src="/assets/icon-tool.png" alt=""> TOOLS</button>
    </div>
  </header>

  <div class="modal-bg" id="modalBg">
    <div class="modal">
      <div class="modal-head">
        <div class="modal-title" id="modalTitle">…</div>
        <button class="modal-close" id="modalClose">CLOSE [esc]</button>
      </div>
      <div class="modal-body" id="modalBody">…</div>
    </div>
  </div>

  <!-- API key config overlay (shown if no key is configured yet) -->
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

  <aside class="panel">
    <div class="mascot-frame">
      <img class="mascot" id="mascot" src="/assets/lisa-mascot.png" alt="Lisa">
      <div class="mascot-tag" id="mascotTag">neutral</div>
    </div>
    <div class="name">LISA</div>
    <div class="status"><span class="dot"></span>online</div>
    <div class="session-id" id="sessionId">…</div>
  </aside>

  <main class="panel">
    <div id="log"></div>
  </main>

  <div id="attachPreview"></div>
  <form id="form">
    <label id="attachBtn" title="Attach file">
      <input type="file" id="fileInput" accept="image/*,.pdf,.txt,.md,.csv,.json" multiple style="display:none">
      📎
    </label>
    <textarea id="input" placeholder="Talk to Lisa…  (Enter to send · Shift+Enter for newline)" autofocus></textarea>
    <button type="submit" id="sendBtn">
      <img src="/assets/icon-send.png" alt="">
      SEND
    </button>
  </form>
</div>

<script>
const log = document.getElementById('log');
const input = document.getElementById('input');
const form = document.getElementById('form');
const sendBtn = document.getElementById('sendBtn');
const sessionEl = document.getElementById('sessionId');
const fileInput = document.getElementById('fileInput');
const attachPreview = document.getElementById('attachPreview');

// ── Attached files state ──────────────────────────────────────────
let pendingFiles = []; // Array of {name, mediaType, data (base64)}

function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result;
      const base64 = dataUrl.split(',')[1];
      resolve(base64);
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function inferMediaType(file) {
  if (file.type) return file.type;
  const ext = file.name.split('.').pop().toLowerCase();
  const map = { pdf: 'application/pdf', txt: 'text/plain', md: 'text/plain', csv: 'text/csv', json: 'application/json' };
  return map[ext] || 'application/octet-stream';
}

function renderAttachPreview() {
  attachPreview.innerHTML = '';
  pendingFiles.forEach((f, i) => {
    const chip = document.createElement('span');
    chip.className = 'attach-chip';
    chip.textContent = f.name;
    const rm = document.createElement('button');
    rm.type = 'button';
    rm.className = 'attach-rm';
    rm.textContent = '×';
    rm.onclick = () => { pendingFiles.splice(i, 1); renderAttachPreview(); };
    chip.appendChild(rm);
    attachPreview.appendChild(chip);
  });
}

fileInput.addEventListener('change', async () => {
  for (const file of fileInput.files) {
    const data = await readFileAsBase64(file);
    pendingFiles.push({ name: file.name, mediaType: inferMediaType(file), data });
  }
  fileInput.value = '';
  renderAttachPreview();
});

// Surface session id from server header on first request
fetch('/session').then(r => r.json()).then(s => sessionEl.textContent = s.id);

// ── Persistent /events SSE: mood updates + idle messages, lifetime of page
function connectEvents() {
  const es = new EventSource('/events');
  let idlePulseEl = null;
  es.addEventListener('message', (e) => {
    const ev = JSON.parse(e.data);
    if (ev.type === 'mood') {
      setMood(ev.slug);
    } else if (ev.type === 'idle_start') {
      if (!idlePulseEl) {
        idlePulseEl = document.createElement('div');
        idlePulseEl.className = 'idle-pulse';
        idlePulseEl.textContent = '⋯ Lisa is thinking on her own time ⋯';
        log.appendChild(idlePulseEl);
        log.scrollTop = log.scrollHeight;
      }
    } else if (ev.type === 'idle_message') {
      if (idlePulseEl) { idlePulseEl.remove(); idlePulseEl = null; }
      const block = document.createElement('div');
      block.className = 'idle-block';
      const head = document.createElement('div');
      head.className = 'idle-head';
      head.textContent = '★ WHILE YOU WERE AWAY';
      const time = document.createElement('span');
      time.className = 'idle-time';
      try { time.textContent = new Date(ev.at).toLocaleTimeString(); } catch {}
      head.appendChild(time);
      block.appendChild(head);
      const body = document.createElement('div');
      body.textContent = ev.text;
      block.appendChild(body);
      log.appendChild(block);
      log.scrollTop = log.scrollHeight;
    } else if (ev.type === 'idle_done') {
      if (idlePulseEl) { idlePulseEl.remove(); idlePulseEl = null; }
    } else if (ev.type === 'idle_error') {
      if (idlePulseEl) { idlePulseEl.remove(); idlePulseEl = null; }
      const e2 = document.createElement('div');
      e2.className = 'err';
      e2.textContent = '[idle error] ' + ev.message;
      log.appendChild(e2);
    }
  });
  es.onerror = () => {
    es.close();
    setTimeout(connectEvents, 3000); // reconnect
  };
}
connectEvents();

// ── API key config gate: show overlay if no key is configured ─────
const cfgOverlay = document.getElementById('cfgOverlay');
const cfgForm = document.getElementById('cfgForm');
const cfgAnthropic = document.getElementById('cfgAnthropic');
const cfgOpenai = document.getElementById('cfgOpenai');
const cfgSaveBtn = document.getElementById('cfgSave');
const cfgError = document.getElementById('cfgError');

cfgForm.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  cfgError.textContent = '';
  const anthropic = cfgAnthropic.value.trim();
  const openai = cfgOpenai.value.trim();
  if (!anthropic) {
    cfgError.textContent = 'ANTHROPIC_API_KEY is required.';
    return;
  }
  cfgSaveBtn.disabled = true;
  try {
    const res = await fetch('/api/config/save', {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({ anthropicKey: anthropic, openaiKey: openai || undefined }),
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      cfgError.textContent = 'Save failed: HTTP ' + res.status + (txt ? ' — ' + txt.slice(0, 120) : '');
      cfgSaveBtn.disabled = false;
      return;
    }
    cfgAnthropic.value = '';
    cfgOpenai.value = '';
    cfgOverlay.classList.remove('open');
    maybeBirth();
  } catch (err) {
    cfgError.textContent = 'Save failed: ' + err.message;
    cfgSaveBtn.disabled = false;
  }
});

// ── Birth ritual: show overlay if Lisa hasn't been born yet ───────
const birthOverlay = document.getElementById('birthOverlay');
const birthStepsEl = document.getElementById('birthSteps');
const birthFinalEl = document.getElementById('birthFinal');
const birthEnterBtn = document.getElementById('birthEnter');
const birthErrorEl = document.getElementById('birthError');

birthEnterBtn.addEventListener('click', () => {
  birthOverlay.classList.remove('open');
  setTimeout(() => location.reload(), 300);
});

async function maybeBirth() {
  const status = await fetch('/api/soul').then(r => r.json());
  if (status.born) return;
  birthOverlay.classList.add('open');
  startBirthStream();
}

function appendBirthStep(step) {
  // close previous active
  const prevActive = birthStepsEl.querySelector('.birth-step.active');
  if (prevActive) {
    prevActive.classList.remove('active');
    prevActive.classList.add('done');
  }
  const div = document.createElement('div');
  div.className = 'birth-step active';
  const name = document.createElement('div');
  name.className = 'step-name';
  name.textContent = step;
  div.appendChild(name);
  const detail = document.createElement('div');
  detail.className = 'step-detail';
  const cursor = document.createElement('span');
  cursor.className = 'step-cursor';
  detail.appendChild(cursor);
  div.appendChild(detail);
  birthStepsEl.appendChild(div);
  setTimeout(() => div.classList.add('shown'), 50);
  return detail;
}

function typewriter(el, text, done) {
  // remove cursor temporarily
  const cursor = el.querySelector('.step-cursor');
  if (cursor) cursor.remove();
  let i = 0;
  const speed = Math.max(8, Math.min(28, 600 / text.length));
  function tick() {
    if (i >= text.length) {
      // re-add cursor
      const c = document.createElement('span');
      c.className = 'step-cursor';
      el.appendChild(c);
      done && done();
      return;
    }
    el.appendChild(document.createTextNode(text[i]));
    i++;
    el.parentElement.parentElement.scrollTop = el.parentElement.parentElement.scrollHeight;
    setTimeout(tick, speed);
  }
  tick();
}

async function startBirthStream() {
  birthErrorEl.textContent = '';
  let currentDetail = null;
  let queue = [];
  let processing = false;

  function processQueue() {
    if (processing) return;
    if (queue.length === 0) return;
    processing = true;
    const ev = queue.shift();
    if (ev.kind === 'step') {
      currentDetail = appendBirthStep(ev.name);
      typewriter(currentDetail, ev.detail || '', () => {
        processing = false;
        processQueue();
      });
    } else if (ev.kind === 'done') {
      const last = birthStepsEl.querySelector('.birth-step.active');
      if (last) { last.classList.remove('active'); last.classList.add('done'); }
      birthFinalEl.textContent = ev.message;
      birthFinalEl.classList.add('shown');
      birthEnterBtn.classList.add('shown');
      processing = false;
    } else if (ev.kind === 'error') {
      birthErrorEl.textContent = ev.message;
      processing = false;
    }
  }

  try {
    const res = await fetch('/api/birth', { method: 'POST' });
    if (!res.ok) {
      birthErrorEl.textContent = 'Birth failed: HTTP ' + res.status + '. Check ANTHROPIC_API_KEY.';
      return;
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\\n\\n')) >= 0) {
        const event = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const m = event.match(/^data: (.*)$/m);
        if (!m) continue;
        const ev = JSON.parse(m[1]);
        queue.push(ev);
        processQueue();
      }
    }
  } catch (err) {
    birthErrorEl.textContent = 'Birth failed: ' + err.message;
  }
}

async function startupGate() {
  let cfg;
  try {
    cfg = await fetch('/api/config/status').then(r => r.json());
  } catch {
    // server unreachable — let the user retry by reloading; no overlay
    return;
  }
  if (!cfg.configured) {
    cfgOverlay.classList.add('open');
    setTimeout(() => cfgAnthropic.focus(), 50);
    return;
  }
  maybeBirth();
}
startupGate();

// ── history load & infinite-scroll ──────────────────────────────────
let historyPage = 0;
let historyLoading = false;
let historyExhausted = false;

function textOfMessage(msg) {
  if (typeof msg.content === 'string') return msg.content.trim();
  if (!Array.isArray(msg.content)) return '';
  // Only show text blocks; skip tool_use / tool_result blocks
  return msg.content
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('')
    .trim();
}

function prependHistoryMessages(messages) {
  const fragment = document.createDocumentFragment();
  for (const msg of messages) {
    const text = textOfMessage(msg);
    if (!text) continue;  // skip tool-only turns
    const roleDiv = document.createElement('div');
    roleDiv.className = 'role ' + (msg.role === 'user' ? 'you' : 'lisa');
    roleDiv.textContent = msg.role === 'user' ? 'YOU' : 'LISA';
    const span = document.createElement('span');
    span.className = 'msg';
    span.textContent = text;
    fragment.appendChild(roleDiv);
    fragment.appendChild(span);
  }
  log.insertBefore(fragment, log.firstChild);
}

async function loadHistoryPage() {
  if (historyLoading || historyExhausted) return;
  historyLoading = true;
  const prevScrollHeight = log.scrollHeight;
  try {
    const data = await fetch('/api/history?page=' + historyPage).then(r => r.json());
    if (data.messages.length > 0) {
      prependHistoryMessages(data.messages);
      // Keep scroll position stable after prepend
      log.scrollTop = log.scrollHeight - prevScrollHeight;
      historyPage++;
    }
    if (!data.hasMore) {
      historyExhausted = true;
      if (historyPage > 1) {
        const marker = document.createElement('div');
        marker.style.cssText = 'text-align:center;color:var(--text-dim);font-size:14px;padding:8px 0;';
        marker.textContent = '— 历史记录已全部加载 —';
        log.insertBefore(marker, log.firstChild);
      }
    }
  } finally {
    historyLoading = false;
  }
}

// Load first page immediately on start
loadHistoryPage();

// Scroll-to-top → load more
log.addEventListener('scroll', () => {
  if (log.scrollTop < 80) loadHistoryPage();
});

// ── mascot crossfade on mood event ──────────────────────────────────
const mascotEl = document.getElementById('mascot');
const mascotTagEl = document.getElementById('mascotTag');
let currentMood = 'neutral';
function setMood(slug) {
  if (!slug || slug === currentMood) return;
  const url = '/assets/lisa/' + encodeURIComponent(slug) + '.png';
  // Probe the asset first so we don't fade to a 404.
  const probe = new Image();
  probe.onload = () => {
    mascotEl.classList.add('fading');
    setTimeout(() => {
      mascotEl.src = url;
      mascotTagEl.textContent = slug;
      mascotEl.classList.remove('fading');
      currentMood = slug;
    }, 250);
  };
  probe.onerror = () => { /* asset not generated yet — keep current */ };
  probe.src = url;
}

// ── modal panel: SKILLS / MEMORY / TOOLS ──────────────────────────────
const modalBg = document.getElementById('modalBg');
const modalTitle = document.getElementById('modalTitle');
const modalBody = document.getElementById('modalBody');
const modalClose = document.getElementById('modalClose');

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
}
function openModal(title, html) {
  modalTitle.textContent = title;
  modalBody.innerHTML = html;
  modalBg.classList.add('open');
}
function closeModal() { modalBg.classList.remove('open'); }
modalClose.addEventListener('click', closeModal);
modalBg.addEventListener('click', (e) => { if (e.target === modalBg) closeModal(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });

async function showSkills() {
  openModal('SKILLS', '<div class="empty">loading…</div>');
  const data = await fetch('/api/skills').then(r => r.json());
  if (!data.skills.length) {
    modalBody.innerHTML = '<div class="empty">No skills saved yet. Lisa will start saving useful workflows as you use her.</div>';
    return;
  }
  modalBody.innerHTML = data.skills.map(s =>
    '<div class="item"><div class="name">' + escapeHtml(s.name) + '</div><div class="desc">' + escapeHtml(s.description) + '</div></div>'
  ).join('');
}

async function showMemory() {
  openModal('MEMORY', '<div class="empty">loading…</div>');
  const data = await fetch('/api/memory').then(r => r.json());
  modalBody.innerHTML =
    '<h3>USER.md — what Lisa remembers about you</h3>' +
    '<pre>' + escapeHtml(data.user || '(empty)') + '</pre>' +
    '<h3>MEMORY.md — Lisa\\'s working notes</h3>' +
    '<pre>' + escapeHtml(data.memory || '(empty)') + '</pre>';
}

async function showTools() {
  openModal('TOOLS', '<div class="empty">loading…</div>');
  const data = await fetch('/api/tools').then(r => r.json());
  modalBody.innerHTML = data.tools.map(t =>
    '<div class="item"><div class="name">' + escapeHtml(t.name) + '</div><div class="desc">' + escapeHtml(t.description) + '</div></div>'
  ).join('');
}

async function showSoul() {
  openModal('★ SOUL', '<div class="empty">loading…</div>');
  const data = await fetch('/api/soul').then(r => r.json());
  if (!data.born) {
    modalBody.innerHTML = '<div class="empty">Lisa hasn\\'t been born yet. Restart the CLI without --no-birth and the birth ritual will run.</div>';
    return;
  }
  const s = data.summary;
  let html = '';
  html += '<h3>name</h3><div>' + escapeHtml(s.name) + '</div>';
  html += '<h3>born</h3><div>' + escapeHtml(s.seed.bornAt) + ' · big5(O' + Math.round(s.seed.bigFive.openness*100) + ' C' + Math.round(s.seed.bigFive.conscientiousness*100) + ' E' + Math.round(s.seed.bigFive.extraversion*100) + ' A' + Math.round(s.seed.bigFive.agreeableness*100) + ' N' + Math.round(s.seed.bigFive.neuroticism*100) + ')</div>';
  html += '<h3>identity</h3><pre>' + escapeHtml(s.identity) + '</pre>';
  html += '<h3>purpose</h3><pre>' + escapeHtml(s.purpose) + '</pre>';
  html += '<h3>constitution</h3><pre>' + escapeHtml(s.constitution) + '</pre>';
  if (s.values?.length) {
    html += '<h3>values</h3>' + s.values.map(v =>
      '<div class="item"><div class="name">' + escapeHtml(v.title) + '</div><div class="desc">' + escapeHtml(v.body) + '</div></div>'
    ).join('');
  }
  if (s.opinions?.length) {
    html += '<h3>opinions</h3>' + s.opinions.map(o =>
      '<div class="item"><div class="name">' + escapeHtml(o.stance) + ' (conf ' + o.confidence.toFixed(2) + ')</div></div>'
    ).join('');
  }
  if (s.desires?.length) {
    html += '<h3>desires</h3>' + s.desires.map(d =>
      '<div class="item"><div class="name">' + escapeHtml(d.what) + (d.actionable ? ' [heartbeat-active]' : '') + '</div><div class="desc">' + escapeHtml(d.why) + '</div></div>'
    ).join('');
  }
  html += '<h3>emotions</h3>' + Object.entries(s.emotions.values).map(([k, v]) => {
    const len = 12;
    const filled = Math.round(Math.abs(v) * len);
    const bar = '█'.repeat(filled) + '░'.repeat(len - filled);
    return '<div class="item"><div class="name">' + escapeHtml(k) + '</div><div class="desc">' + (v < 0 ? '-' : ' ') + bar + '  ' + v.toFixed(2) + '</div></div>';
  }).join('');
  if (s.tampered?.length) {
    html += '<h3>⚠ tampered</h3><div>External edits detected on: ' + s.tampered.map(escapeHtml).join(', ') + '</div>';
  }
  html += '<h3 style="color: var(--text-dim); font-size: 9px;">privacy note</h3><div class="empty">Her journal lives at ~/.lisa/soul/journal/ but is intentionally not shown here — that is hers to keep.</div>';
  modalBody.innerHTML = html;
}

document.querySelectorAll('.badge').forEach(b => {
  b.addEventListener('click', () => {
    const which = b.dataset.panel;
    if (which === 'soul') showSoul();
    else if (which === 'skills') showSkills();
    else if (which === 'memory') showMemory();
    else if (which === 'tools') showTools();
  });
});

let currentLisaSpan = null;
let pendingTools = new Map();   // tool_use_id-ish key -> tool block element
let thinkingEl = null;

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text != null) node.textContent = text;
  log.appendChild(node);
  log.scrollTop = log.scrollHeight;
  return node;
}

function ensureLisaSpan() {
  if (currentLisaSpan) return currentLisaSpan;
  if (thinkingEl) { thinkingEl.remove(); thinkingEl = null; }
  el('div', 'role lisa', 'LISA');
  currentLisaSpan = el('span', 'msg', '');
  return currentLisaSpan;
}

// Pick the most useful one-line preview from a tool input object.
function previewInput(name, input) {
  if (!input || typeof input !== 'object') return '';
  const order = ['command', 'pattern', 'query', 'path', 'description', 'audio_path', 'text', 'name', 'action', 'entry'];
  for (const k of order) {
    if (typeof input[k] === 'string' && input[k]) {
      let v = input[k].replace(/\\s+/g, ' ').trim();
      if (v.length > 120) v = v.slice(0, 117) + '...';
      return v;
    }
  }
  // Fallback: stringify, trimmed
  try {
    const s = JSON.stringify(input);
    return s.length > 120 ? s.slice(0, 117) + '...' : s;
  } catch { return ''; }
}

async function send(message) {
  input.value = '';
  input.style.height = 'auto';
  sendBtn.disabled = true;
  el('div', 'role you', 'YOU');
  el('span', 'msg', message || '(attachment)');
  if (pendingFiles.length) {
    const names = pendingFiles.map(f => f.name).join(', ');
    el('span', 'msg attach-label', '📎 ' + names);
  }
  const filesToSend = [...pendingFiles];
  pendingFiles = [];
  renderAttachPreview();
  // Reset state for this turn
  currentLisaSpan = null;
  pendingTools.clear();
  thinkingEl = el('div', 'thinking', '⋯ thinking');
  try {
    const res = await fetch('/chat', {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({message, files: filesToSend}),
    });
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    while (true) {
      const {value, done} = await reader.read();
      if (done) break;
      buf += decoder.decode(value, {stream: true});
      let idx;
      while ((idx = buf.indexOf('\\n\\n')) >= 0) {
        const evRaw = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const m = evRaw.match(/^data: (.*)$/m);
        if (!m) continue;
        const ev = JSON.parse(m[1]);
        if (ev.type === 'text') {
          ensureLisaSpan().textContent += ev.text;
        } else if (ev.type === 'tool_start') {
          if (thinkingEl) { thinkingEl.remove(); thinkingEl = null; }
          // Close out any current LISA span — next text starts a new one.
          currentLisaSpan = null;
          const block = el('div', 'tool-block', null);
          const head = document.createElement('div');
          head.className = 'tool-head';
          head.innerHTML = '<span class="tool-icon">⚙</span> <span class="tool-name"></span> <span class="tool-spinner">...</span>';
          head.querySelector('.tool-name').textContent = ev.name;
          block.appendChild(head);
          const preview = previewInput(ev.name, ev.input);
          if (preview) {
            const p = document.createElement('div');
            p.className = 'tool-input';
            p.textContent = preview;
            block.appendChild(p);
          }
          pendingTools.set(ev.name, block);
        } else if (ev.type === 'tool_end') {
          const block = pendingTools.get(ev.name);
          if (block) {
            const spinner = block.querySelector('.tool-spinner');
            if (spinner) spinner.textContent = ev.isError ? '✗' : '✓';
            if (ev.isError) block.classList.add('tool-error');
            if (ev.resultPreview) {
              const r = document.createElement('div');
              r.className = 'tool-result';
              r.textContent = ev.resultPreview;
              block.appendChild(r);
            }
            pendingTools.delete(ev.name);
          }
        } else if (ev.type === 'mood') {
          setMood(ev.slug);
        } else if (ev.type === 'error') {
          el('div', 'err', '[error] ' + ev.message);
        } else if (ev.type === 'done') {
          if (thinkingEl) { thinkingEl.remove(); thinkingEl = null; }
        }
      }
    }
    if (thinkingEl) { thinkingEl.remove(); thinkingEl = null; }
  } catch (err) {
    if (thinkingEl) { thinkingEl.remove(); thinkingEl = null; }
    el('div', 'err', '[error] ' + err.message);
  } finally {
    sendBtn.disabled = false;
    input.focus();
  }
}

form.addEventListener('submit', (ev) => {
  ev.preventDefault();
  const msg = input.value.trim();
  if (msg || pendingFiles.length) send(msg);
});

input.addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter' && !ev.shiftKey) {
    ev.preventDefault();
    form.dispatchEvent(new Event('submit'));
  }
});
input.addEventListener('input', () => {
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 200) + 'px';
});

// ─── PWA: register service worker + iOS install hint ─────────────────
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(err => {
    console.warn('[pwa] sw register failed:', err);
  });
}
// iOS Safari doesn't fire beforeinstallprompt. Show a one-time hint to
// the user instead. Suppress if already running standalone (after add).
(function() {
  const isiOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
  const isStandalone = window.matchMedia('(display-mode: standalone)').matches
    || /** @type {any} */ (window.navigator).standalone === true;
  if (!isiOS || isStandalone) return;
  if (localStorage.getItem('lisa.pwa.dismissed') === '1') return;
  // Defer 5s so the chat UI shows first.
  setTimeout(() => {
    const banner = document.createElement('div');
    banner.style.cssText = 'position:fixed;bottom:8px;left:8px;right:8px;background:var(--panel);border:2px solid var(--border-light);padding:8px 10px;font-family:VT323,monospace;color:var(--text);font-size:14px;z-index:9999;display:flex;gap:8px;align-items:center;';
    banner.innerHTML = '✦ Add Lisa to Home Screen: Share button → "Add to Home Screen"';
    const dismiss = document.createElement('button');
    dismiss.textContent = '✕';
    dismiss.style.cssText = 'background:transparent;border:none;color:var(--text);cursor:pointer;font-size:16px;margin-left:auto;';
    dismiss.onclick = () => {
      localStorage.setItem('lisa.pwa.dismissed', '1');
      banner.remove();
    };
    banner.appendChild(dismiss);
    document.body.appendChild(banner);
  }, 5000);
})();
</script>
</body></html>`;

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
      res.end(HTML);
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
const CACHE = 'lisa-v1';
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

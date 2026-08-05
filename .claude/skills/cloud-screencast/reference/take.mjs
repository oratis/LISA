/**
 * Drive script template for cloud-screencast.
 *
 *   OUT=/tmp/raw.mp4 node take.mjs
 *
 * Owns ffmpeg's lifetime so capture and choreography share one clock, and prints a
 * `MARK <t> <label>` timeline — the edit is driven entirely off those timestamps.
 * Replace the BEATS section with your app's flow.
 */
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const OUT  = process.env.OUT  || '/tmp/raw.mp4';
const SIZE = process.env.SIZE || '2880x1620';

const marks = [];
let t0 = 0;
const now = () => (Date.now() - t0) / 1000;
function mark(label) {
  const t = now();
  marks.push({ label, t });
  console.log(`MARK ${t.toFixed(2).padStart(8)}  ${label}`);
}

// -draw_mouse 0: a programmatically driven cursor never moves, so a visible
// pointer just looks frozen. ultrafast+crf16 keeps capture real-time on 4 vCPU;
// quality comes back in the edit pass.
const ff = spawn('ffmpeg', [
  '-y', '-f', 'x11grab', '-draw_mouse', '0', '-framerate', '30',
  '-video_size', SIZE, '-i', ':99.0',
  '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '16', '-pix_fmt', 'yuv420p', OUT,
], { stdio: ['ignore', 'ignore', 'pipe'] });
let ffTail = '';
ff.stderr.on('data', (d) => { ffTail = (ffTail + d.toString()).slice(-1500); });

await new Promise((r) => setTimeout(r, 2500));   // let ffmpeg settle before t0
t0 = Date.now();
mark('REC_START');

// Attach to the already-running Chrome rather than launching one: the browser
// then survives a crash in this script, so a bad drive doesn't cost the take.
const b = await chromium.connectOverCDP('http://127.0.0.1:9222');
const page = b.contexts()[0].pages()[0];
const wait = (ms) => page.waitForTimeout(ms);

/** Poll for real completion instead of sleeping a fixed guess. */
async function until(fn, { every = 500, tries = 240 } = {}) {
  for (let i = 0; i < tries; i++) {
    if (await page.evaluate(fn)) return true;
    await wait(every);
  }
  return false;
}

/** Wait for streamed text to stop growing — the honest "is it done" signal. */
async function untilStable(sel, { every = 500, need = 6, tries = 240 } = {}) {
  let prev = -1, stable = 0;
  for (let i = 0; i < tries; i++) {
    const len = await page.evaluate((s) => document.querySelector(s)?.innerText?.length || 0, sel);
    stable = len === prev && len > 80 ? stable + 1 : 0;
    prev = len;
    if (stable >= need) return true;
    await wait(every);
  }
  return false;
}

// ── BEATS ──────────────────────────────────────────────────────────────
// Hold 2-3s on every payoff state. You can cut time out in post; you cannot
// add a frame that was never captured.

mark('beat1_start');
await until(() => !!document.querySelector('<ready-selector>'));
mark('beat1_ready');
await wait(2500);

// Typing: {delay: 40-60} reads as human. An instant fill() looks like a bug.
await page.click('<input-selector>');
await page.type('<input-selector>', 'your demo prompt', { delay: 50 });
mark('typed');
await wait(500);
await page.keyboard.press('Enter');
mark('sent');
await untilStable('<output-selector>');
mark('reply_done');
await wait(2800);

// Cinematic scroll: a stepped scrollTop reads as a deliberate camera move,
// a single jump reads as a glitch.
const scrolled = await page.evaluate(async () => {
  const el = document.querySelector('<scroll-container>');
  if (!el) return 0;
  const total = el.scrollHeight - el.clientHeight;
  for (let i = 0; i <= 140; i++) {
    el.scrollTop = (total * i) / 140;
    await new Promise((r) => setTimeout(r, 52));
  }
  return total;
});
mark(`scrolled_${scrolled}px`);
await wait(2000);

mark('REC_END');
// ───────────────────────────────────────────────────────────────────────

await b.close();
ff.kill('SIGINT');                                  // SIGINT, not SIGKILL — the
await new Promise((r) => setTimeout(r, 4000));      // container must finalize
writeFileSync('/tmp/marks.json', JSON.stringify(marks, null, 1));
console.log('\n--- ffmpeg ---\n' + ffTail);
console.log('\nWROTE ' + OUT);

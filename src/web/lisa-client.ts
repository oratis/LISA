/**
 * Inline client <script> for the Lisa chat shell (MAIN_HTML).
 *
 * The full browser-side runtime: attachments, vision capture, voice
 * dictation, SSE (mood/idle/claude), API-key gate, birth ritual, history
 * infinite-scroll, modal panels, send + streaming, and the sidebar live
 * wiring. Extracted verbatim from lisa-html.ts; re-embedded there as
 * `<script>\n${MAIN_CLIENT_JS}\n</script>`.
 *
 * IMPORTANT: this is the literal text served to the browser, NOT executed
 * as part of the build. Backslash escapes (e.g. `\\n`) are written here
 * exactly as they must appear in the emitted <script>. html-syntax.test.ts
 * compiles the result with vm.Script to catch a stray real newline inside
 * a JS string literal, and lisa-html-snapshot.test.ts pins the exact bytes.
 *
 * No interpolation or backticks appear in the original script text, so it
 * is a plain template literal with no ${} placeholders.
 */

export const MAIN_CLIENT_JS = `// ── First-run safety net: never leave the user with a silent dead UI. Any
// uncaught error / unreachable backend surfaces as a banner instead of nothing.
function lisaBanner(msg) {
  var el = document.getElementById('lisaBanner');
  if (!el) {
    el = document.createElement('div');
    el.id = 'lisaBanner';
    el.style.cssText = 'position:fixed;left:50%;top:12px;transform:translateX(-50%);z-index:99999;max-width:min(700px,92vw);padding:11px 16px;border-radius:12px;background:rgba(255,85,119,.14);border:1px solid rgba(255,85,119,.5);color:#ffc2cf;font:13px/1.5 -apple-system,system-ui,sans-serif;box-shadow:0 8px 30px rgba(0,0,0,.5);user-select:text';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.hidden = false;
}
function lisaClearBanner() { var el = document.getElementById('lisaBanner'); if (el) el.hidden = true; }
function lisaSleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
window.addEventListener('error', function (e) {
  if (e && e.message) lisaBanner('Lisa UI error: ' + e.message + ' — reload (Cmd-R); restart the backend if it persists.');
});
window.addEventListener('unhandledrejection', function (e) {
  var r = e && e.reason;
  lisaBanner('Lisa task failed: ' + ((r && r.message) ? r.message : String(r)));
});

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

// ── Vision: screenshot → composer ──────────────────────────────────
// lisaAttachImage adds an already-encoded {name,mediaType,data} object to
// the pending attachments — used by both the in-page 📷 button and the
// native global hotkey (Lisa.app calls lisaCaptureAndAttach via JS bridge).
window.lisaAttachImage = function (file) {
  if (!file || !file.data) return;
  pendingFiles.push({
    name: file.name || 'screenshot.png',
    mediaType: file.mediaType || 'image/png',
    data: file.data,
  });
  renderAttachPreview();
  try { input.focus(); } catch (_) {}
};

// lisaPrefillComposer drops text into the composer WITHOUT sending — the user
// reads it and hits Enter to send (that send is the confirmation). Used by the
// island's screen-advisor "Optimize ▸" card (via the Swift bridge) and by the
// ?prefill= URL param (plain browser tabs).
window.lisaPrefillComposer = function (text) {
  if (!text || !input) return;
  input.value = String(text);
  try { input.dispatchEvent(new Event('input', { bubbles: true })); } catch (_) {}
  try { input.focus(); input.setSelectionRange(input.value.length, input.value.length); } catch (_) {}
};

// On load, honour ?prefill=… (the island opens /?prefill=<task> in a browser
// tab). Strip it from the URL afterwards so a refresh doesn't re-fill.
try {
  var _pf = new URLSearchParams(location.search).get('prefill');
  if (_pf) {
    window.lisaPrefillComposer(_pf);
    history.replaceState(null, '', location.pathname);
  }
} catch (_) {}

// lisaCaptureAndAttach asks the server to run a screen capture, then
// attaches the result. mode: 'interactive' (crosshair, default) | 'full'.
// Returns true if an image was attached, false if cancelled/failed.
// Exposed on window so the native app's global hotkey can invoke it.
let capturing = false;
window.lisaCaptureAndAttach = async function (mode) {
  if (capturing) return false;
  capturing = true;
  const btn = document.getElementById('plusBtn');
  if (btn) btn.classList.add('flash');
  try {
    const res = await fetch('/api/vision/capture', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: mode || 'interactive' }),
    });
    if (!res.ok) {
      console.warn('[vision] capture failed: HTTP ' + res.status);
      return false;
    }
    const data = await res.json();
    if (data.cancelled || !data.file) return false;
    window.lisaAttachImage(data.file);
    return true;
  } catch (err) {
    console.warn('[vision] capture error:', err);
    return false;
  } finally {
    capturing = false;
    if (btn) setTimeout(() => btn.classList.remove('flash'), 200);
  }
};

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

// The natural <label>→<input type=file> click-forwarding is supposed
// to open the picker without any JS. But in WKWebView under our
// layout it never reaches runOpenPanel. We add an explicit click
// listener that forwards the click synchronously (preserving the
// user-gesture context) and logs to console so we can verify in the
// inspector if it ever silently no-ops again.
// ── ＋ composer menu: merges 📎 attach + 📷 screenshot into one button ──
const plusBtnEl = document.getElementById('plusBtn');
const plusMenuEl = document.getElementById('plusMenu');
function closePlusMenu() { if (plusMenuEl) plusMenuEl.classList.remove('open'); }
if (plusBtnEl && plusMenuEl) {
  plusBtnEl.addEventListener('click', (e) => { e.stopPropagation(); plusMenuEl.classList.toggle('open'); });
  document.addEventListener('click', (e) => {
    if (plusMenuEl.classList.contains('open') && !plusMenuEl.contains(e.target) && e.target !== plusBtnEl) closePlusMenu();
  });
}
const pmAttachEl = document.getElementById('pmAttach');
if (pmAttachEl) {
  pmAttachEl.addEventListener('click', () => {
    closePlusMenu();
    try { fileInput.click(); } catch (err) { console.error('[attach] fileInput.click failed:', err); }
  });
}
const pmShotEl = document.getElementById('pmShot');
if (pmShotEl) {
  pmShotEl.addEventListener('click', () => { closePlusMenu(); void window.lisaCaptureAndAttach('interactive'); });
}

// ── Audio recording → transcribe → Lisa summarizes ─────────────────
// 🎙 toggles a MediaRecorder. On stop: POST the clip to /api/voice/transcribe
// (server-side Whisper), then send the transcript into the normal chat with a
// "summarize this" framing — so Lisa produces the summary in her own voice and
// it's persisted + discussable like any turn. First click prompts mic
// permission (browser-native).
const recordBtnEl = document.getElementById('recordBtn');
let mediaRecorder = null;
let recordedChunks = [];
let recordStream = null;
// 'dictation' (default): polish speech → composer for you to edit + send.
// 'summary' (long-press 🎙): the original record→Lisa-summarizes flow.
let recordMode = 'dictation';

function pickAudioMime() {
  const prefs = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg'];
  for (const m of prefs) {
    try { if (window.MediaRecorder && MediaRecorder.isTypeSupported(m)) return m; } catch (_) {}
  }
  return '';
}

async function startRecording() {
  if (!navigator.mediaDevices || !window.MediaRecorder) {
    el('div', 'err', '[voice] recording not supported in this browser');
    return;
  }
  try {
    recordStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (err) {
    el('div', 'err', '[voice] microphone access denied or unavailable');
    return;
  }
  const mimeType = pickAudioMime();
  recordedChunks = [];
  mediaRecorder = mimeType ? new MediaRecorder(recordStream, { mimeType }) : new MediaRecorder(recordStream);
  mediaRecorder.addEventListener('dataavailable', (e) => { if (e.data && e.data.size > 0) recordedChunks.push(e.data); });
  mediaRecorder.addEventListener('stop', () => { void finishRecording(); });
  mediaRecorder.start();
  if (recordBtnEl) { recordBtnEl.classList.add('recording'); recordBtnEl.textContent = '⏹'; recordBtnEl.title = 'Stop recording'; }
}

function stopRecordingTracks() {
  if (recordStream) { recordStream.getTracks().forEach((t) => t.stop()); recordStream = null; }
  if (recordBtnEl) { recordBtnEl.classList.remove('recording'); recordBtnEl.textContent = '🎙'; recordBtnEl.title = 'Dictate — speak and Lisa drops polished text in the box (hold to record a summary)'; }
}

async function finishRecording() {
  const mime = (mediaRecorder && mediaRecorder.mimeType) || 'audio/webm';
  stopRecordingTracks();
  const mode = recordMode;
  const blob = new Blob(recordedChunks, { type: mime });
  recordedChunks = [];
  if (blob.size === 0) return;
  // Transient status line: dictation polishes; summary transcribes.
  const pending = el('div', 'thinking', mode === 'dictation' ? '⋯ transcribing + polishing' : '⋯ transcribing recording');
  try {
    const data = await blobToBase64(blob);
    const res = await fetch('/api/voice/transcribe', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ data, mediaType: mime, mode }),
    });
    const out = await res.json();
    if (pending) pending.remove();
    if (!res.ok || out.error) {
      el('div', 'err', '[voice] ' + (out.error || ('HTTP ' + res.status)));
      return;
    }
    if (mode === 'dictation') {
      // Typeless-style: drop the polished text into the composer (cursor at end)
      // for you to review and send. Never auto-sends. Appends if you'd already
      // started typing.
      const text = (out.text || out.transcript || '').trim();
      if (!text) { el('div', 'err', '[voice] (nothing dictated)'); return; }
      const existing = input.value.trimEnd();
      input.value = existing ? existing + '\\n' + text : text;
      try { input.dispatchEvent(new Event('input', { bubbles: true })); } catch (_) {}
      try { input.focus(); input.setSelectionRange(input.value.length, input.value.length); } catch (_) {}
      return;
    }
    // summary mode: hand the transcript to Lisa with a summarize framing.
    const transcript = (out.transcript || '').trim();
    if (!transcript) { el('div', 'err', '[voice] (empty transcript)'); return; }
    const framed =
      "I just recorded some audio. Here's the transcript — please give me a clear, " +
      "useful summary (key points, decisions, action items if any), then I might ask follow-ups.\\n\\n" +
      "--- transcript ---\\n" + transcript;
    send(framed);
  } catch (err) {
    if (pending) pending.remove();
    el('div', 'err', '[voice] ' + (err && err.message ? err.message : 'transcription failed'));
  }
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

if (recordBtnEl) {
  // Short click → dictation (polished text into the composer). Press-and-hold
  // (≥500ms) → summary (record → Lisa summarizes). A click always follows
  // pointerup, so we just flag long-presses and read the flag on click.
  let longPress = false;
  let holdTimer = null;
  const clearHold = () => { if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; } };
  recordBtnEl.addEventListener('pointerdown', () => {
    longPress = false;
    clearHold();
    holdTimer = setTimeout(() => { longPress = true; }, 500);
  });
  recordBtnEl.addEventListener('pointerup', clearHold);
  recordBtnEl.addEventListener('pointercancel', clearHold);
  recordBtnEl.addEventListener('pointerleave', clearHold);
  recordBtnEl.addEventListener('click', () => {
    if (mediaRecorder && mediaRecorder.state === 'recording') {
      mediaRecorder.stop();
      longPress = false;
      return;
    }
    recordMode = longPress ? 'summary' : 'dictation';
    longPress = false;
    if (recordBtnEl) recordBtnEl.title = recordMode === 'summary' ? 'Recording for summary — click to stop' : 'Dictating — click to stop';
    void startRecording();
  });
}

// (📎 attach is now an item in the ＋ composer menu — see pmAttach above.)

// Paste-to-attach: when the user has copied an image (screenshot,
// image from a webpage, etc.) and presses ⌘V, pull the image off the
// clipboard and add it to pendingFiles — same path the file picker
// uses. Plain-text paste falls through to default behavior.
//
// We listen at the DOCUMENT level so paste works whether the textarea
// is focused, the chat log is focused, or focus is on a tool-block.
// (Some users press ⌘V right after launching the app, before clicking
// anywhere — element-scoped handlers miss that.)
//
// For text paste we MUST NOT preventDefault — let the browser route
// it to the focused element. Only intercept when we detect image
// items.
async function handlePastedClipboard(ev) {
  const cb = ev.clipboardData;
  if (!cb) return;

  // Two clipboard surfaces — items (modern, exposes pasteboard files)
  // and files (older, doesn't include MIME type for some types). We
  // dedupe via the underlying File reference.
  const fileMap = new Map();  // File → mediaType (string)
  if (cb.items && cb.items.length) {
    for (const item of cb.items) {
      if (item.kind !== 'file') continue;
      if (!item.type || !item.type.startsWith('image/')) continue;
      const f = item.getAsFile();
      if (f) fileMap.set(f, item.type);
    }
  }
  if (cb.files && cb.files.length) {
    for (const f of cb.files) {
      if (f.type && f.type.startsWith('image/')) {
        if (!fileMap.has(f)) fileMap.set(f, f.type || 'image/png');
      }
    }
  }

  if (fileMap.size === 0) return; // text paste — leave default behavior alone

  ev.preventDefault();
  // Keep focus on the textarea so the user can keep typing right after.
  try { input.focus(); } catch (_) {}

  for (const [file, mediaType] of fileMap) {
    try {
      const data = await readFileAsBase64(file);
      const ext = (mediaType.split('/')[1] || 'png').replace(/[^a-z0-9]/gi, '');
      const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const name = file.name && file.name !== 'image.png'
        ? file.name
        : 'pasted-' + ts + '.' + ext;
      pendingFiles.push({ name, mediaType, data });
    } catch (err) {
      console.warn('[paste] failed to read image:', err);
    }
  }
  renderAttachPreview();
}

input.addEventListener('paste',  (ev) => { void handlePastedClipboard(ev); });
// Document-level fallback. If focus is somewhere other than the
// textarea (e.g. just-launched, no focus yet), the textarea-level
// paste listener never fires; this one catches it.
document.addEventListener('paste', (ev) => {
  // Avoid double-firing when the textarea ALREADY handled it: if
  // ev.defaultPrevented is set, the textarea listener already
  // consumed the paste and added the file.
  if (ev.defaultPrevented) return;
  void handlePastedClipboard(ev);
});

// Surface session id from server header on first request. The titlebar
// shows the same id with a leading "·" separator after the "Lisa" label.
fetch('/session').then(r => r.json()).then(s => {
  sessionEl.textContent = s.id;
  const titlebarSession = document.getElementById('titlebarSession');
  if (titlebarSession) titlebarSession.textContent = '· ' + s.id;
});

// ── Persistent /events SSE: mood updates + idle messages + Claude
// activity, lifetime of page.
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
      const bodyEl = document.createElement('div');
      bodyEl.textContent = ev.text;
      block.appendChild(bodyEl);
      log.appendChild(block);
      log.scrollTop = log.scrollHeight;
      // sidebar reflection card mirrors the latest while-you-were-away
      if (typeof updateReflection === 'function') updateReflection(ev.text);
    } else if (ev.type === 'idle_done') {
      if (idlePulseEl) { idlePulseEl.remove(); idlePulseEl = null; }
    } else if (ev.type === 'idle_error') {
      if (idlePulseEl) { idlePulseEl.remove(); idlePulseEl = null; }
      const e2 = document.createElement('div');
      e2.className = 'err';
      e2.textContent = '[idle error] ' + ev.message;
      log.appendChild(e2);
    } else if (ev.type === 'agent_session_update') {
      // D4a — sidebar multi-agent monitor refresh (defined later in the
      // "sidebar live wiring" block). Generalized from claude_session_update
      // so codex / opencode / git / … sessions update the sidebar too.
      if (typeof refreshClaudeSessions === 'function') refreshClaudeSessions();
    } else if (ev.type === 'mail_digest_update' || ev.type === 'mail_accounts_update') {
      if (typeof window.refreshMail === 'function') window.refreshMail();
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
  const cursor = el.querySelector('.step-cursor');
  if (cursor) cursor.remove();
  let i = 0;
  const speed = Math.max(8, Math.min(28, 600 / text.length));
  function tick() {
    if (i >= text.length) {
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
  // Retry: the page can render a hair before the backend's API routes answer,
  // and a transient miss must not silently skip onboarding (the old bug — a
  // bare catch+return left a dead UI with no key prompt, no birth, no message).
  let cfg = null;
  for (let i = 0; i < 6 && !cfg; i++) {
    try { cfg = await fetch('/api/config/status').then(r => r.json()); }
    catch (e) { if (i < 5) await lisaSleep(700); }
  }
  if (!cfg) {
    lisaBanner('Cannot reach Lisa backend on localhost:5757. Start it:  lisa serve --web  (install once: npm i -g @oratis/lisa). Retrying…');
    setTimeout(startupGate, 3000);
    return;
  }
  lisaClearBanner();
  if (!cfg.configured) {
    cfgOverlay.classList.add('open');
    setTimeout(() => cfgAnthropic.focus(), 50);
    return;
  }
  try {
    await maybeBirth();
  } catch (e) {
    lisaBanner('Birth check failed: ' + ((e && e.message) ? e.message : e) + ' — reload to retry.');
  }
}
startupGate();

// ── history load & infinite-scroll ──────────────────────────────────
let historyPage = 0;
let historyLoading = false;
let historyExhausted = false;

function textOfMessage(msg) {
  if (typeof msg.content === 'string') return msg.content.trim();
  if (!Array.isArray(msg.content)) return '';
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
    if (!text) continue;
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
    const res = await fetch('/api/history?page=' + historyPage);
    const data = await res.json();
    if (data.messages && data.messages.length) {
      prependHistoryMessages(data.messages);
      log.scrollTop = log.scrollHeight - prevScrollHeight;
      historyPage++;
    }
    if (!data.hasMore) {
      historyExhausted = true;
      if (historyPage > 1) {
        const marker = document.createElement('div');
        marker.style.cssText = 'text-align:center;color:var(--fg-3);font-size:11px;padding:8px 0;letter-spacing:0.06em;';
        marker.textContent = '— end of history —';
        log.insertBefore(marker, log.firstChild);
      }
    }
  } finally {
    historyLoading = false;
  }
}

loadHistoryPage();
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
  const probe = new Image();
  probe.onload = () => {
    mascotEl.classList.add('fading');
    setTimeout(() => {
      mascotEl.src = url;
      mascotTagEl.textContent = 'mood: ' + slug;
      mascotEl.classList.remove('fading');
      currentMood = slug;
    }, 250);
  };
  probe.onerror = () => { /* asset not generated yet — keep current */ };
  probe.src = url;
}

// ── modal panel: SOUL / SKILLS / MEMORY / TOOLS ──────────────────────
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

async function showPlans() {
  openModal('CODING PLANS', '<div class="empty">loading…</div>');
  let data;
  try { data = await fetch('/api/plans').then(r => r.json()); }
  catch (e) { modalBody.innerHTML = '<div class="empty">failed to load plans</div>'; return; }
  const intro = '<div class="empty">Run coding work on a subscription you already pay for (Claude Pro/Max · ChatGPT/Codex · Copilot) instead of a metered API key. LISA drives the vendor CLI you are logged into, so it bills your plan, not a key. This does not change her own model.</div>';
  const rows = (data.plans || []).map(function (p) {
    const star = p.selected ? ' — selected' : '';
    const usage = p.usage ? '<div class="desc">usage: ' + escapeHtml(p.usage) + '</div>' : '';
    let btn;
    if (p.selected) btn = '<button class="plan-select" data-plan="' + escapeHtml(p.id) + '" disabled>selected</button>';
    else if (p.available) btn = '<button class="plan-select" data-plan="' + escapeHtml(p.id) + '">use this</button>';
    else btn = '<button class="plan-select" data-plan="' + escapeHtml(p.id) + '" disabled>not installed</button>';
    return '<div class="item"><div class="name">' + escapeHtml(p.mark + ' ' + p.label + star) + '</div><div class="desc">' + escapeHtml(p.detail) + '</div>' + usage + btn + '</div>';
  }).join('');
  const clear = '<div class="item"><button class="plan-select" data-plan="none">clear selection</button></div>';
  modalBody.innerHTML = intro + rows + clear;
  document.querySelectorAll('.plan-select').forEach(function (btn) {
    if (btn.disabled) return;
    btn.addEventListener('click', function () { selectPlan(btn.dataset.plan); });
  });
}

async function selectPlan(plan) {
  try {
    const res = await fetch('/api/plans/select', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ plan: plan }),
    });
    if (!res.ok) {
      const t = await res.text().catch(function () { return ''; });
      modalBody.insertAdjacentHTML('afterbegin', '<div class="empty" style="color:var(--err-color)">select failed: ' + escapeHtml(String(res.status) + (t ? ' — ' + t : '')) + '</div>');
      return;
    }
    showPlans();
  } catch (e) {
    modalBody.insertAdjacentHTML('afterbegin', '<div class="empty" style="color:var(--err-color)">select error: ' + escapeHtml(e.message) + '</div>');
  }
}

// ── Pair phone: mint a device token + show copyable pairing details ──────────
// Mirrors "lisa pair" / the Mac app Pair iPhone window for browser users. The mint
// endpoint is loopback-only, so this works from a localhost browser on the Mac
// (a LAN browser gets 403, handled below). The server detects the Mac's LAN host
// and returns the lisa-pair:// link + host/port/token so the phone can paste the
// link OR type the fields into Lisa Pocket → Settings → Pair.
function pairRow(label, value) {
  return '<div class="pair-row"><span class="pair-label">' + escapeHtml(label) + '</span>'
    + '<code class="pair-val">' + escapeHtml(value) + '</code>'
    + '<button class="pair-copy" type="button">Copy</button></div>';
}
async function showPair() {
  openModal('PAIR PHONE', '<div class="empty">minting a pairing code…</div>');
  let res;
  try {
    res = await fetch('/api/pair/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'phone', platform: 'ios' }),
    });
  } catch (e) {
    modalBody.innerHTML = '<div class="empty">Couldn\\'t reach the Lisa backend.</div>';
    return;
  }
  if (res.status === 403) {
    modalBody.innerHTML = '<div class="empty">Pairing can only be started on the Mac itself. Open this page at <code>http://localhost:' + escapeHtml(location.port || '5757') + '</code> on your Mac, then try again.</div>';
    return;
  }
  if (!res.ok) {
    modalBody.innerHTML = '<div class="empty">Pairing failed (HTTP ' + res.status + ').</div>';
    return;
  }
  const data = await res.json().catch(function () { return {}; });
  if (!data.token) { modalBody.innerHTML = '<div class="empty">The server returned no token.</div>'; return; }
  const port = data.port || 5757;
  const host = data.host || '';
  const link = data.url || ('lisa-pair://v1?host=' + encodeURIComponent(host) + '&port=' + port + '&token=' + encodeURIComponent(data.token) + '&name=phone');
  let html = '<div class="empty">In Lisa Pocket → Settings → Pair, paste the link below — or switch to “enter manually” and type the three fields. Keep the phone on the same Wi-Fi (or tailnet) as this Mac.</div>';
  html += pairRow('Link', link);
  html += pairRow('Host', host || '(your Mac\\'s Wi-Fi IP)');
  html += pairRow('Port', String(port));
  html += pairRow('Token', data.token);
  if (!host) html += '<div class="empty">Couldn\\'t detect your Mac\\'s LAN address — enter its Wi-Fi IP or tailnet name on the phone.</div>';
  modalBody.innerHTML = html;
  const codes = modalBody.querySelectorAll('.pair-row');
  for (let i = 0; i < codes.length; i++) {
    const row = codes[i];
    const btn = row.querySelector('.pair-copy');
    const val = row.querySelector('.pair-val');
    btn.addEventListener('click', function () {
      navigator.clipboard.writeText(val.textContent).then(function () {
        const prev = btn.textContent; btn.textContent = 'Copied'; setTimeout(function () { btn.textContent = prev; }, 1200);
      }).catch(function () {});
    });
  }
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
  html += '<h3 style="color: var(--fg-3); font-size: 10px;">privacy note</h3><div class="empty">Her journal lives at ~/.lisa/soul/journal/ but is intentionally not shown here — that is hers to keep.</div>';
  modalBody.innerHTML = html;
}

// Panel openers — the top function bar (.fbtn) + any legacy .badge share this.
document.querySelectorAll('[data-panel]').forEach(b => {
  b.addEventListener('click', () => {
    const which = b.dataset.panel;
    if (which === 'soul') showSoul();
    else if (which === 'skills') showSkills();
    else if (which === 'memory') showMemory();
    else if (which === 'tools') showTools();
    else if (which === 'plans') showPlans();
    else if (which === 'pair') showPair();
  });
});

// Find in conversation — toggle a filter box that hides non-matching log rows.
const fnSearchBtn = document.getElementById('fnSearchBtn');
const fnFind = document.getElementById('fnFind');
function filterLog(q) {
  const logEl = document.getElementById('log');
  if (!logEl) return;
  for (const child of logEl.children) {
    child.style.display = !q || (child.textContent || '').toLowerCase().includes(q) ? '' : 'none';
  }
}
if (fnSearchBtn && fnFind) {
  fnSearchBtn.addEventListener('click', () => {
    const show = fnFind.style.display === 'none';
    fnFind.style.display = show ? '' : 'none';
    if (show) { fnFind.focus(); } else { fnFind.value = ''; filterLog(''); }
  });
  fnFind.addEventListener('input', () => filterLog(fnFind.value.trim().toLowerCase()));
  fnFind.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { fnFind.value = ''; filterLog(''); fnFind.style.display = 'none'; }
  });
}

// Compact / sidebar mode — force the narrow stacked layout at any width, persisted.
const compactToggleEl = document.getElementById('compactToggle');
if (compactToggleEl) {
  let compactOn = false;
  try { compactOn = localStorage.getItem('lisaCompact') === '1'; } catch (e) {}
  const applyCompact = () => {
    document.body.classList.toggle('force-compact', compactOn);
    compactToggleEl.classList.toggle('on', compactOn);
    compactToggleEl.setAttribute('aria-checked', compactOn ? 'true' : 'false');
  };
  applyCompact();
  const toggleCompact = () => {
    compactOn = !compactOn;
    try { localStorage.setItem('lisaCompact', compactOn ? '1' : '0'); } catch (e) {}
    applyCompact();
  };
  compactToggleEl.addEventListener('click', toggleCompact);
  compactToggleEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleCompact(); }
  });
}

let currentLisaSpan = null;
let pendingTools = new Map();
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
  try {
    const s = JSON.stringify(input);
    return s.length > 120 ? s.slice(0, 117) + '...' : s;
  } catch { return ''; }
}

async function send(message) {
  input.value = '';
  input.style.height = 'auto';
  el('div', 'role you', 'YOU');
  el('span', 'msg', message || '(attachment)');
  if (pendingFiles.length) {
    const names = pendingFiles.map(f => f.name).join(', ');
    el('span', 'msg attach-label', '📎 ' + names);
  }
  const filesToSend = [...pendingFiles];
  pendingFiles = [];
  renderAttachPreview();
  await runChat(message, filesToSend);
}

// On failure, show the error detail with a retry button that re-runs the same
// turn. Kept separate from send() so retry never re-appends the user's bubble
// or re-reads the (already-cleared) attachment tray.
function showError(detail, message, filesToSend) {
  if (thinkingEl) { thinkingEl.remove(); thinkingEl = null; }
  const block = el('div', 'err-block', null);
  const head = document.createElement('div');
  head.className = 'err-head';
  head.textContent = '⚠ 请求出错';
  block.appendChild(head);
  const body = document.createElement('div');
  body.className = 'err-detail';
  body.textContent = detail || 'unknown error';
  block.appendChild(body);
  const retry = document.createElement('button');
  retry.type = 'button';
  retry.className = 'err-retry';
  retry.textContent = '↻ 重试';
  retry.addEventListener('click', () => {
    block.remove();
    runChat(message, filesToSend);
  });
  block.appendChild(retry);
  log.scrollTop = log.scrollHeight;
}

async function runChat(message, filesToSend) {
  sendBtn.disabled = true;
  currentLisaSpan = null;
  pendingTools.clear();
  thinkingEl = el('div', 'thinking', '⋯ thinking');
  // The agent emits an error event AND the server re-sends it from its turn
  // catch — dedupe so one failure renders exactly one error block.
  let errored = false;
  const fail = (detail) => {
    if (errored) return;
    errored = true;
    showError(detail, message, filesToSend);
  };
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
          fail(ev.message);
        } else if (ev.type === 'done') {
          if (thinkingEl) { thinkingEl.remove(); thinkingEl = null; }
        }
      }
    }
    if (thinkingEl) { thinkingEl.remove(); thinkingEl = null; }
  } catch (err) {
    fail(err.message);
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

// ── PWA: register service worker + iOS install hint ─────────────────
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(err => {
    console.warn('[pwa] sw register failed:', err);
  });
}
(function() {
  const isiOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
  const isStandalone = window.matchMedia('(display-mode: standalone)').matches
    || (window.navigator).standalone === true;
  if (!isiOS || isStandalone) return;
  if (localStorage.getItem('lisa.pwa.dismissed') === '1') return;
  setTimeout(() => {
    const banner = document.createElement('div');
    banner.style.cssText = 'position:fixed;bottom:8px;left:8px;right:8px;background:var(--bg-card-strong);border:1px solid var(--border-strong);border-radius:12px;padding:10px 12px;color:var(--fg);font-size:12px;z-index:9999;display:flex;gap:8px;align-items:center;';
    banner.innerHTML = '✦ Add Lisa to Home Screen: Share button → "Add to Home Screen"';
    const dismiss = document.createElement('button');
    dismiss.textContent = '✕';
    dismiss.style.cssText = 'background:transparent;border:none;color:var(--fg-2);cursor:pointer;font-size:14px;margin-left:auto;';
    dismiss.onclick = () => {
      localStorage.setItem('lisa.pwa.dismissed', '1');
      banner.remove();
    };
    banner.appendChild(dismiss);
    document.body.appendChild(banner);
  }, 5000);
})();

// ════════════════════════════════════════════════════════════════════
// ── Sidebar live wiring ─────────────────────────────────────────────
//
// Populates the new sidebar blocks introduced by the redesign:
//   - identity card sub-line (born YYYY-MM-DD · NN days)
//   - "currently wanting" paragraph (top actionable desire)
//   - Claude Code monitor card (active sessions)
//   - "last reflection" mini-card (most recent ★ idle message)
// Wires to /api/island/ping + /api/claude/sessions + /api/soul, and
// piggy-backs on the connectEvents() SSE listener above for live
// claude_session_update + idle_message refreshes.
// ════════════════════════════════════════════════════════════════════
(function setupSidebarLive() {
  const sbDesire = document.getElementById('sbDesire');
  const sbClaudeCount = document.getElementById('sbClaudeCount');
  const sbClaudeRows = document.getElementById('sbClaudeRows');
  const sbReflection = document.getElementById('sbReflection');
  const sbReflectionBody = document.getElementById('sbReflectionBody');
  const sbSessionBadge = document.getElementById('sbSessionBadge');
  const identitySub = document.getElementById('identitySub');

  // Active session window matches the watcher's ACTIVE_WINDOW_MS.
  const ACTIVE_WINDOW_MS = 30 * 60 * 1000;

  function relativeTime(iso) {
    const ms = Date.now() - new Date(iso).getTime();
    if (ms < 30_000)   return 'just now';
    if (ms < 60_000)   return Math.round(ms / 1000) + 's';
    if (ms < 3600_000) return Math.round(ms / 60_000) + 'm';
    return Math.round(ms / 3600_000) + 'h';
  }

  function setDesire(text) {
    sbDesire.textContent = text || '(nothing actively pursued)';
  }

  window.updateReflection = function (text) {
    if (!text) { sbReflection.style.display = 'none'; return; }
    sbReflection.style.display = '';
    sbReflectionBody.textContent = '"' + text.replace(/^["“”]+|["“”]+$/g, '').trim() + '"';
  };

  // Compact one-line activity summary — mirrors agent-roster.ts formatActivity
  // (kept inline because this client script is a no-interpolation template
  // literal; the island uses the source-injected shared version).
  function sbActivity(s) {
    const a = s.activity;
    if (!a || typeof a !== 'object') return '';
    if (a.pendingPermission) return '⚠ wants to run ' + a.pendingPermission;
    const bits = [];
    if (a.lastError) bits.push('✗ ' + a.lastError);
    const prog = [];
    if (typeof a.turnCount === 'number' && a.turnCount > 0) prog.push('turn ' + a.turnCount);
    if (a.tokens && (a.tokens.input || a.tokens.output)) {
      const tot = (a.tokens.input || 0) + (a.tokens.output || 0);
      prog.push(tot >= 1000 ? Math.round(tot / 1000) + 'k tok' : tot + ' tok');
    }
    if (prog.length) bits.push(prog.join(' '));
    if (a.lastCommandName) bits.push('$ ' + a.lastCommandName);
    const tool = a.lastTools && a.lastTools.length ? a.lastTools[a.lastTools.length - 1] : '';
    const file = a.filesTouched && a.filesTouched.length ? (String(a.filesTouched[a.filesTouched.length - 1]).split('/').pop() || '') : '';
    if (tool && file) bits.push(tool + ' ' + file);
    else if (tool) bits.push(tool);
    else if (file) bits.push(file);
    return bits.join(' · ');
  }

  // POST a control action to the right agent family (managed|pty), then refresh.
  function agentAction(fam, id, action, body) {
    fetch('/api/agents/' + fam + '/' + encodeURIComponent(id) + '/' + action, {
      method: 'POST',
      headers: body ? { 'content-type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    }).then(function () {
      if (typeof refreshClaudeSessions === 'function') refreshClaudeSessions();
    }).catch(function () {});
  }

  // Show a PTY agent's captured terminal tail in the modal — explicit + on
  // demand (it's content, so it's never folded into the structural roster).
  function ptyOutput(id) {
    fetch('/api/agents/pty/' + encodeURIComponent(id) + '/output').then(function (r) {
      return r.ok ? r.json() : null;
    }).then(function (d) {
      if (!d) return;
      openModal('agent output', '<pre>' + escapeHtml(d.output || '(no output yet)') + '</pre>');
    }).catch(function () {});
  }

  function setClaudeSessions(sessions) {
    const cutoff = Date.now() - ACTIVE_WINDOW_MS;
    const recent = sessions.filter(s => new Date(s.lastMtime).getTime() >= cutoff);
    sbClaudeCount.textContent = String(recent.length);
    // sort: errors first, then waiting, then working, then by mtime
    const rank = { error: 0, waiting: 1, working: 2, unknown: 3 };
    const rows = recent.slice().sort((a, b) => {
      const ra = rank[a.state] ?? 9;
      const rb = rank[b.state] ?? 9;
      if (ra !== rb) return ra - rb;
      return new Date(b.lastMtime).getTime() - new Date(a.lastMtime).getTime();
    }).slice(0, 8);
    while (sbClaudeRows.firstChild) sbClaudeRows.removeChild(sbClaudeRows.firstChild);
    if (rows.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'session-empty';
      empty.textContent = '(idle)';
      sbClaudeRows.appendChild(empty);
      return;
    }
    for (const s of rows) {
      const row = document.createElement('div');
      row.className = 'session-row';
      const pip = document.createElement('div');
      pip.className = 'pip ' + (s.state || 'unknown');
      const name = document.createElement('div');
      name.className = 'name';
      // D4a — agent-kind chip inline before the project; omitted for plain
      // Claude so existing rows read unchanged.
      if (s.agent && s.agent !== 'claude-code') {
        const badge = document.createElement('span');
        badge.className = 'agent-badge';
        badge.textContent = s.agent;
        badge.title = s.agent;
        name.appendChild(badge);
      }
      // Label by git branch when available (more meaningful than a worktree
      // hash), stripping the claude/ prefix; fall back to the project name.
      // (String ops, not a regex — a /\// here would be mangled by the outer
      // template literal that wraps this client script.)
      let label = s.project;
      if (s.activity && s.activity.gitBranch) {
        const br = String(s.activity.gitBranch);
        label = br.indexOf('claude/') === 0 ? br.slice(7) : br;
      }
      name.appendChild(document.createTextNode(label));
      const when = document.createElement('div');
      when.className = 'when';
      when.textContent = relativeTime(s.lastMtime);
      row.appendChild(pip);
      row.appendChild(name);
      row.appendChild(when);
      // Second line: structural activity (turns/tokens/tool·file, ⚠pending, ✗err).
      const actText = sbActivity(s);
      if (actText) {
        const act = document.createElement('div');
        act.className = 'session-act';
        act.textContent = actText;
        act.title = actText;
        row.appendChild(act);
      }
      // Controllable agents get inline controls: managed → approve/deny a pending
      // tool, send a follow-up, cancel; pty (real CLI under a PTY) → send, view
      // terminal output, cancel. Externally-started CLIs have no control channel
      // (no s.controllable) → observe only.
      const fam = s.controllable;
      if (fam) {
        const id = s.sessionId;
        const ctrl = document.createElement('div');
        ctrl.className = 'session-ctrl';
        const pending = fam === 'managed' && s.activity && s.activity.pendingPermission;
        if (pending) {
          const ap = document.createElement('button');
          ap.className = 'mc approve'; ap.textContent = '✓ approve';
          ap.addEventListener('click', function (e) { e.stopPropagation(); agentAction('managed', id, 'approve', { allow: true }); });
          const dn = document.createElement('button');
          dn.className = 'mc deny'; dn.textContent = '✕ deny';
          dn.addEventListener('click', function (e) { e.stopPropagation(); agentAction('managed', id, 'approve', { allow: false }); });
          ctrl.appendChild(ap); ctrl.appendChild(dn);
        } else if (s.state !== 'done') {
          const inp = document.createElement('input');
          inp.className = 'mc-send'; inp.type = 'text'; inp.placeholder = fam === 'pty' ? 'type into the CLI…' : 'send a follow-up…';
          inp.addEventListener('click', function (e) { e.stopPropagation(); });
          inp.addEventListener('keydown', function (e) {
            if (e.key === 'Enter' && inp.value.trim()) { e.preventDefault(); agentAction(fam, id, 'send', { text: inp.value.trim() }); inp.value = ''; }
          });
          ctrl.appendChild(inp);
        }
        if (fam === 'pty') {
          const out = document.createElement('button');
          out.className = 'mc'; out.textContent = '▤'; out.title = 'View terminal output';
          out.addEventListener('click', function (e) { e.stopPropagation(); ptyOutput(id); });
          ctrl.appendChild(out);
        }
        if (s.state !== 'done') {
          const cancel = document.createElement('button');
          cancel.className = 'mc cancel'; cancel.textContent = '⏹'; cancel.title = 'Cancel agent';
          cancel.addEventListener('click', function (e) { e.stopPropagation(); agentAction(fam, id, 'cancel', null); });
          ctrl.appendChild(cancel);
        }
        if (ctrl.childNodes.length) row.appendChild(ctrl);
      }
      // Idle external claude session → adopt it: LISA resumes it under a PTY and
      // drives the continuation (then it shows as a controllable pty row). Only
      // offered for idle sessions; a live one can't be resumed without corrupting
      // its transcript (the server 409s, surfaced in the modal).
      if (s.resumable) {
        const ctrl = document.createElement('div');
        ctrl.className = 'session-ctrl';
        const adopt = document.createElement('button');
        adopt.className = 'mc adopt'; adopt.textContent = '⇲ adopt';
        adopt.title = 'Resume this session under LISA — then send / answer / cancel / view it';
        adopt.addEventListener('click', function (e) {
          e.stopPropagation();
          fetch('/api/agents/pty/start', {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ agent: 'claude', resumeSessionId: s.sessionId, cwd: s.cwd || '' }),
          }).then(function (r) {
            if (!r.ok) { return r.text().then(function (t) { openModal('adopt', '<pre>' + escapeHtml(t) + '</pre>'); }); }
            if (typeof refreshClaudeSessions === 'function') refreshClaudeSessions();
          }).catch(function () {});
        });
        ctrl.appendChild(adopt);
        row.appendChild(ctrl);
      }
      row.title = (s.stateReason ? s.state + ' · ' + s.stateReason : s.state) + ' · ' + s.project + ' · ' + s.sessionId;
      sbClaudeRows.appendChild(row);
    }
  }

  async function refreshPing() {
    try {
      const r = await fetch('/api/island/ping');
      if (!r.ok) return;
      const data = await r.json();
      setDesire(data.current_desire);
      if (data.last_idle_message_text) {
        window.updateReflection(data.last_idle_message_text);
      }
    } catch {}
  }

  // Exposed so the SSE handler above can call this on
  // agent_session_update events without redeclaring the helper. D4a — the
  // multi-agent snapshot (all agents), not just Claude Code.
  window.refreshClaudeSessions = async function () {
    try {
      const r = await fetch('/api/agents/sessions');
      if (!r.ok) return;
      const data = await r.json();
      setClaudeSessions(data.sessions || []);
    } catch {}
  };

  // "Delegate a task" → open a modal to pick the agent kind + write the task.
  // (A roomy dialog beats the cramped 280px sidebar.) managed = LISA-run
  // (controllable); claude/codex = a real CLI under a PTY (needs LISA_PTY_AGENTS=1
  // — a 503/error surfaces inline in the dialog).
  function openDelegateModal() {
    openModal(
      'Delegate a task',
      '<div class="delegate-modal">' +
        '<label class="dm-label">Agent</label>' +
        '<select id="dmKind" class="dm-kind">' +
          '<option value="managed">managed — LISA runs it (approve each step)</option>' +
          '<option value="claude">claude — real CLI under a PTY</option>' +
          '<option value="codex">codex — real CLI under a PTY</option>' +
        '</select>' +
        '<label class="dm-label">Task</label>' +
        '<textarea id="dmTask" class="dm-task" rows="5" placeholder="Describe the task… (⌘/Ctrl+Enter to start)"></textarea>' +
        '<div class="dm-actions"><button id="dmStart" class="dm-start" type="button">Start agent →</button></div>' +
        '<div id="dmErr" class="dm-err"></div>' +
      '</div>'
    );
    const kindEl = document.getElementById('dmKind');
    const taskEl = document.getElementById('dmTask');
    const startEl = document.getElementById('dmStart');
    const errEl = document.getElementById('dmErr');
    if (taskEl) taskEl.focus();
    function submitDelegate() {
      const task = taskEl && taskEl.value.trim();
      if (!task) { if (taskEl) taskEl.focus(); return; }
      const kind = kindEl ? kindEl.value : 'managed';
      const url = kind === 'managed' ? '/api/agents/managed/start' : '/api/agents/pty/start';
      const body = kind === 'managed' ? { task: task } : { agent: kind, task: task };
      if (errEl) errEl.textContent = '';
      if (startEl) { startEl.disabled = true; startEl.textContent = 'Starting…'; }
      fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }).then(function (r) {
        if (!r.ok) {
          return r.text().then(function (t) {
            if (errEl) errEl.textContent = t || ('failed (' + r.status + ')');
            if (startEl) { startEl.disabled = false; startEl.textContent = 'Start agent →'; }
          });
        }
        closeModal();
        if (typeof refreshClaudeSessions === 'function') refreshClaudeSessions();
      }).catch(function () {
        if (errEl) errEl.textContent = 'network error';
        if (startEl) { startEl.disabled = false; startEl.textContent = 'Start agent →'; }
      });
    }
    if (startEl) startEl.addEventListener('click', submitDelegate);
    if (taskEl) taskEl.addEventListener('keydown', function (e) {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); submitDelegate(); }
    });
  }
  const sbDelegateBtn = document.getElementById('sbDelegateBtn');
  if (sbDelegateBtn) sbDelegateBtn.addEventListener('click', openDelegateModal);
  // Exposed so the console Dashboard / Control views reuse the same dialog.
  window.lisaOpenDelegate = openDelegateModal;

  async function refreshIdentity() {
    try {
      const r = await fetch('/api/soul');
      if (!r.ok) return;
      const data = await r.json();
      if (!data.born) return;
      const bornAt = data.summary?.seed?.bornAt;
      if (!bornAt) return;
      const born = new Date(bornAt);
      if (Number.isNaN(born.getTime())) return;
      const days = Math.max(0, Math.floor((Date.now() - born.getTime()) / 86400000));
      const ymd = born.toISOString().slice(0, 10);
      identitySub.textContent = 'born ' + ymd + ' · ' + days + ' day' + (days === 1 ? '' : 's');
    } catch {}
  }

  async function refreshSessionsBadge() {
    try {
      const r = await fetch('/api/sessions');
      if (!r.ok) return;
      const data = await r.json();
      const n = Array.isArray(data.sessions) ? data.sessions.length : 0;
      sbSessionBadge.textContent = String(n);
    } catch {
      // /api/sessions is optional — leave the badge as-is on failure
    }
  }

  // ── Mail card: connect a mailbox + show the daily classified digest ──
  function renderMail(accounts, digest) {
    const body = document.getElementById('sbMailBody');
    const count = document.getElementById('sbMailCount');
    const connectBtn = document.getElementById('sbMailConnectBtn');
    if (!body) return;
    while (body.firstChild) body.removeChild(body.firstChild);
    const hasAccounts = accounts && accounts.length > 0;
    if (connectBtn) connectBtn.textContent = hasAccounts ? '＋ add mailbox' : '＋ connect mailbox';
    if (!hasAccounts) {
      const empty = document.createElement('div');
      empty.className = 'session-empty';
      empty.textContent = '(not connected)';
      body.appendChild(empty);
      if (count) count.textContent = '';
      return;
    }
    const sum = document.createElement('div');
    sum.className = 'mail-summary';
    sum.textContent = digest && digest.summary ? digest.summary : 'No digest yet — sweep to build one.';
    body.appendChild(sum);
    const needs = digest && digest.needsYou ? digest.needsYou : [];
    if (count) count.textContent = needs.length ? ('✦ ' + needs.length) : '';
    for (const i of needs.slice(0, 5)) {
      const row = document.createElement('div');
      row.className = 'mail-row';
      const bang = document.createElement('span');
      bang.className = 'mail-bang' + (i.importance >= 3 ? ' urgent' : '');
      bang.textContent = i.importance >= 3 ? '‼' : '!';
      const subj = document.createElement('span');
      subj.className = 'mail-subj';
      subj.textContent = i.subject || '(no subject)';
      subj.title = (i.from || '') + ' — ' + (i.reason || '');
      row.appendChild(bang);
      row.appendChild(subj);
      body.appendChild(row);
    }
    const sweep = document.createElement('button');
    sweep.className = 'mail-sweep';
    sweep.type = 'button';
    sweep.textContent = 'sweep now';
    sweep.addEventListener('click', function () {
      sweep.disabled = true; sweep.textContent = 'sweeping…';
      fetch('/api/mail/sweep', { method: 'POST' }).then(function () {
        if (window.refreshMail) window.refreshMail();
      }).catch(function () {}).then(function () { sweep.disabled = false; sweep.textContent = 'sweep now'; });
    });
    body.appendChild(sweep);
  }

  window.refreshMail = async function () {
    try {
      const a = await fetch('/api/mail/accounts').then(function (r) { return r.ok ? r.json() : null; });
      const d = await fetch('/api/mail/digest').then(function (r) { return r.ok ? r.json() : null; });
      renderMail(a ? a.accounts : [], d ? d.digest : null);
    } catch (e) {}
  };

  function openMailModal() {
    openModal('Connect a mailbox',
      '<div class="delegate-modal">' +
        '<label class="dm-label">Email</label>' +
        '<input id="mmEmail" class="dm-kind" type="email" placeholder="you@qq.com" autocomplete="off" />' +
        '<label class="dm-label">App-password / authorization code</label>' +
        '<input id="mmPass" class="dm-kind" type="password" placeholder="not your login password" autocomplete="off" />' +
        '<label class="dm-label">IMAP host (optional — auto-detected)</label>' +
        '<input id="mmHost" class="dm-kind" type="text" placeholder="imap.qq.com" autocomplete="off" />' +
        '<div class="dm-actions"><button id="mmStart" class="dm-start" type="button">Connect →</button></div>' +
        '<div id="mmErr" class="dm-err"></div>' +
        '<div class="dm-note">Read-only. Stored locally (0600). Most providers need an app-password, not your login password.</div>' +
      '</div>');
    const emailEl = document.getElementById('mmEmail');
    const passEl = document.getElementById('mmPass');
    const hostEl = document.getElementById('mmHost');
    const startEl = document.getElementById('mmStart');
    const errEl = document.getElementById('mmErr');
    if (emailEl) emailEl.focus();
    function submitMail() {
      const email = emailEl && emailEl.value.trim();
      const pass = passEl && passEl.value;
      if (!email || !pass) { if (errEl) errEl.textContent = 'email + app-password required'; return; }
      const body = { email: email, password: pass };
      if (hostEl && hostEl.value.trim()) body.host = hostEl.value.trim();
      if (errEl) errEl.textContent = '';
      if (startEl) { startEl.disabled = true; startEl.textContent = 'Connecting…'; }
      fetch('/api/mail/connect', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
        .then(function (r) {
          if (!r.ok) { return r.text().then(function (t) { if (errEl) errEl.textContent = t || ('failed (' + r.status + ')'); if (startEl) { startEl.disabled = false; startEl.textContent = 'Connect →'; } }); }
          closeModal();
          if (window.refreshMail) window.refreshMail();
        })
        .catch(function () { if (errEl) errEl.textContent = 'network error'; if (startEl) { startEl.disabled = false; startEl.textContent = 'Connect →'; } });
    }
    if (startEl) startEl.addEventListener('click', submitMail);
    if (passEl) passEl.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); submitMail(); } });
  }
  var sbMailConnectBtn = document.getElementById('sbMailConnectBtn');
  if (sbMailConnectBtn) sbMailConnectBtn.addEventListener('click', openMailModal);

  // Bootstrap + periodic resync. SSE handles the fast-path updates;
  // these timers are belt-and-braces in case the stream silently dies.
  refreshPing();
  window.refreshClaudeSessions();
  window.refreshMail();
  refreshIdentity();
  refreshSessionsBadge();
  setInterval(refreshPing, 30_000);
  // Resolve refreshClaudeSessions at call time (arrow), not now: setupConsole
  // later wraps window.refreshClaudeSessions to re-render the active console
  // view + nav count, and the wrapper must win on this 60s tick too.
  setInterval(() => window.refreshClaudeSessions(), 60_000);
  setInterval(window.refreshMail, 5 * 60_000);
  setInterval(refreshSessionsBadge, 5 * 60_000);
})();

// ════════════════════════════════════════════════════════════════════
// Console view-switcher — adds Dashboard / Control / Reve / Sense /
// Memory views beside the default Chat. Purely additive: the chat
// pipeline and every existing id stay untouched. Each non-chat view is
// built lazily from the real endpoints on first activation, and the live
// agent stream (refreshClaudeSessions) is wrapped to re-render the active
// console view. No backticks / no template placeholders in this block.
// ════════════════════════════════════════════════════════════════════
(function setupConsole() {
  var navList = document.getElementById('navList');
  if (!navList) return;
  var views = {
    chat: document.getElementById('viewChat'),
    dashboard: document.getElementById('viewDashboard'),
    control: document.getElementById('viewControl'),
    reve: document.getElementById('viewReve'),
    sense: document.getElementById('viewSense'),
    memory: document.getElementById('viewMemory'),
  };
  var loaded = {};
  var active = 'chat';
  var proactiveOn = true;

  function esc(s) { return (typeof escapeHtml === 'function') ? escapeHtml(s) : String(s == null ? '' : s); }
  function getJSON(u) { return fetch(u).then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; }); }

  function statusClass(state) {
    if (state === 'working') return 'working';
    if (state === 'waiting') return 'waiting';
    if (state === 'error') return 'error';
    if (state === 'done' || state === 'idle') return 'done';
    return '';
  }
  function statusLabel(state) {
    if (state === 'working') return 'Working';
    if (state === 'waiting') return 'Waiting';
    if (state === 'error') return 'Error';
    if (state === 'done') return 'Done';
    if (state === 'idle') return 'Idle';
    return 'Unknown';
  }
  // Compact activity line (local copy of the sidebar helper — kept decoupled).
  function actLine(s) {
    var a = s && s.activity;
    if (!a || typeof a !== 'object') return '';
    if (a.pendingPermission) return 'wants to run ' + a.pendingPermission;
    var bits = [];
    if (a.lastError) bits.push(a.lastError);
    if (typeof a.turnCount === 'number' && a.turnCount > 0) bits.push('turn ' + a.turnCount);
    if (a.tokens && (a.tokens.input || a.tokens.output)) {
      var tot = (a.tokens.input || 0) + (a.tokens.output || 0);
      bits.push(tot >= 1000 ? Math.round(tot / 1000) + 'k tok' : tot + ' tok');
    }
    var tool = a.lastTools && a.lastTools.length ? a.lastTools[a.lastTools.length - 1] : '';
    var file = a.filesTouched && a.filesTouched.length ? (String(a.filesTouched[a.filesTouched.length - 1]).split('/').pop() || '') : '';
    if (tool && file) bits.push(tool + ' ' + file);
    else if (tool) bits.push(tool);
    else if (file) bits.push(file);
    return bits.join(' · ');
  }
  function updateAgentCount(n) {
    var c = document.getElementById('navAgentCount');
    if (c) c.textContent = String(n);
  }

  // ── view switching ──────────────────────────────────────────────
  function loadView(name) {
    if (loaded[name]) return;
    loaded[name] = true;
    if (name === 'dashboard') loadDashboard();
    else if (name === 'control') loadControl();
    else if (name === 'reve') loadReve();
    else if (name === 'sense') loadSense();
    else if (name === 'memory') loadMemory();
  }
  function showView(name) {
    if (!views[name]) name = 'chat';
    active = name;
    for (var k in views) { if (views[k]) views[k].classList.toggle('active', k === name); }
    var items = navList.querySelectorAll('.nav-item');
    for (var i = 0; i < items.length; i++) {
      items[i].classList.toggle('active', items[i].getAttribute('data-view') === name);
    }
    if (name !== 'chat') loadView(name);
    else { try { document.getElementById('input').focus(); } catch (e) {} }
    try { history.replaceState(null, '', name === 'chat' ? location.pathname + location.search : '#' + name); } catch (e) {}
  }
  navList.addEventListener('click', function (e) {
    var btn = e.target && e.target.closest ? e.target.closest('.nav-item') : null;
    if (btn && btn.getAttribute('data-view')) showView(btn.getAttribute('data-view'));
  });
  window.lisaShowView = showView;

  // ── proactive toggle ────────────────────────────────────────────
  var ptEl = document.getElementById('proactiveToggle');
  function setProactiveUI(on) {
    proactiveOn = !!on;
    if (ptEl) { ptEl.classList.toggle('on', proactiveOn); ptEl.setAttribute('aria-checked', proactiveOn ? 'true' : 'false'); }
    var pp = document.getElementById('ppPanel');
    if (pp) {
      pp.classList.toggle('off', !proactiveOn);
      var st = document.getElementById('ppState');
      if (st) st.textContent = proactiveOn ? 'On · watching' : 'Paused';
      var sd = document.getElementById('ppDesc');
      if (sd) sd.textContent = proactiveOn ? 'Lisa watches your agents, tasks and signals for blockers and next steps.' : 'Resting — she will only act when you talk to her.';
    }
  }
  function syncProactive() {
    getJSON('/api/autonomy/state').then(function (s) { if (s && typeof s.enabled === 'boolean') setProactiveUI(s.enabled); });
  }
  function toggleProactive() {
    var on = !proactiveOn;
    setProactiveUI(on);
    fetch('/api/autonomy/state', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: on }) })
      .then(function (r) { return r && r.ok ? r.json() : null; })
      .then(function (j) { if (j && typeof j.enabled === 'boolean') setProactiveUI(j.enabled); else setProactiveUI(!on); })
      .catch(function () { setProactiveUI(!on); });
  }
  if (ptEl) {
    ptEl.addEventListener('click', toggleProactive);
    ptEl.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleProactive(); } });
  }
  syncProactive();

  // ── Dashboard ───────────────────────────────────────────────────
  function agentCardHTML(s) {
    var cls = statusClass(s.state);
    var act = actLine(s);
    return '<div class="ac">' +
      '<div class="ac-top"><span>' + esc(s.agent || 'agent') + '</span><span class="ac-status ' + cls + '">' + esc(statusLabel(s.state)) + '</span></div>' +
      '<div class="ac-title">' + esc(s.project || s.agent || 'agent') + '</div>' +
      '<div class="ac-desc">' + (act ? esc(act) : 'no recent activity') + '</div>' +
      '</div>';
  }
  function taskCardHTML(d) {
    return '<div class="ac">' +
      '<div class="ac-top"><span>' + esc(d.agent || 'dispatch') + '</span><span class="ac-status ' + (d.alive ? 'working' : 'done') + '">' + (d.alive ? 'Running' : 'Done') + '</span></div>' +
      '<div class="ac-title">' + esc(String(d.task || 'task').slice(0, 80)) + '</div>' +
      '<div class="ac-meta">' + esc(d.cwd ? String(d.cwd).split('/').pop() : 'dispatch') + '</div>' +
      '</div>';
  }
  function loadDashboard() {
    views.dashboard.innerHTML =
      '<div class="view-head"><div><h2>Dashboard</h2><div class="vh-sub">Operations at a glance</div></div>' +
      '<button class="view-act" id="dashDelegate">+ Delegate a task</button></div>' +
      '<div class="view-scroll" id="dashScroll"><div class="view-empty">loading…</div></div>';
    var del = document.getElementById('dashDelegate');
    if (del) del.addEventListener('click', function () { if (typeof window.lisaOpenDelegate === 'function') window.lisaOpenDelegate(); });
    renderDashboard();
  }
  function renderDashboard() {
    var scroll = document.getElementById('dashScroll');
    if (!scroll) return;
    Promise.all([
      getJSON('/api/agents/sessions'), getJSON('/api/dispatch/list'),
      getJSON('/api/sense/recent'), getJSON('/api/island/ping'),
    ]).then(function (res) {
      var sessions = (res[0] && res[0].sessions) || [];
      var dispatches = (res[1] && res[1].dispatches) || [];
      var events = (res[2] && res[2].events) || [];
      var ping = res[3] || {};
      updateAgentCount(sessions.length);
      var aliveTasks = dispatches.filter(function (d) { return d.alive; }).length;
      var waiting = sessions.filter(function (s) { return s.state === 'waiting'; }).length;
      var errored = sessions.filter(function (s) { return s.state === 'error'; }).length;
      var desire = ping.current_desire || '';
      var html = '';
      html += '<div class="stat-bar">' +
        '<div class="stat"><div class="n">' + sessions.length + '</div><div class="k">Agents</div></div>' +
        '<div class="stat"><div class="n">' + aliveTasks + '</div><div class="k">Tasks</div></div>' +
        '<div class="stat"><div class="n">' + dispatches.length + '</div><div class="k">Dispatched</div></div>' +
        '<div class="stat"><div class="n">' + events.length + '</div><div class="k">Signals</div></div></div>';
      html += '<div class="proactive-panel' + (proactiveOn ? '' : ' off') + '" id="ppPanel"><div class="pp-head"><span class="pp-dot"></span>' +
        '<div><div class="pp-title">Proactive mode <b id="ppState">' + (proactiveOn ? 'On · watching' : 'Paused') + '</b></div>' +
        '<div class="pp-desc" id="ppDesc">' + (proactiveOn ? 'Lisa watches your agents, tasks and signals for blockers and next steps.' : 'Resting — she will only act when you talk to her.') + '</div></div></div>' +
        '<div class="pp-tags"><span class="pp-tag">' + sessions.length + ' agents</span><span class="pp-tag">' + aliveTasks + ' tasks</span>' +
        (waiting ? '<span class="pp-tag warn">' + waiting + ' waiting</span>' : '') +
        (errored ? '<span class="pp-tag warn">' + errored + ' errored</span>' : '') +
        '<span class="pp-tag">owner-routed</span><span class="pp-tag">quiet on waits</span></div></div>';
      html += '<div class="view-sec-label">Focus · currently pursuing</div>';
      if (desire) {
        html += '<div class="focus-card"><div class="fc-top"><div>' +
          '<div class="fc-title">' + esc(desire) + '</div>' +
          '<div class="fc-desc">A self-driven desire Lisa is pursuing on her own time.</div></div>' +
          '<span class="fc-pill">Active</span></div>' +
          '<div class="fc-meta"><span>self-driven</span><span>' + sessions.length + ' agents live</span></div></div>';
      } else {
        html += '<div class="focus-card"><div class="fc-desc">Nothing actively pursued right now.</div></div>';
      }
      html += '<div class="view-sec-label">Agents &amp; tasks</div>';
      var cards = sessions.map(agentCardHTML).concat(dispatches.slice(0, 6).map(taskCardHTML));
      html += cards.length ? '<div class="card-scroll">' + cards.join('') + '</div>'
                           : '<div class="view-empty">No active agents or tasks. Delegate one to get started.</div>';
      scroll.innerHTML = html;
    });
  }

  // ── Control ─────────────────────────────────────────────────────
  function controlRowHTML(s) {
    var act = actLine(s);
    var fam = s.controllable === 'pty' ? 'pty' : (s.controllable === 'managed' ? 'managed' : '');
    var pend = s.activity && s.activity.pendingPermission;
    var id = esc(s.sessionId);
    var ctrl = '';
    if (fam && pend) {
      ctrl += '<button class="mc approve" data-fam="' + fam + '" data-id="' + id + '" data-act="approve">approve</button>';
      ctrl += '<button class="mc deny" data-fam="' + fam + '" data-id="' + id + '" data-act="deny">deny</button>';
    }
    if (fam) ctrl += '<button class="mc cancel" data-fam="' + fam + '" data-id="' + id + '" data-act="cancel">cancel</button>';
    if (fam === 'pty') ctrl += '<button class="mc" data-id="' + id + '" data-act="output">output</button>';
    var badge = (s.agent && s.agent !== 'claude-code') ? '<span class="agent-badge">' + esc(s.agent) + '</span>' : '';
    return '<div class="session-row">' +
      '<div class="pip ' + (s.state || 'unknown') + '"></div>' +
      '<div class="name">' + badge + esc(s.project || s.agent || 'agent') + '</div>' +
      '<div class="when">' + (s.controllable ? esc(s.controllable) : esc(statusLabel(s.state))) + '</div>' +
      (act ? '<div class="session-act">' + esc(act) + '</div>' : '') +
      (ctrl ? '<div class="session-ctrl">' + ctrl + '</div>' : '') +
      '</div>';
  }
  function controlAction(fam, id, action) {
    return fetch('/api/agents/' + fam + '/' + encodeURIComponent(id) + '/' + action, { method: 'POST' })
      .then(function (r) { if (!r.ok) return r.text().then(function (t) { throw new Error(String(r.status) + (t ? ' ' + t : '')); }); });
  }
  function ctrlPtyOutput(id) {
    getJSON('/api/agents/pty/' + encodeURIComponent(id) + '/output').then(function (d) {
      if (typeof openModal === 'function') openModal('agent output', '<pre>' + esc(d && d.output ? d.output : '(no output yet)') + '</pre>');
    });
  }
  function loadControl() {
    views.control.innerHTML =
      '<div class="view-head"><div><h2>Control</h2><div class="vh-sub">Live agents &amp; control plane</div></div>' +
      '<button class="view-act" id="ctrlDelegate">+ Delegate a task</button></div>' +
      '<div class="view-scroll" id="ctrlScroll"><div class="view-empty">loading…</div></div>';
    var del = document.getElementById('ctrlDelegate');
    if (del) del.addEventListener('click', function () { if (typeof window.lisaOpenDelegate === 'function') window.lisaOpenDelegate(); });
    renderControl();
  }
  function renderControl() {
    var scroll = document.getElementById('ctrlScroll');
    if (!scroll) return;
    Promise.all([getJSON('/api/agents/sessions'), getJSON('/api/control/policy')]).then(function (res) {
      var sessions = (res[0] && res[0].sessions) || [];
      var policy = res[1] || {};
      updateAgentCount(sessions.length);
      var html = '<div class="pp-tags" style="margin-bottom:14px">' +
        '<span class="pp-tag">remote control: ' + (policy.remoteControl ? 'on' : 'off') + '</span>' +
        '<span class="pp-tag">adopt external: ' + (policy.remoteAdoptExternal ? 'on' : 'off') + '</span></div>';
      if (!sessions.length) { scroll.innerHTML = html + '<div class="view-empty">No agents running. Delegate a task to start one.</div>'; return; }
      sessions.forEach(function (s) { html += controlRowHTML(s); });
      scroll.innerHTML = html;
      var btns = scroll.querySelectorAll('[data-act]');
      for (var i = 0; i < btns.length; i++) {
        btns[i].addEventListener('click', function () {
          var act = this.getAttribute('data-act');
          var fam = this.getAttribute('data-fam');
          var id = this.getAttribute('data-id');
          if (act === 'output') { ctrlPtyOutput(id); return; }
          controlAction(fam, id, act).then(function () { renderControl(); }).catch(function (err) {
            scroll.insertAdjacentHTML('afterbegin', '<div class="view-empty" style="color:var(--err-color)">' + esc(err.message) + '</div>');
          });
        });
      }
    });
  }

  // ── Reve ────────────────────────────────────────────────────────
  function loadReve() {
    views.reve.innerHTML =
      '<div class="view-head"><div><h2>Rêve</h2><div class="vh-sub">Reflections from her own time</div></div>' +
      '<select class="v-sel" id="reveWindow"><option value="120">last 2h</option><option value="480">last 8h</option><option value="1440">last 24h</option></select></div>' +
      '<div class="view-scroll" id="reveScroll"><div class="view-empty">loading…</div></div>';
    var sel = document.getElementById('reveWindow');
    if (sel) sel.addEventListener('change', function () { renderReve(sel.value); });
    renderReve('120');
  }
  function renderReve(mins) {
    var scroll = document.getElementById('reveScroll');
    if (!scroll) return;
    Promise.all([getJSON('/api/island/ping'), getJSON('/api/agents/recap?sinceMinutes=' + encodeURIComponent(mins))]).then(function (res) {
      var ping = res[0] || {}; var recap = res[1] || {};
      var html = '';
      if (ping.last_idle_message_text) html += '<div class="v-card"><h3>While you were away</h3><div style="font-size:13px;color:var(--fg);line-height:1.55">' + esc(ping.last_idle_message_text) + '</div></div>';
      if (ping.current_desire) html += '<div class="v-card"><h3>Currently pursuing</h3><div style="font-size:13px;color:var(--fg)">' + esc(ping.current_desire) + '</div></div>';
      html += '<div class="v-card"><h3>Recap</h3><pre class="v-pre">' + esc(recap.text || 'No activity in this window.') + '</pre></div>';
      scroll.innerHTML = html;
    });
  }

  // ── Sense ───────────────────────────────────────────────────────
  function loadSense() {
    views.sense.innerHTML =
      '<div class="view-head"><div><h2>Sense</h2><div class="vh-sub">Ambient signals Lisa may see</div></div></div>' +
      '<div class="view-scroll" id="senseScroll"><div class="view-empty">loading…</div></div>';
    renderSense();
  }
  function renderSense() {
    var scroll = document.getElementById('senseScroll');
    if (!scroll) return;
    Promise.all([getJSON('/api/consent'), getJSON('/api/sense/recent')]).then(function (res) {
      var grants = (res[0] && res[0].grants) || [];
      var events = (res[1] && res[1].events) || [];
      var html = '<div class="view-sec-label">Consent</div><div class="v-card">';
      if (!grants.length) html += '<div class="view-empty" style="padding:6px 0">No signals configured.</div>';
      grants.forEach(function (g) {
        html += '<div class="v-row"><div class="v-main"><div class="v-name">' + esc(g.signal) + '</div>' +
          (g.description ? '<div class="v-sub">' + esc(g.description) + '</div>' : '') + '</div>' +
          '<button class="v-toggle' + (g.granted ? ' on' : '') + '" data-signal="' + esc(g.signal) + '" data-on="' + (g.granted ? '1' : '0') + '">' + (g.granted ? 'on' : 'off') + '</button></div>';
      });
      html += '</div><div class="view-sec-label">Recently sensed</div><div class="v-card">';
      if (!events.length) html += '<div class="view-empty" style="padding:6px 0">Nothing captured.</div>';
      events.slice(0, 30).forEach(function (e) {
        html += '<div class="v-row"><div class="v-main"><div class="v-name" style="font-weight:400">' + esc(e.summary || '') + '</div>' +
          '<div class="v-sub">' + esc([e.signal, e.kind, e.app].filter(Boolean).join(' · ')) + '</div></div></div>';
      });
      html += '</div>';
      scroll.innerHTML = html;
      var tgs = scroll.querySelectorAll('.v-toggle');
      for (var i = 0; i < tgs.length; i++) {
        tgs[i].addEventListener('click', function () {
          var sig = this.getAttribute('data-signal');
          var on = this.getAttribute('data-on') === '1';
          fetch(on ? '/api/consent/revoke' : '/api/consent/grant', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ signal: sig }) })
            .then(function () { renderSense(); }).catch(function () {});
        });
      }
    });
  }

  // ── Memory (launchers for the existing modal panels) ────────────
  function memBtn(key, ico, title, sub) {
    return '<button class="mem-btn" data-mem="' + key + '"><span class="mem-ico">' + ico + '</span>' + title + '<span class="mem-sub">' + sub + '</span></button>';
  }
  function loadMemory() {
    views.memory.innerHTML =
      '<div class="view-head"><div><h2>Memory</h2><div class="vh-sub">Soul · skills · memory · tools</div></div></div>' +
      '<div class="view-scroll">' +
      memBtn('soul', '★', 'Soul', 'identity · values · emotions') +
      memBtn('skills', '✦', 'Skills', 'saved workflows') +
      memBtn('memory', '▤', 'Memory', 'USER.md · MEMORY.md') +
      memBtn('tools', '⚒', 'Tools', 'capabilities') +
      memBtn('plans', '◆', 'Coding plans', 'subscription CLIs') +
      '</div>';
    var mbs = views.memory.querySelectorAll('.mem-btn');
    for (var i = 0; i < mbs.length; i++) {
      mbs[i].addEventListener('click', function () {
        var w = this.getAttribute('data-mem');
        if (w === 'soul' && typeof showSoul === 'function') showSoul();
        else if (w === 'skills' && typeof showSkills === 'function') showSkills();
        else if (w === 'memory' && typeof showMemory === 'function') showMemory();
        else if (w === 'tools' && typeof showTools === 'function') showTools();
        else if (w === 'plans' && typeof showPlans === 'function') showPlans();
      });
    }
  }

  // ── live refresh: wrap the agent-session refresh so the active console
  //    view + the Control nav count update on SSE agent_session_update.
  var origRefresh = window.refreshClaudeSessions;
  window.refreshClaudeSessions = function () {
    var r = origRefresh ? origRefresh.apply(this, arguments) : undefined;
    Promise.resolve(r).then(function () {
      if (active === 'dashboard') renderDashboard();
      else if (active === 'control') renderControl();
      else getJSON('/api/agents/sessions').then(function (d) { updateAgentCount((d && d.sessions) ? d.sessions.length : 0); });
    });
    return r;
  };
  getJSON('/api/agents/sessions').then(function (d) { updateAgentCount((d && d.sessions) ? d.sessions.length : 0); });

  // ── init: honor a deep-link hash, else default to chat ──────────
  var initial = (location.hash || '').replace('#', '');
  showView(views[initial] ? initial : 'chat');
  window.addEventListener('hashchange', function () {
    var h = (location.hash || '').replace('#', '');
    if (views[h] && h !== active) showView(h);
  });
})();`;

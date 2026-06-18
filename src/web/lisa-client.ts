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

export const MAIN_CLIENT_JS = `const log = document.getElementById('log');
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
  const btn = document.getElementById('captureBtn');
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
// 📷 capture button → interactive crosshair screenshot into the composer.
const captureBtnEl = document.getElementById('captureBtn');
if (captureBtnEl) {
  captureBtnEl.addEventListener('click', () => { void window.lisaCaptureAndAttach('interactive'); });
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

const attachBtnEl = document.getElementById('attachBtn');
if (attachBtnEl) {
  attachBtnEl.addEventListener('click', (ev) => {
    // Don't preventDefault — that cancels the implicit label-forward
    // and removes the redundant gesture path. Letting both fire is
    // fine because <input type=file>.click() fires the picker only
    // once per user gesture.
    console.log('[attach] click forwarded to fileInput');
    try {
      fileInput.click();
    } catch (err) {
      console.error('[attach] fileInput.click failed:', err);
    }
  });
}

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
  let cfg;
  try {
    cfg = await fetch('/api/config/status').then(r => r.json());
  } catch {
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
    }).slice(0, 5);
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

  // Bootstrap + periodic resync. SSE handles the fast-path updates;
  // these timers are belt-and-braces in case the stream silently dies.
  refreshPing();
  window.refreshClaudeSessions();
  refreshIdentity();
  refreshSessionsBadge();
  setInterval(refreshPing, 30_000);
  setInterval(window.refreshClaudeSessions, 60_000);
  setInterval(refreshSessionsBadge, 5 * 60_000);
})();`;

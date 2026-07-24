/**
 * LISA Cloud login page (PLAN_ACCOUNTS_BILLING B1; PLAN_AUTH_OTP_GOOGLE A2) —
 * served with a 401 status to unauthenticated *browser* requests on the cloud
 * edition, instead of the bare JSON error (API callers still get JSON; the
 * Accept header decides).
 *
 * The default path is a **mailed code**: type an address, get six digits, and
 * you're in — registering and signing in are the same act, because reading the
 * mail is the proof. Passwords still work behind "Use a password instead"
 * (App Review's demo account needs them), and Sign in with Apple sits on top
 * when the instance has a Services ID configured.
 *
 * The server pins the session cookie on success; a reload lands in the authed
 * island UI.
 *
 * NOTE: one template literal — NO backticks and no "${" inside (see the
 * island.ts trap). String concatenation only.
 */
export const LOGIN_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>LISA Cloud — Sign in</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; margin: 0; }
  body {
    min-height: 100vh; display: grid; place-items: center;
    background: #0b0e13; color: #e6e9ef;
    font: 16px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  }
  .card {
    width: min(92vw, 380px); padding: 32px 28px; border-radius: 16px;
    background: #12161e; border: 1px solid #232a36;
  }
  h1 { font-size: 22px; margin-bottom: 4px; }
  p.sub { color: #8a93a5; font-size: 14px; margin-bottom: 22px; }
  label { display: block; font-size: 13px; color: #8a93a5; margin: 12px 0 4px; }
  input {
    width: 100%; padding: 10px 12px; border-radius: 10px; font-size: 16px;
    background: #0b0e13; color: #e6e9ef; border: 1px solid #2a3342; outline: none;
  }
  input:focus { border-color: #5b8cff; }
  button {
    width: 100%; margin-top: 18px; padding: 12px; border: 0; border-radius: 10px;
    background: #5b8cff; color: #fff; font-size: 16px; font-weight: 600; cursor: pointer;
  }
  button.secondary { background: transparent; color: #8a93a5; font-weight: 500; margin-top: 8px; }
  button:disabled { opacity: .5; cursor: default; }
  input#code { letter-spacing: .35em; font-size: 20px; text-align: center; }
  .note { color: #7fd6a3; font-size: 13px; margin-top: 12px; min-height: 1.2em; }
  [hidden] { display: none !important; }
  #apple-wrap { display: none; margin-bottom: 18px; }
  #apple-btn {
    width: 100%; padding: 12px; border: 0; border-radius: 10px; cursor: pointer;
    background: #fff; color: #000; font-size: 16px; font-weight: 600;
  }
  .divider { display: none; align-items: center; gap: 10px; color: #5d6575; font-size: 12px; margin-bottom: 4px; }
  .divider::before, .divider::after { content: ""; flex: 1; height: 1px; background: #232a36; }
  .err { color: #ff7a7a; font-size: 13px; margin-top: 12px; min-height: 1.2em; }
  .hint { color: #5d6575; font-size: 12px; margin-top: 18px; }
</style>
</head>
<body>
<div class="card">
  <h1>LISA Cloud</h1>
  <p class="sub">Sign in to reach your Lisa. A free usage allowance refreshes every 12 hours.</p>
  <div id="apple-wrap">
    <button id="apple-btn" type="button"> Sign in with Apple</button>
  </div>
  <div class="divider" id="divider">or use email</div>
  <form id="f">
    <label for="email">Email</label>
    <input id="email" type="email" autocomplete="username" required>
    <div id="code-row" hidden>
      <label for="code">Sign-in code</label>
      <input id="code" type="text" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="000000">
    </div>
    <div id="pw-row" hidden>
      <label for="pw">Password</label>
      <input id="pw" type="password" autocomplete="current-password" minlength="8">
    </div>
    <button id="primary" type="submit">Email me a code</button>
    <button id="resend" type="button" class="secondary" hidden>Send another code</button>
    <button id="register" type="button" class="secondary" hidden>Create an account</button>
    <button id="mode" type="button" class="secondary">Use a password instead</button>
    <div class="err" id="err"></div>
    <div class="note" id="note"></div>
  </form>
  <div class="hint">Self-hosted with a shared token? Open this page as /?token=&lt;your token&gt;.</div>
</div>
<script>
  const f = document.getElementById("f");
  const err = document.getElementById("err");
  const note = document.getElementById("note");
  const email = document.getElementById("email");
  const pw = document.getElementById("pw");
  const codeInput = document.getElementById("code");
  const codeRow = document.getElementById("code-row");
  const pwRow = document.getElementById("pw-row");
  const primary = document.getElementById("primary");
  const resendBtn = document.getElementById("resend");
  const registerBtn = document.getElementById("register");
  const modeBtn = document.getElementById("mode");
  const MSG = {
    bad_credentials: "Wrong email or password.",
    email_taken: "That email already has an account — sign in instead.",
    weak_password: "Use at least 8 characters.",
    invalid_email: "That doesn't look like an email address.",
    throttled: "Too many attempts — wait 15 minutes.",
    rate_limited: "Too many attempts from this network — try again later.",
    otp_cooldown: "A code just went out — check your inbox.",
    otp_daily_cap: "Too many codes for this address today. Try again tomorrow or use a password.",
    bad_code: "That code isn't right.",
    expired: "That code expired — send another.",
    no_pending: "No code outstanding — send one first.",
    too_many_attempts: "Too many wrong codes. Send a fresh one.",
  };

  // "code" (default) or "password"; within code mode, stage "email" then "code".
  let mode = "code";
  let stage = "email";
  let busy = false;

  function render() {
    codeRow.hidden = !(mode === "code" && stage === "code");
    pwRow.hidden = mode !== "password";
    resendBtn.hidden = !(mode === "code" && stage === "code");
    registerBtn.hidden = mode !== "password";
    primary.textContent =
      mode === "password" ? "Sign in" : stage === "code" ? "Sign in" : "Email me a code";
    modeBtn.textContent = mode === "password" ? "Email me a code instead" : "Use a password instead";
    pw.required = mode === "password";
  }

  function say(message, isError) {
    err.textContent = isError ? message : "";
    note.textContent = isError ? "" : message;
  }

  async function post(path, body) {
    const res = await fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }).catch(() => null);
    if (!res) return { netFail: true };
    if (res.ok) {
      let data = {};
      try { data = await res.json(); } catch {}
      return { ok: true, data: data };
    }
    let code = "";
    try { code = (await res.json()).error || ""; } catch {}
    return { ok: false, code: code, status: res.status };
  }

  function fail(r) {
    if (r.netFail) { say("Network error — try again.", true); return; }
    say(MSG[r.code] || ("Sign-in failed (" + r.status + ")."), true);
  }

  async function run(fn) {
    if (busy) return;
    busy = true;
    primary.disabled = true;
    resendBtn.disabled = true;
    try { await fn(); } finally {
      busy = false;
      primary.disabled = false;
      resendBtn.disabled = false;
    }
  }

  async function requestCode(isResend) {
    say("", false);
    const r = await post("/api/auth/otp/request", { email: email.value.trim() });
    if (!r.ok) { fail(r); return; }
    stage = "code";
    render();
    codeInput.value = "";
    codeInput.focus();
    say(
      r.data.sent
        ? "We sent a 6-digit code to " + email.value.trim() + ". It expires in 10 minutes."
        : "Couldn't send the code right now — try again in a moment.",
      !r.data.sent,
    );
  }

  async function submitCode() {
    say("", false);
    const r = await post("/api/auth/otp/verify", {
      email: email.value.trim(),
      code: codeInput.value.trim(),
    });
    if (r.ok) { location.replace("/"); return; }
    fail(r);
    // A burned or expired code can't be retried — put them back on "send one".
    if (r.code === "too_many_attempts" || r.code === "expired" || r.code === "no_pending") {
      stage = "email";
      render();
    }
  }

  async function password(path) {
    say("", false);
    const r = await post(path, { email: email.value.trim(), password: pw.value });
    if (r.ok) { location.replace("/"); return; }
    fail(r);
  }

  f.addEventListener("submit", (e) => {
    e.preventDefault();
    if (mode === "password") { if (f.reportValidity()) run(() => password("/api/auth/login")); return; }
    if (stage === "email") { if (f.reportValidity()) run(() => requestCode(false)); return; }
    run(submitCode);
  });
  resendBtn.addEventListener("click", () => run(() => requestCode(true)));
  registerBtn.addEventListener("click", () => {
    if (f.reportValidity()) run(() => password("/api/auth/register"));
  });
  modeBtn.addEventListener("click", () => {
    mode = mode === "password" ? "code" : "password";
    stage = "email";
    say("", false);
    render();
  });
  // Editing the address invalidates an outstanding code — go back a step.
  email.addEventListener("input", () => {
    if (mode === "code" && stage === "code") { stage = "email"; say("", false); render(); }
  });
  render();

  // Fresh random nonce, or null when this context can't hash one (#261).
  function mintNonce() {
    if (!window.crypto || !window.crypto.subtle || !window.crypto.getRandomValues) return null;
    const b = new Uint8Array(16);
    window.crypto.getRandomValues(b);
    return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  }
  async function sha256hex(s) {
    const d = await window.crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
    return Array.from(new Uint8Array(d), (x) => x.toString(16).padStart(2, "0")).join("");
  }

  // Sign in with Apple on the web (B8b): drawn only when the instance has a
  // Services ID configured (GET /api/auth/config). Apple's JS runs a popup and
  // hands back an id_token; the server verifies it against the web audience.
  fetch("/api/auth/config").then((r) => r.json()).then((cfg) => {
    if (!cfg || !cfg.appleWeb || !cfg.appleWeb.servicesId) return;
    const s = document.createElement("script");
    s.src = "https://appleid.cdn-apple.com/appleauth/static/jsapi/appleid/1/en_US/appleid.auth.js";
    s.onload = () => {
      const appleCfg = {
        clientId: cfg.appleWeb.servicesId,
        scope: "name email",
        redirectURI: location.origin,
        usePopup: true,
      };
      window.AppleID.auth.init(appleCfg);
      document.getElementById("apple-wrap").style.display = "block";
      document.getElementById("divider").style.display = "flex";
      document.getElementById("apple-btn").addEventListener("click", async () => {
        err.textContent = "";
        try {
          // Per-attempt nonce (#261): Apple echoes sha256(raw) into the token's
          // nonce claim, so the server can tell a token minted for THIS click
          // from a replayed one. crypto.subtle needs a secure context — over
          // plain http we just skip it (the server treats it as optional).
          const rawNonce = mintNonce();
          if (rawNonce) window.AppleID.auth.init({ ...appleCfg, nonce: await sha256hex(rawNonce) });
          const auth = await window.AppleID.auth.signIn();
          const idToken = auth && auth.authorization && auth.authorization.id_token;
          if (!idToken) { err.textContent = "Apple didn't return a token."; return; }
          const res = await fetch("/api/auth/apple", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ identityToken: idToken, client: "web", ...(rawNonce ? { nonce: rawNonce } : {}) }),
          });
          if (res.ok) { location.replace("/"); return; }
          err.textContent = "Apple sign-in was rejected (" + res.status + ").";
        } catch (e) {
          // popup_closed_by_user etc. — silent unless a real failure
          if (e && e.error && e.error !== "popup_closed_by_user") {
            err.textContent = "Apple sign-in failed.";
          }
        }
      });
    };
    document.head.appendChild(s);
  }).catch(() => {});
</script>
</body>
</html>
`;

/**
 * LISA Cloud login page (PLAN_ACCOUNTS_BILLING B1) — served with a 401 status to
 * unauthenticated *browser* requests on the cloud edition, instead of the bare
 * JSON error (API callers still get JSON; the Accept header decides).
 *
 * Email + password only for now: Sign in with Apple on the WEB needs a Services
 * ID + domain verification in the Apple portal (JS flow) — tracked for B7. The
 * page posts to /api/auth/login | /register; the server pins the session cookie
 * and a reload lands in the authed island UI.
 *
 * NOTE: one template literal — NO backticks inside (see the island.ts trap).
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
  #apple-wrap { display: none; margin-bottom: 18px; }
  #apple-btn {
    width: 100%; padding: 12px; border: 0; border-radius: 10px; cursor: pointer;
    background: #fff; color: #000; font-size: 16px; font-weight: 600;
  }
  .divider { display: none; align-items: center; gap: 10px; color: #5d6575; font-size: 12px; margin-bottom: 4px; }
  .divider::before, .divider::after { content: ""; flex: 1; height: 1px; background: #232a36; }
  .err { color: #ff7a7a; font-size: 13px; margin-top: 12px; min-height: 1.2em; }
  .ok { color: #7ad48a; font-size: 13px; min-height: 1.2em; }
  .hint { color: #5d6575; font-size: 12px; margin-top: 18px; }
  .hint a { color: #8a93a5; text-decoration: none; }
  .hint a:hover { color: #e6e9ef; }
</style>
</head>
<body>
<div class="card">
  <h1>LISA Cloud</h1>
  <p class="sub">Sign in to reach your Lisa. A free usage allowance refreshes every 12 hours.</p>
  <div id="apple-wrap">
    <button id="apple-btn" type="button"> Sign in with Apple</button>
  </div>
  <div id="google-wrap" style="display:none; margin-bottom: 18px;">
    <div id="google-btn"></div>
  </div>
  <div class="divider" id="divider">or use email</div>
  <form id="f">
    <label for="email">Email</label>
    <input id="email" type="email" autocomplete="username" required>
    <label for="pw" id="pw-label">Password</label>
    <input id="pw" type="password" autocomplete="current-password" minlength="8" required>
    <label for="code" id="code-label" style="display:none">6-digit code</label>
    <input id="code" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" autocomplete="one-time-code" style="display:none">
    <label for="newpw" id="newpw-label" style="display:none">New password</label>
    <input id="newpw" type="password" autocomplete="new-password" minlength="8" style="display:none">
    <button id="sendcode" type="button" class="secondary" style="display:none">Email me a code</button>
    <button id="login" type="submit">Sign in</button>
    <button id="register" type="button" class="secondary">Create an account</button>
    <div class="err" id="err"></div>
    <div class="ok" id="ok"></div>
  </form>
  <div class="hint">
    <a href="#" id="mode-code">Sign in with a code instead</a> &nbsp;·&nbsp;
    <a href="#" id="mode-reset">Forgot password?</a>
    <a href="#" id="mode-pw" style="display:none">Back to password sign-in</a>
  </div>
  <div class="hint">Self-hosted with a shared token? Open this page as /?token=&lt;your token&gt;.</div>
</div>
<script>
  const f = document.getElementById("f");
  const err = document.getElementById("err");
  const okMsg = document.getElementById("ok");
  const email = document.getElementById("email");
  const pw = document.getElementById("pw");
  const codeIn = document.getElementById("code");
  const newpw = document.getElementById("newpw");
  const MSG = {
    bad_credentials: "Wrong email or password.",
    email_taken: "That email already has an account — use Sign in.",
    weak_password: "Use at least 8 characters.",
    invalid_email: "That doesn't look like an email address.",
    throttled: "Too many attempts — wait 15 minutes.",
    rate_limited: "Too many attempts from this network — try again later.",
    bad_code: "Wrong or expired code — request a fresh one if needed.",
    otp_cooldown: "Code already sent — wait a minute before asking again.",
  };
  async function post(path, body) {
    err.textContent = ""; okMsg.textContent = "";
    const res = await fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }).catch(() => null);
    if (!res) { err.textContent = "Network error — try again."; return null; }
    return res;
  }
  async function showError(res, fallback) {
    let code = "";
    try { code = (await res.json()).error || ""; } catch {}
    err.textContent = MSG[code] || (fallback + " (" + res.status + ").");
  }
  async function auth(path, body) {
    const res = await post(path, body);
    if (!res) return;
    if (res.ok) { location.replace("/"); return; }
    await showError(res, "Sign-in failed");
  }

  // Three form modes (S2): password (default) / code (passwordless) / reset.
  let mode = "pw";
  function show(el, on) { el.style.display = on ? "" : "none"; }
  function setMode(m) {
    mode = m;
    err.textContent = ""; okMsg.textContent = "";
    const isPw = m === "pw", isCode = m === "code", isReset = m === "reset";
    show(document.getElementById("pw-label"), isPw); show(pw, isPw);
    pw.required = isPw;
    show(document.getElementById("code-label"), !isPw); show(codeIn, !isPw);
    codeIn.required = !isPw;
    show(document.getElementById("newpw-label"), isReset); show(newpw, isReset);
    newpw.required = isReset;
    show(document.getElementById("sendcode"), !isPw);
    show(document.getElementById("register"), isPw);
    show(document.getElementById("mode-code"), isPw);
    show(document.getElementById("mode-reset"), isPw);
    show(document.getElementById("mode-pw"), !isPw);
    document.getElementById("login").textContent =
      isReset ? "Reset password" : isCode ? "Sign in with code" : "Sign in";
  }
  document.getElementById("mode-code").addEventListener("click", (e) => { e.preventDefault(); setMode("code"); });
  document.getElementById("mode-reset").addEventListener("click", (e) => { e.preventDefault(); setMode("reset"); });
  document.getElementById("mode-pw").addEventListener("click", (e) => { e.preventDefault(); setMode("pw"); });

  document.getElementById("sendcode").addEventListener("click", async () => {
    if (!email.reportValidity()) return;
    const res = await post("/api/auth/email/code", {
      email: email.value.trim(),
      purpose: mode === "reset" ? "reset" : "login",
    });
    if (!res) return;
    if (res.ok) { okMsg.textContent = "Code sent — check your email."; return; }
    await showError(res, "Couldn't send the code");
  });

  f.addEventListener("submit", (e) => {
    e.preventDefault();
    const addr = email.value.trim();
    if (mode === "code") { auth("/api/auth/email/login", { email: addr, code: codeIn.value.trim() }); return; }
    if (mode === "reset") {
      auth("/api/auth/password/reset", { email: addr, code: codeIn.value.trim(), newPassword: newpw.value });
      return;
    }
    auth("/api/auth/login", { email: addr, password: pw.value });
  });
  document.getElementById("register").addEventListener("click", () => {
    if (f.reportValidity()) auth("/api/auth/register", { email: email.value.trim(), password: pw.value });
  });

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

  // Sign in with Google on the web (S1): drawn only when the instance has an
  // OAuth client id configured (GET /api/auth/config). GIS renders its own
  // button; the callback hands back a Google-signed credential JWT which the
  // server verifies against the client-id audience.
  function initGoogle(cfg) {
    if (!cfg || !cfg.googleWeb || !cfg.googleWeb.clientId) return;
    const s = document.createElement("script");
    s.src = "https://accounts.google.com/gsi/client";
    s.onload = () => {
      if (!window.google || !window.google.accounts || !window.google.accounts.id) return;
      window.google.accounts.id.initialize({
        client_id: cfg.googleWeb.clientId,
        callback: async (resp) => {
          err.textContent = "";
          if (!resp || !resp.credential) { err.textContent = "Google didn't return a credential."; return; }
          const res = await fetch("/api/auth/google", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ credential: resp.credential }),
          }).catch(() => null);
          if (res && res.ok) { location.replace("/"); return; }
          err.textContent = "Google sign-in was rejected" + (res ? " (" + res.status + ")." : ".");
        },
      });
      window.google.accounts.id.renderButton(document.getElementById("google-btn"), {
        theme: "filled_black", size: "large", width: 324, text: "signin_with",
      });
      document.getElementById("google-wrap").style.display = "block";
      document.getElementById("divider").style.display = "flex";
    };
    // Unreachable networks (e.g. mainland China) just never show the button.
    s.onerror = () => {};
    document.head.appendChild(s);
  }

  // Sign in with Apple on the web (B8b): drawn only when the instance has a
  // Services ID configured (GET /api/auth/config). Apple's JS runs a popup and
  // hands back an id_token; the server verifies it against the web audience.
  fetch("/api/auth/config").then((r) => r.json()).then((cfg) => {
    initGoogle(cfg);
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

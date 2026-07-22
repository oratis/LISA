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
    <label for="pw">Password</label>
    <input id="pw" type="password" autocomplete="current-password" minlength="8" required>
    <button id="login" type="submit">Sign in</button>
    <button id="register" type="button" class="secondary">Create an account</button>
    <div class="err" id="err"></div>
  </form>
  <div class="hint">Self-hosted with a shared token? Open this page as /?token=&lt;your token&gt;.</div>
</div>
<script>
  const f = document.getElementById("f");
  const err = document.getElementById("err");
  const email = document.getElementById("email");
  const pw = document.getElementById("pw");
  const MSG = {
    bad_credentials: "Wrong email or password.",
    email_taken: "That email already has an account — use Sign in.",
    weak_password: "Use at least 8 characters.",
    invalid_email: "That doesn't look like an email address.",
    throttled: "Too many attempts — wait 15 minutes.",
  };
  async function auth(path) {
    err.textContent = "";
    const res = await fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: email.value.trim(), password: pw.value }),
    }).catch(() => null);
    if (!res) { err.textContent = "Network error — try again."; return; }
    if (res.ok) { location.replace("/"); return; }
    let code = "";
    try { code = (await res.json()).error || ""; } catch {}
    err.textContent = MSG[code] || ("Sign-in failed (" + res.status + ").");
  }
  f.addEventListener("submit", (e) => { e.preventDefault(); auth("/api/auth/login"); });
  document.getElementById("register").addEventListener("click", () => {
    if (f.reportValidity()) auth("/api/auth/register");
  });

  // Sign in with Apple on the web (B8b): drawn only when the instance has a
  // Services ID configured (GET /api/auth/config). Apple's JS runs a popup and
  // hands back an id_token; the server verifies it against the web audience.
  fetch("/api/auth/config").then((r) => r.json()).then((cfg) => {
    if (!cfg || !cfg.appleWeb || !cfg.appleWeb.servicesId) return;
    const s = document.createElement("script");
    s.src = "https://appleid.cdn-apple.com/appleauth/static/jsapi/appleid/1/en_US/appleid.auth.js";
    s.onload = () => {
      window.AppleID.auth.init({
        clientId: cfg.appleWeb.servicesId,
        scope: "name email",
        redirectURI: location.origin,
        usePopup: true,
      });
      document.getElementById("apple-wrap").style.display = "block";
      document.getElementById("divider").style.display = "flex";
      document.getElementById("apple-btn").addEventListener("click", async () => {
        err.textContent = "";
        try {
          const auth = await window.AppleID.auth.signIn();
          const idToken = auth && auth.authorization && auth.authorization.id_token;
          if (!idToken) { err.textContent = "Apple didn't return a token."; return; }
          const res = await fetch("/api/auth/apple", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ identityToken: idToken, client: "web" }),
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

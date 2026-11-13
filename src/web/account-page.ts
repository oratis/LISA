/**
 * /account — the signed-in self-service page for DESKTOP/WEB users
 * (PLAN_ACCOUNTS_BILLING B8c): session window, credits, Stripe top-up,
 * sign-out. Served post-gate, so an unauthenticated browser lands on the
 * login page instead. The iOS app never links here (3.1.1 hygiene) — its
 * purchases go through StoreKit.
 *
 * NOTE: one template literal — NO backticks inside (island.ts trap).
 */
import { PAGE_APPEARANCE_CSS, PAGE_APPEARANCE_JS } from "./page-appearance.js";

export const ACCOUNT_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>LISA — Account</title>
<style>
  ${PAGE_APPEARANCE_CSS}
  * { box-sizing: border-box; margin: 0; }
  body {
    min-height: 100vh; display: grid; place-items: center;
    background: var(--page-bg); color: var(--page-text);
    font: 16px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  }
  .card {
    width: min(92vw, 430px); padding: 32px 28px; border-radius: 16px;
    background: var(--page-card); border: 1px solid var(--page-border);
  }
  h1 { font-size: 22px; margin-bottom: 18px; }
  .row { display: flex; justify-content: space-between; margin: 8px 0; font-size: 15px; }
  .row .k { color: var(--page-muted); }
  .bar { height: 8px; border-radius: 4px; background: var(--page-border); overflow: hidden; margin: 10px 0 18px; }
  .bar > div { height: 100%; background: var(--page-success); }
  h2 { font-size: 14px; color: var(--page-muted); margin: 22px 0 8px; }
  button {
    width: 100%; margin-top: 8px; padding: 11px; border: 0; border-radius: 10px;
    background: var(--page-inset); color: var(--page-text); font-size: 15px; cursor: pointer;
    border: 1px solid var(--page-border); text-align: left; display: flex; justify-content: space-between;
  }
  button:hover { border-color: var(--page-accent); }
  button.quiet { background: transparent; border: 0; color: var(--page-muted); text-align: center; display: block; }
  .note { color: var(--page-muted); font-size: 12px; margin-top: 14px; }
  .ok { color: var(--page-success); font-size: 13px; margin-bottom: 10px; display: none; }
</style>
<script>${PAGE_APPEARANCE_JS}</script>
</head>
<body>
<div class="card">
  <h1>Your LISA account</h1>
  <div class="ok" id="paid-ok">✓ Payment received — credits are being applied.</div>
  <div class="row"><span class="k">Signed in as</span><span id="who">…</span></div>
  <div class="row"><span class="k">Tier</span><span id="tier">…</span></div>
  <div class="row"><span class="k">Daily allowance</span><span id="allow">…</span></div>
  <div class="bar"><div id="barfill" style="width:0%"></div></div>
  <div class="row"><span class="k">Welcome credit</span><span id="grant">…</span></div>
  <div class="row"><span class="k">Credits</span><span id="credits">…</span></div>

  <div id="topup" style="display:none">
    <h2>Add credits (never expire; any purchase also raises your free daily allowance for 30 days)</h2>
    <button data-pack="5"><span>$5.00 credits · Tier 1</span><b>$4.99</b></button>
    <button data-pack="10"><span>$10.50 credits (+5%) · Tier 1</span><b>$9.99</b></button>
    <button data-pack="20"><span>$22.00 credits (+10%) · Tier 2</span><b>$19.99</b></button>
  </div>

  <h2>Your Mac</h2>
  <div class="row" style="display:block; font-size: 13px; color: var(--page-muted);">
    Cloud Lisa carries her soul, memory, knowledge and chat. Terminal control,
    screen sense and local dispatch live on your own machine — by design.
    Pair the Mac app to bring them into this account (identity bridge, coming
    soon). <a href="https://meetlisa.ai/install" style="color:var(--page-accent)">Get the Mac app →</a>
  </div>

  <button class="quiet" id="logout">Sign out</button>
  <div class="note">Buying in the iOS app works too — credits roam with the account either way.</div>
</div>
<script>
  const $ = (id) => document.getElementById(id);
  if (location.search.includes("paid=1")) $("paid-ok").style.display = "block";
  const dollars = (m) => "$" + (Math.max(0, m || 0) / 1e6).toFixed(2);
  async function refresh() {
    const me = await fetch("/api/auth/me").then((r) => r.json()).catch(() => null);
    if (me && me.signedIn) $("who").textContent = me.email || me.uid;
    const q = await fetch("/api/billing/quota").then((r) => r.json()).catch(() => null);
    if (q && q.available) {
      $("tier").textContent = q.tier;
      $("allow").textContent = dollars(q.remainingMicroUSD) + " of " + dollars(q.windowMicroUSD) + " left";
      $("grant").textContent = dollars(q.grantMicroUSD);
      $("credits").textContent = dollars(q.paidMicroUSD);
      const pct = q.windowMicroUSD ? Math.min(100, 100 * (q.remainingMicroUSD / q.windowMicroUSD)) : 0;
      $("barfill").style.width = pct + "%";
    }
    const cfg = await fetch("/api/auth/config").then((r) => r.json()).catch(() => null);
    if (cfg && cfg.stripe) $("topup").style.display = "block";
  }
  refresh();
  document.querySelectorAll("#topup button").forEach((btn) => {
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      const res = await fetch("/api/billing/stripe/checkout", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pack: btn.dataset.pack }),
      }).catch(() => null);
      btn.disabled = false;
      if (!res || !res.ok) return;
      const body = await res.json();
      if (body.url) location.href = body.url;
    });
  });
  $("logout").addEventListener("click", async () => {
    await fetch("/api/auth/logout", { method: "POST" });
    location.replace("/");
  });
</script>
</body>
</html>
`;

/**
 * `lisa login` / `lisa logout` / `lisa billing` — the managed-inference CLI
 * (docs/PLAN_ACCOUNTS_BILLING_v1.0.md §6.6, milestone B6).
 *
 * login: email+password against a LISA Cloud instance → stores the account
 * session in config.env (LISA_MANAGED_SESSION/_BASE). From then on, any model
 * WITHOUT its own BYO key routes through the cloud gateway — no API key needed.
 * BYO keys keep winning; `lisa logout` removes the session.
 *
 * The password is read from the TTY with echo off (never from argv — argv
 * leaks into `ps`). Sign in with Apple isn't possible in a terminal; email
 * accounts are the CLI path.
 */
import readline from "node:readline";
import { saveConfigEnv } from "../env.js";
import { managedConfig } from "../providers/registry.js";
import { formatMicroUSD } from "../billing/prices.js";

function ask(question: string, opts: { hidden?: boolean } = {}): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr, terminal: true });
  return new Promise((resolve) => {
    if (opts.hidden) {
      // Mute the echo: readline writes the prompt, we swallow the keystrokes.
      const stream = process.stderr;
      const origWrite = stream.write.bind(stream);
      let muted = false;
      (stream as unknown as { write: typeof origWrite }).write = ((chunk: never, ...rest: never[]) => {
        if (muted) return true;
        return origWrite(chunk, ...rest);
      }) as typeof origWrite;
      rl.question(question, (answer) => {
        (stream as unknown as { write: typeof origWrite }).write = origWrite;
        origWrite("\n");
        rl.close();
        resolve(answer);
      });
      muted = true;
    } else {
      rl.question(question, (answer) => {
        rl.close();
        resolve(answer);
      });
    }
  });
}

export async function cmdLogin(subargs: string[]): Promise<void> {
  const base = (subargs[0] ?? process.env.LISA_MANAGED_BASE ?? "https://cloud.meetlisa.ai").replace(/\/+$/, "");
  const email = (await ask(`LISA Cloud (${base})\nEmail: `)).trim();
  const password = await ask("Password: ", { hidden: true });
  if (!email || !password) {
    console.error("login cancelled — email and password are both required.");
    process.exitCode = 1;
    return;
  }
  let res: Response;
  try {
    res = await fetch(`${base}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
  } catch {
    console.error(`✗ could not reach ${base}`);
    process.exitCode = 1;
    return;
  }
  if (!res.ok) {
    let code = "";
    try { code = ((await res.json()) as { error?: string }).error ?? ""; } catch { /* text body */ }
    const hint =
      code === "bad_credentials" ? "wrong email or password"
      : code === "throttled" ? "too many attempts — wait 15 minutes"
      : `HTTP ${res.status}`;
    console.error(`✗ sign-in rejected (${hint}). No account? Create one in the iOS app or on the web page.`);
    process.exitCode = 1;
    return;
  }
  const body = (await res.json()) as { token?: string; uid?: string };
  if (!body.token) {
    console.error("✗ unexpected server response (no session token)");
    process.exitCode = 1;
    return;
  }
  await saveConfigEnv({ LISA_MANAGED_SESSION: body.token, LISA_MANAGED_BASE: base });
  console.error(`✓ signed in as ${email} (${body.uid ?? "?"})`);
  console.error("  Models without a BYO key now route through LISA Cloud — no API key needed.");
  await cmdBilling([]);
}

export async function cmdLogout(): Promise<void> {
  await saveConfigEnv({ LISA_MANAGED_SESSION: "", LISA_MANAGED_BASE: "" });
  console.error("✓ signed out — managed inference disabled (BYO keys unaffected).");
}

export async function cmdBilling(_subargs: string[]): Promise<void> {
  const managed = managedConfig();
  if (!managed) {
    console.error("Not signed in. Run `lisa login` first (BYO-key usage isn't metered).");
    process.exitCode = 1;
    return;
  }
  try {
    const headers = { authorization: `Bearer ${managed.session}` };
    const [quotaRes, usageRes] = await Promise.all([
      fetch(`${managed.base}/api/billing/quota`, { headers }),
      fetch(`${managed.base}/api/billing/usage`, { headers }),
    ]);
    if (quotaRes.status === 401) {
      console.error("✗ session expired — run `lisa login` again.");
      process.exitCode = 1;
      return;
    }
    const quota = (await quotaRes.json()) as {
      available?: boolean; tier?: string; windowMicroUSD?: number;
      spentMicroUSD?: number; remainingMicroUSD?: number; paidMicroUSD?: number; resetAt?: number;
    };
    const usage = (await usageRes.json()) as {
      window12h?: { microUSD: number; turns: number };
      today?: { microUSD: number; turns: number };
    };
    if (!quota.available) {
      console.error("Signed in, but this connection isn't an account session — run `lisa login` again.");
      return;
    }
    console.log(`tier:        ${quota.tier}`);
    console.log(
      `session:     ${formatMicroUSD(quota.remainingMicroUSD ?? 0)} of ${formatMicroUSD(quota.windowMicroUSD ?? 0)} left` +
        (quota.resetAt ? ` (resets ${new Date(quota.resetAt).toLocaleTimeString()})` : ""),
    );
    console.log(`credits:     ${formatMicroUSD(Math.max(0, quota.paidMicroUSD ?? 0))}`);
    if (usage.window12h) console.log(`last 12h:    ${formatMicroUSD(usage.window12h.microUSD)} across ${usage.window12h.turns} turns`);
    if (usage.today) console.log(`today:       ${formatMicroUSD(usage.today.microUSD)} across ${usage.today.turns} turns`);
  } catch {
    console.error(`✗ could not reach ${managed.base}`);
    process.exitCode = 1;
  }
}

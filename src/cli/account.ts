/**
 * `lisa login` / `lisa logout` / `lisa billing` — the managed-inference CLI
 * (docs/PLAN_ACCOUNTS_BILLING_v1.0.md §6.6, milestone B6).
 *
 * login: signs in against a LISA Cloud instance → stores the account session in
 * config.env (LISA_MANAGED_SESSION/_BASE). From then on, any model WITHOUT its
 * own BYO key routes through the cloud gateway — no API key needed. BYO keys
 * keep winning; `lisa logout` removes the session.
 *
 * By default it mails a one-time code (PLAN_AUTH_OTP_GOOGLE A2): nothing to
 * remember, and it registers an account on the spot if the address is new.
 * `--password` keeps the email+password path for accounts that have one.
 *
 * Secrets are read from the TTY with echo off (never from argv — argv leaks
 * into `ps`); the mailed code is echoed, since it's single-use and expiring.
 * Sign in with Apple and Google both need a browser, so email is the CLI path.
 */
import readline from "node:readline";
import { saveConfigEnv } from "../env.js";
import { managedConfig } from "../providers/registry.js";
import { formatMicroUSD } from "../billing/prices.js";

/**
 * One interface for the whole command. A fresh one per prompt drops whatever
 * the previous reader had already buffered, which breaks every prompt after the
 * first as soon as stdin isn't an interactive terminal.
 */
let prompts: readline.Interface | null = null;
function promptStream(): readline.Interface {
  prompts ??= readline.createInterface({ input: process.stdin, output: process.stderr, terminal: true });
  return prompts;
}
function closePrompts(): void {
  prompts?.close();
  prompts = null;
}

function ask(question: string, opts: { hidden?: boolean } = {}): Promise<string> {
  const rl = promptStream();
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
        resolve(answer);
      });
      muted = true;
    } else {
      rl.question(question, (answer) => {
        resolve(answer);
      });
    }
  });
}

/**
 * POST JSON, returning the parsed body plus the error code on failure. An
 * unreachable server is reported as the `unreachable` code rather than thrown,
 * so callers never have to wrap this in a catch broad enough to swallow — and
 * mislabel — a bug as a network problem.
 */
async function post(
  url: string,
  payload: Record<string, unknown>,
): Promise<{ ok: boolean; status: number; code: string; body: Record<string, unknown> }> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch {
    return { ok: false, status: 0, code: "unreachable", body: {} };
  }
  let body: Record<string, unknown> = {};
  try { body = (await res.json()) as Record<string, unknown>; } catch { /* text body */ }
  return { ok: res.ok, status: res.status, code: typeof body.error === "string" ? body.error : "", body };
}

const HINTS: Record<string, string> = {
  unreachable: "could not reach the server",
  bad_credentials: "wrong email or password",
  throttled: "too many attempts — wait 15 minutes",
  rate_limited: "too many attempts from this network — try again later",
  invalid_email: "that doesn't look like an email address",
  email_typo: "that address looks misspelled",
  undeliverable_email: "that domain doesn't seem to accept mail",
  otp_cooldown: "a code was just sent — check your inbox",
  otp_daily_cap: "too many codes for this address today",
  bad_code: "that code isn't right",
  expired: "that code expired — run login again",
  no_pending: "no code outstanding — run login again",
  too_many_attempts: "too many wrong codes — run login again",
};

function hintFor(code: string, status: number): string {
  return HINTS[code] ?? `HTTP ${status}`;
}

interface Session {
  token: string;
  uid?: string;
}

/** Pull the session out of a successful auth response. */
function sessionFrom(body: Record<string, unknown>): Session | null {
  if (typeof body.token !== "string" || !body.token) return null;
  return { token: body.token, ...(typeof body.uid === "string" ? { uid: body.uid } : {}) };
}

/**
 * Sign in with a mailed code (the default). Returns the session, or null after
 * reporting why not. Wrong digits are retried in place while the code is still
 * live — the server burns it after five, so three tries here is safe.
 */
async function loginWithCode(base: string, email: string): Promise<Session | null> {
  const asked = await post(`${base}/api/auth/otp/request`, { email });
  if (!asked.ok) {
    const suggestion = typeof asked.body.suggestion === "string" ? asked.body.suggestion : "";
    console.error(
      `✗ couldn't send a code (${hintFor(asked.code, asked.status)})` +
        (suggestion ? ` — did you mean ${email.replace(/@.*$/, `@${suggestion}`)}?` : "."),
    );
    return null;
  }
  if (asked.body.sent === false) {
    console.error("✗ the server couldn't deliver the mail. Try again shortly, or use --password.");
    return null;
  }
  console.error(`✉ A 6-digit code is on its way to ${email}.`);
  for (let attempt = 0; attempt < 3; attempt++) {
    const code = (await ask("Code: ")).trim();
    if (!code) {
      console.error("login cancelled.");
      return null;
    }
    const spent = await post(`${base}/api/auth/otp/verify`, { email, code });
    if (spent.ok) return sessionFrom(spent.body);
    console.error(`✗ ${hintFor(spent.code, spent.status)}.`);
    if (spent.code !== "bad_code") return null; // expired/burned — a retry can't help
  }
  return null;
}

async function loginWithPassword(base: string, email: string): Promise<Session | null> {
  const password = await ask("Password: ", { hidden: true });
  if (!password) {
    console.error("login cancelled — a password is required.");
    return null;
  }
  const res = await post(`${base}/api/auth/login`, { email, password });
  if (!res.ok) {
    console.error(
      `✗ sign-in rejected (${hintFor(res.code, res.status)}). No password on this account? Run 'lisa login' without --password.`,
    );
    return null;
  }
  return sessionFrom(res.body);
}

export async function cmdLogin(subargs: string[]): Promise<void> {
  const usePassword = subargs.includes("--password");
  const positional = subargs.filter((a) => !a.startsWith("-"));
  const base = (positional[0] ?? process.env.LISA_MANAGED_BASE ?? "https://cloud.meetlisa.ai").replace(/\/+$/, "");
  try {
    const email = (await ask(`LISA Cloud (${base})\nEmail: `)).trim();
    if (!email) {
      console.error("login cancelled — an email address is required.");
      process.exitCode = 1;
      return;
    }
    const session = usePassword
      ? await loginWithPassword(base, email)
      : await loginWithCode(base, email);
    if (!session) {
      process.exitCode = 1;
      return;
    }
    await saveConfigEnv({ LISA_MANAGED_SESSION: session.token, LISA_MANAGED_BASE: base });
    console.error(`✓ signed in as ${email} (${session.uid ?? "?"})`);
    console.error("  Models without a BYO key now route through LISA Cloud — no API key needed.");
  } finally {
    closePrompts();
  }
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

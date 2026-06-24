/**
 * `lisa mail <list|connect|sweep|digest|remove|enable|disable>` — manage mail
 * accounts and run/read the classified daily digest. Read-only (v1).
 *
 *   lisa mail connect --email me@qq.com [--host imap.qq.com] [--port 993] [--pass <app-pw>] [--label "QQ"]
 *   lisa mail sweep            # read + classify now, print the digest
 *   lisa mail digest           # print the latest digest
 *   lisa mail list             # accounts + consent state
 */
import { createInterface } from "node:readline";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import { grant, isGranted } from "../consent/store.js";
import { addAccount, loadAccounts, removeAccount, setAccountEnabled } from "../mail/accounts.js";
import { sweepAll } from "../mail/service.js";
import { latestDigest } from "../mail/store.js";
import { formatDigestText } from "../mail/digest.js";
import { inferHost } from "../mail/hosts.js";
import { buildAuthUrl, exchangeCode } from "../mail/google-oauth.js";
import { gmailProfileEmail } from "../mail/connectors/gmail.js";

function parseFlags(args: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a || !a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = args[i + 1];
    if (next && !next.startsWith("--")) {
      out[key] = next;
      i++;
    } else {
      out[key] = "true";
    }
  }
  return out;
}

function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (a) => { rl.close(); resolve(a); }));
}

function printAccounts(): void {
  const accounts = loadAccounts();
  const gated = isGranted("mail") ? "● granted" : "○ NOT granted (sweeps are blocked — `lisa consent grant mail`)";
  console.log(`Mail — consent: ${gated}\n`);
  if (accounts.length === 0) {
    console.log("  (no accounts) — add one with `lisa mail connect --email you@host`");
    return;
  }
  for (const a of accounts) {
    const when = a.lastSweepAt ? new Date(a.lastSweepAt).toISOString().slice(0, 16).replace("T", " ") : "never";
    console.log(`  ${a.enabled ? "●" : "○"} ${a.id.padEnd(16)} ${a.email}  [${a.provider}${a.host ? " " + a.host : ""}]  swept: ${when}`);
  }
}

/** Gmail OAuth via the loopback "installed app" flow. */
async function connectGmail(flags: Record<string, string>): Promise<number> {
  const clientId = flags["client-id"] ?? process.env.LISA_GOOGLE_CLIENT_ID ?? "";
  const clientSecret = flags["client-secret"] ?? process.env.LISA_GOOGLE_CLIENT_SECRET ?? "";
  if (!clientId || !clientSecret) {
    console.error("Gmail OAuth needs a Google OAuth client id + secret.");
    console.error("One-time setup: in a Google Cloud project, enable the Gmail API and create an");
    console.error("OAuth client of type \"Desktop app\", then:");
    console.error("  lisa mail connect --provider gmail --client-id <id> --client-secret <secret>");
    console.error("  (or set LISA_GOOGLE_CLIENT_ID / LISA_GOOGLE_CLIENT_SECRET)");
    return 1;
  }
  const state = crypto.randomBytes(8).toString("hex");
  let redirectUri = "";
  console.log("Authorizing Gmail (read-only)…");
  let code: string;
  try {
    code = await new Promise<string>((resolve, reject) => {
      const server = createServer((req, res) => {
        const u = new URL(req.url ?? "/", "http://127.0.0.1");
        if (u.pathname !== "/oauth2callback") { res.writeHead(404); res.end(); return; }
        const c = u.searchParams.get("code");
        const s = u.searchParams.get("state");
        res.writeHead(200, { "content-type": "text/html" });
        res.end("<html><body style='font-family:sans-serif;padding:2rem'>Lisa: Gmail connected. You can close this tab.</body></html>");
        server.close();
        if (s !== state) reject(new Error("OAuth state mismatch"));
        else if (!c) reject(new Error("no authorization code"));
        else resolve(c);
      });
      server.on("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        const port = typeof addr === "object" && addr ? addr.port : 0;
        redirectUri = `http://127.0.0.1:${port}/oauth2callback`;
        const url = buildAuthUrl({ clientId, redirectUri, state });
        console.log("Opening your browser to approve read-only Gmail access.");
        console.log("If it doesn't open, paste this URL:\n  " + url + "\n");
        try { spawn("open", [url], { stdio: "ignore", detached: true }).unref(); } catch { /* print-only */ }
      });
      setTimeout(() => { try { server.close(); } catch { /* noop */ } reject(new Error("timed out waiting for authorization")); }, 300_000);
    });
  } catch (err) {
    console.error("✗ " + (err as Error).message);
    return 1;
  }
  try {
    const tokens = await exchangeCode({ code, clientId, clientSecret, redirectUri });
    const email = await gmailProfileEmail(tokens.accessToken);
    const account = addAccount(
      { provider: "gmail", email: email || "gmail", label: flags.label },
      { refreshToken: tokens.refreshToken, accessToken: tokens.accessToken, expiry: tokens.expiry, clientId, clientSecret },
    );
    grant("mail");
    console.log(`\n✓ connected ${email} (${account.id}, gmail). Mail consent granted.`);
    console.log("  Run `lisa mail sweep` to read + classify now.");
    return 0;
  } catch (err) {
    console.error("✗ token exchange failed: " + (err as Error).message);
    return 1;
  }
}

export async function runMailCommand(subargs: string[]): Promise<number> {
  const sub = subargs[0] ?? "list";
  const flags = parseFlags(subargs.slice(1));

  if (sub === "list" || sub === "status") {
    printAccounts();
    return 0;
  }

  if (sub === "connect" && flags.provider === "gmail") {
    return connectGmail(flags);
  }

  if (sub === "connect") {
    const email = flags.email;
    if (!email || !email.includes("@")) {
      console.error("connect needs --email you@host");
      return 1;
    }
    const host = flags.host ?? inferHost(email);
    if (!host) {
      console.error("couldn't infer IMAP host — pass --host imap.example.com");
      return 1;
    }
    let pass = flags.pass ?? process.env.LISA_MAIL_PASS ?? "";
    if (!pass) {
      console.log(`Connecting ${email} via IMAP ${host}. Use an app-password / authorization code (not your login password).`);
      pass = (await ask("App-password: ")).trim();
    }
    if (!pass) {
      console.error("no password provided.");
      return 1;
    }
    const account = addAccount(
      { provider: "imap", email, host, port: flags.port ? Number(flags.port) : 993, label: flags.label },
      { password: pass },
    );
    grant("mail"); // connecting a mailbox is the consent act; revoke any time
    console.log(`\n✓ connected ${email} (${account.id}). Mail consent granted.`);
    console.log("  Run `lisa mail sweep` to read + classify now.");
    return 0;
  }

  if (sub === "remove") {
    const id = subargs[1];
    if (!id) { console.error("remove needs an account id (see `lisa mail list`)."); return 1; }
    console.log(removeAccount(id) ? `✓ removed ${id}.` : `no such account: ${id}`);
    return 0;
  }

  if (sub === "enable" || sub === "disable") {
    const id = subargs[1];
    if (!id) { console.error(`${sub} needs an account id.`); return 1; }
    console.log(setAccountEnabled(id, sub === "enable") ? `✓ ${id} ${sub}d.` : `no such account: ${id}`);
    return 0;
  }

  if (sub === "sweep") {
    if (!isGranted("mail")) { console.error("mail consent not granted — `lisa consent grant mail`."); return 1; }
    console.log("Reading + classifying mail…");
    const res = await sweepAll();
    console.log("\n" + formatDigestText(res.digest));
    if (res.newItems.length) console.log(`\n(${res.newItems.length} new since last sweep)`);
    return 0;
  }

  if (sub === "digest") {
    const d = latestDigest();
    if (!d) { console.log("No digest yet — run `lisa mail sweep`."); return 0; }
    console.log(formatDigestText(d));
    return 0;
  }

  console.error(`unknown mail subcommand "${sub}" — use list | connect | sweep | digest | remove | enable | disable.`);
  return 1;
}

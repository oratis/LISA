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
import { grant, isGranted } from "../consent/store.js";
import { addAccount, loadAccounts, removeAccount, setAccountEnabled } from "../mail/accounts.js";
import { sweepAll } from "../mail/service.js";
import { latestDigest } from "../mail/store.js";
import { formatDigestText } from "../mail/digest.js";

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

/** Infer the IMAP host from the email domain (common providers). */
export function inferHost(email: string): string | undefined {
  const domain = (email.split("@")[1] ?? "").toLowerCase();
  const map: Record<string, string> = {
    "qq.com": "imap.qq.com",
    "163.com": "imap.163.com",
    "126.com": "imap.126.com",
    "gmail.com": "imap.gmail.com",
    "googlemail.com": "imap.gmail.com",
    "outlook.com": "outlook.office365.com",
    "hotmail.com": "outlook.office365.com",
    "live.com": "outlook.office365.com",
    "icloud.com": "imap.mail.me.com",
    "me.com": "imap.mail.me.com",
    "yahoo.com": "imap.mail.yahoo.com",
  };
  if (map[domain]) return map[domain];
  return domain ? `imap.${domain}` : undefined;
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

export async function runMailCommand(subargs: string[]): Promise<number> {
  const sub = subargs[0] ?? "list";
  const flags = parseFlags(subargs.slice(1));

  if (sub === "list" || sub === "status") {
    printAccounts();
    return 0;
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

/**
 * End-to-end check of inbound hygiene through the mail pipeline (plan W2b):
 * whatever a connector returns, no one-time code and no sign-in / reset link
 * may reach the model prompt, the classified items, the digest on disk, an
 * alert, or the log.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sweepAll, pollNewMail, type ConnectorFactory } from "./service.js";
import { addAccount } from "./accounts.js";
import { buildClassifyPrompt, classifyMail, parseClassification } from "./classify.js";
import { formatAlert } from "./alerts.js";
import { formatDigestText } from "./digest.js";
import { latestDigest } from "./store.js";
import { grant } from "../consent/store.js";
import { closeLogFile } from "../log.js";
import type { Provider } from "../providers/types.js";
import type { MailConnector, MailItem, RawMail } from "./types.js";

const CODE = "482913";
const RESET_TOKEN = "3f2a9c1b7d4e5a6b7c8d";
const MAGIC_TOKEN = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.c2lnbmF0dXJl";
/** Nothing in this list may appear anywhere downstream of the connector. */
const FORBIDDEN = [CODE, RESET_TOKEN, MAGIC_TOKEN, "739204"];

const INBOX: RawMail[] = [
  raw("1", {
    from: "Acme <no-reply@acme.com>",
    fromAddress: "no-reply@acme.com",
    subject: `Your Acme verification code is ${CODE}`,
    snippet: `Enter ${CODE} to finish signing in. It expires in 10 minutes.`,
  }),
  raw("2", {
    from: "GitHub <noreply@github.com>",
    fromAddress: "noreply@github.com",
    subject: "[GitHub] Please reset your password",
    snippet: `We heard you lost your password. Reset it here: https://github.com/password_reset/${RESET_TOKEN} If you don't use this link within 3 hours, it will expire.`,
  }),
  raw("3", {
    from: "Notes <login@notes.example>",
    fromAddress: "login@notes.example",
    subject: "Your magic link",
    snippet: `Click to sign in: https://notes.example/magic?token=${MAGIC_TOKEN}`,
  }),
  raw("4", {
    from: "招商银行 <95555@message.cmbchina.com>",
    fromAddress: "95555@message.cmbchina.com",
    subject: "动态密码",
    snippet: "739204，尾号1234的储蓄卡正在进行支付，金额5000.00元，请勿泄露。",
  }),
  raw("5", {
    from: "Jane Doe <jane@x.com>",
    fromAddress: "jane@x.com",
    subject: "Invoice 88213 due October 12, 2026",
    snippet: "Total $1,284.00. See https://billing.example.com/invoices/88213 — thanks!",
  }),
];

function raw(uid: string, o: Partial<RawMail> = {}): RawMail {
  return {
    uid,
    accountId: "",
    from: "Jane <jane@x.com>",
    fromAddress: "jane@x.com",
    subject: "hello",
    date: 1_700_000_000_000,
    snippet: "hi",
    flags: [],
    mailbox: "INBOX",
    ...o,
  };
}

async function withHome(fn: (home: string) => Promise<void>): Promise<void> {
  const prevHome = process.env.LISA_HOME;
  const prevLog = process.env.LISA_LOG_FILE;
  const home = mkdtempSync(join(tmpdir(), "lisa-mail-hygiene-"));
  process.env.LISA_HOME = home;
  process.env.LISA_LOG_FILE = join(home, "test.log");
  try {
    await fn(home);
  } finally {
    closeLogFile();
    if (prevHome === undefined) delete process.env.LISA_HOME;
    else process.env.LISA_HOME = prevHome;
    if (prevLog === undefined) delete process.env.LISA_LOG_FILE;
    else process.env.LISA_LOG_FILE = prevLog;
    rmSync(home, { recursive: true, force: true });
  }
}

function fakeConnector(raws: RawMail[]): ConnectorFactory {
  return (): MailConnector => ({
    listSince: () => Promise.resolve(raws),
    close: () => Promise.resolve(),
  });
}

/** A provider that records everything it is sent and answers with fixed JSON. */
function recordingProvider(json: string): { provider: Provider; sent: string[] } {
  const sent: string[] = [];
  const provider: Provider = {
    name: "fake",
    runTurn(opts) {
      sent.push(
        JSON.stringify(opts, (key, value: unknown) => (key === "signal" ? undefined : value)),
      );
      return Promise.resolve({
        content: [{ type: "text", text: json } as never],
        stopReason: "end_turn",
        usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
      });
    },
  };
  return { provider, sent };
}

function assertClean(label: string, text: string): void {
  for (const secret of FORBIDDEN) {
    assert.equal(text.includes(secret), false, `${label} leaked ${secret}`);
  }
}

/** Every file under `dir`, concatenated — "what is on disk". */
function readTree(dir: string): string {
  let out = "";
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    out += entry.isDirectory() ? readTree(full) : readFileSync(full, "utf8");
  }
  return out;
}

const CLASSIFIED =
  '[{"uid":"1","category":"security","importance":2,"reason":"login code"},' +
  '{"uid":"2","category":"security","importance":3,"reason":"password reset requested"},' +
  '{"uid":"3","category":"security","importance":2,"reason":"magic sign-in link"},' +
  '{"uid":"4","category":"finance","importance":3,"reason":"支付验证"},' +
  '{"uid":"5","category":"finance","importance":2,"reason":"invoice due"}]';

test("sweepAll: nothing sensitive reaches the model, the items, the digest file or the log", async () => {
  await withHome(async (home) => {
    grant("mail");
    addAccount({ provider: "imap", email: "me@qq.com", host: "imap.qq.com" }, { password: "pw" });
    const { provider, sent } = recordingProvider(CLASSIFIED);
    const res = await sweepAll({ connectorFactory: fakeConnector(INBOX), provider });

    assert.equal(sent.length, 1, "one classification call");
    assertClean("model prompt", sent.join("\n"));
    // The model still sees enough to classify: who, what kind of mail, and the markers.
    assert.match(sent[0]!, /Your Acme verification code is \[redacted: one-time code\]/);
    assert.match(sent[0]!, /\[redacted: password-reset link\]/);
    assert.match(sent[0]!, /\[redacted: sign-in link\]/);
    assert.match(sent[0]!, /尾号1234/);
    assert.match(sent[0]!, /https:\/\/billing\.example\.com\/invoices\/88213/);

    assert.equal(res.items.length, 5);
    assertClean("classified items", JSON.stringify(res.items));
    assertClean("digest", JSON.stringify(res.digest));
    assertClean("digest text (push + chat)", formatDigestText(res.digest));
    assertClean("latestDigest()", JSON.stringify(latestDigest()));
    for (const item of res.items) assertClean("alert", JSON.stringify(formatAlert(item)));

    closeLogFile();
    assertClean("everything on disk under the home (digests, seen, log)", readTree(home));
    const log = readFileSync(join(home, "test.log"), "utf8");
    assert.match(
      log,
      /\[mail\] hygiene account=\S+: cleaned 4\/5 message\(s\) — otp=3 signInLinks=1 resetLinks=1/,
    );
    assert.equal(log.includes("Acme"), false, "the log line carries counts, not subjects");

    // Ordinary mail is untouched.
    const invoice = res.items.find((i) => i.uid === "5")!;
    assert.equal(invoice.subject, INBOX[4]!.subject);
    assert.equal(invoice.snippet, INBOX[4]!.snippet);
    // The security signal survives the code being removed.
    assert.ok(res.items.find((i) => i.uid === "1")!.signals.includes("security-code"));
    assert.ok(res.items.find((i) => i.uid === "2")!.signals.includes("auth-link"));
  });
});

test("sweepAll: the heuristic fallback (model down) is just as clean", async () => {
  await withHome(async () => {
    grant("mail");
    addAccount({ provider: "imap", email: "me@qq.com", host: "imap.qq.com" }, { password: "pw" });
    const provider: Provider = {
      name: "down",
      runTurn: () => Promise.reject(new Error("model unavailable")),
    };
    const res = await sweepAll({ connectorFactory: fakeConnector(INBOX), provider });
    assert.equal(res.items.length, 5);
    assertClean("fallback items", JSON.stringify(res.items));
    const byUid = new Map(res.items.map((i) => [i.uid, i]));
    assert.equal(byUid.get("1")!.category, "security");
    assert.equal(byUid.get("2")!.category, "security");
    assert.equal(byUid.get("3")!.category, "security");
    assert.equal(byUid.get("1")!.importance, 2);
  });
});

test("pollNewMail: alerts built from fresh mail are clean, and logged once", async () => {
  await withHome(async (home) => {
    grant("mail");
    addAccount({ provider: "imap", email: "me@qq.com", host: "imap.qq.com" }, { password: "pw" });
    const { provider, sent } = recordingProvider(CLASSIFIED);
    const fresh = await pollNewMail({ connectorFactory: fakeConnector(INBOX), provider });
    assert.equal(fresh.length, 5);
    assertClean("poll prompt", sent.join("\n"));
    for (const item of fresh) {
      const alert = formatAlert(item);
      assertClean("push title/body + chat", JSON.stringify(alert));
    }
    assert.match(formatAlert(fresh[1]!).chat, /Please reset your password/);

    // A second poll sees nothing new: no model call, no second hygiene log line.
    const again = await pollNewMail({ connectorFactory: fakeConnector(INBOX), provider });
    assert.equal(again.length, 0);
    assert.equal(sent.length, 1);
    closeLogFile();
    const lines = readFileSync(join(home, "test.log"), "utf8")
      .split("\n")
      .filter((l) => l.includes("[mail] hygiene"));
    assert.equal(lines.length, 1);
  });
});

test("classify: the prompt and the parsed items are clean even without the service", async () => {
  // A caller that skips the sweep service must not be able to skip hygiene.
  assertClean("buildClassifyPrompt", buildClassifyPrompt(INBOX));
  assertClean("parseClassification", JSON.stringify(parseClassification(CLASSIFIED, INBOX, 1)));
  const { provider, sent } = recordingProvider(CLASSIFIED);
  const items = await classifyMail(INBOX, { provider });
  assertClean("classifyMail prompt", sent.join("\n"));
  assertClean("classifyMail items", JSON.stringify(items));
});

test("classify: a model that echoes a code in its reason is cleaned too", () => {
  const echoed = `[{"uid":"1","category":"security","importance":2,"reason":"verification code ${CODE}"}]`;
  const [only] = parseClassification(echoed, [INBOX[0]!], 1);
  assertClean("reason", only!.reason);
  assert.match(only!.reason, /\[redacted: one-time code\]/);
});

test("formatAlert: cleans an item that was never through the pipeline", () => {
  const dirty: MailItem = {
    uid: "9",
    accountId: "acc",
    from: "Acme <no-reply@acme.com>",
    fromAddress: "no-reply@acme.com",
    subject: `Your verification code is ${CODE}`,
    date: 1,
    snippet: "",
    category: "security",
    importance: 3,
    reason: `use ${CODE} as your login code`,
    signals: [],
    classifiedAt: 1,
  };
  const alert = formatAlert(dirty);
  assertClean("alert", JSON.stringify(alert));
  assert.equal(alert.tag, "acc:9");
});

test("latestDigest: a digest saved before hygiene existed is cleaned on read", async () => {
  await withHome((home) => {
    mkdirSync(join(home, "mail"), { recursive: true });
    const legacyItem = {
      uid: "1",
      accountId: "acc",
      from: "Acme <no-reply@acme.com>",
      fromAddress: "no-reply@acme.com",
      subject: `Your verification code is ${CODE}`,
      date: 1,
      snippet: `Reset: https://example.com/reset-password?token=${RESET_TOKEN}`,
      category: "security",
      importance: 2,
      reason: "security-code",
      signals: ["security-code"],
      classifiedAt: 1,
    };
    writeFileSync(
      join(home, "mail", "latest-digest.json"),
      JSON.stringify({
        date: "2026-09-30",
        generatedAt: 1,
        accountIds: ["acc"],
        total: 1,
        unread: 1,
        needsYou: [legacyItem],
        buckets: [{ category: "security", count: 1, items: [legacyItem] }],
        summary: `1 new email. 1 needs you: “Your verification code is ${CODE}” (Acme).`,
      }),
    );
    const digest = latestDigest();
    assert.ok(digest);
    assertClean("legacy digest", JSON.stringify(digest));
    assertClean("legacy digest text", formatDigestText(digest));
    assert.equal(digest.total, 1);
    return Promise.resolve();
  });
});

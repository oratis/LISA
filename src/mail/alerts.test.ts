import { test } from "node:test";
import assert from "node:assert/strict";
import { pickImportant, formatAlert, alertLevel, pollMinutes, DEFAULT_ALERT_LEVEL, DEFAULT_POLL_MINUTES } from "./alerts.js";
import type { MailItem } from "./types.js";

function item(o: Partial<MailItem> = {}): MailItem {
  return {
    uid: "1",
    accountId: "acc",
    from: "Jane Doe <jane@x.com>",
    fromAddress: "jane@x.com",
    subject: "hello",
    date: 100,
    snippet: "hi",
    category: "personal",
    importance: 3,
    reason: "awaiting your reply",
    signals: [],
    classifiedAt: 1,
    ...o,
  };
}

test("pickImportant filters by threshold and sorts importance then date", () => {
  const items = [
    item({ uid: "a", importance: 1 }),
    item({ uid: "b", importance: 2, date: 100 }),
    item({ uid: "c", importance: 3, date: 50 }),
    item({ uid: "d", importance: 2, date: 200 }),
  ];
  assert.deepEqual(pickImportant(items, 3).map((i) => i.uid), ["c"]);
  assert.deepEqual(pickImportant(items, 2).map((i) => i.uid), ["c", "d", "b"]);
});

test("formatAlert builds push title/body/tag + a proactive chat line", () => {
  const a = formatAlert(item({ uid: "9", accountId: "qq", subject: "Sign the lease", importance: 3 }));
  assert.equal(a.title, "📬 Important mail");
  assert.match(a.body, /Jane Doe: Sign the lease/);
  assert.equal(a.tag, "qq:9");
  assert.match(a.chat, /Important mail from Jane Doe/);
  assert.match(a.chat, /Sign the lease/);
  assert.match(a.chat, /awaiting your reply/);
});

test("alertLevel + pollMinutes read env with safe defaults", () => {
  assert.equal(alertLevel({ LISA_MAIL_ALERT_LEVEL: "2" } as NodeJS.ProcessEnv), 2);
  assert.equal(alertLevel({} as NodeJS.ProcessEnv), DEFAULT_ALERT_LEVEL);
  assert.equal(alertLevel({ LISA_MAIL_ALERT_LEVEL: "5" } as NodeJS.ProcessEnv), DEFAULT_ALERT_LEVEL);
  assert.equal(pollMinutes({} as NodeJS.ProcessEnv), DEFAULT_POLL_MINUTES);
  assert.equal(pollMinutes({ LISA_MAIL_POLL_MINUTES: "0" } as NodeJS.ProcessEnv), 0);
  assert.equal(pollMinutes({ LISA_MAIL_POLL_MINUTES: "15" } as NodeJS.ProcessEnv), 15);
});

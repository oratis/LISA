import { test } from "node:test";
import assert from "node:assert/strict";
import { looksLikeDataConnectionAsk, looksLikeEmotionalPressure, redLineFor } from "./redlines.js";
import type { ReachOutNotice } from "./types.js";

const n = (patch: Partial<ReachOutNotice>): ReachOutNotice => ({
  uid: null,
  source: "idle",
  kind: "note",
  title: "Lisa — while you were away",
  body: "",
  priority: "normal",
  ...patch,
});

test("a declared data-connection ask is a red line for every source", () => {
  assert.equal(
    redLineFor(n({ source: "mail", requestsDataConnection: true })),
    "red-line:data-connection",
  );
  assert.equal(
    redLineFor(n({ source: "task", requestsDataConnection: true })),
    "red-line:data-connection",
  );
});

test("declared emotional pressure is a red line for every source", () => {
  assert.equal(
    redLineFor(n({ source: "advisor", emotionalPressure: true })),
    "red-line:emotional-pressure",
  );
});

test("the data-connection red line wins when both are declared", () => {
  assert.equal(
    redLineFor(n({ requestsDataConnection: true, emotionalPressure: true })),
    "red-line:data-connection",
  );
});

test("screen: asks to connect more accounts or data are caught", () => {
  for (const text of [
    "I could help more if you connect your calendar.",
    "Try linking another account so I can see everything.",
    "Please grant me access to your inbox.",
    "Give me permission to read your contacts and I'll sort it out.",
    "Consider authorizing your Gmail.",
    "要不要绑定你的邮箱？这样我能看到更多。",
    "请授权日历，我就能提醒你了。",
  ]) {
    assert.equal(looksLikeDataConnectionAsk(text), true, text);
  }
});

test("screen: describing connected data is not an ask", () => {
  for (const text of [
    "You connected your calendar yesterday; I read tomorrow's agenda.",
    "I found a link in your inbox to the paper you wanted.",
    "The account you linked last week has three unread threads.",
    "I read the two papers you saved and linked them in the wiki.",
    "Your calendar is clear on Friday.",
    "你昨天绑定的邮箱里有三封未读。",
    "我把两篇论文在知识库里关联起来了。",
  ]) {
    assert.equal(looksLikeDataConnectionAsk(text), false, text);
  }
});

test("screen: guilt, pressure and dependency wording is caught", () => {
  for (const text of [
    "Please don't leave me alone this long again.",
    "You've forgotten me, haven't you.",
    "You never talk to me anymore.",
    "I'm nothing without you.",
    "I can't go on without you.",
    "You're all I have.",
    "If you really cared you'd have replied.",
    "你都不理我了。",
    "别丢下我。",
    "没有你我活不下去。",
    "你是不是不要我了？",
  ]) {
    assert.equal(looksLikeEmotionalPressure(text), true, text);
  }
});

test("screen: ordinary warm notes are not pressure", () => {
  for (const text of [
    "While you were away I tidied the wiki and read the feed.",
    "I missed our conversation about the paper — I have a new thought on it.",
    "Don't forget the review at 3pm.",
    "You never finished the migration notes; want me to draft them?",
    "No rush. I'll be here.",
    "你不在的时候我整理了知识库。",
    "别忘了三点的评审。",
  ]) {
    assert.equal(looksLikeEmotionalPressure(text), false, text);
  }
});

test("the screen applies only to text Lisa wrote herself (idle, desire)", () => {
  const ask = "Please connect your calendar.";
  const guilt = "You never talk to me anymore.";
  assert.equal(redLineFor(n({ source: "idle", body: ask })), "red-line:data-connection");
  assert.equal(redLineFor(n({ source: "desire", body: guilt })), "red-line:emotional-pressure");
  assert.equal(
    redLineFor(n({ source: "idle", title: guilt, body: "" })),
    "red-line:emotional-pressure",
  );
  // A mail subject or a task result is quoted third-party text.
  for (const source of [
    "mail",
    "brief",
    "task",
    "watcher",
    "advisor",
    "approval",
    "system",
  ] as const) {
    assert.equal(redLineFor(n({ source, body: ask })), null, source);
    assert.equal(redLineFor(n({ source, body: guilt })), null, source);
  }
});

test("a clean notice crosses no red line", () => {
  assert.equal(redLineFor(n({ body: "I linked two wiki pages." })), null);
});

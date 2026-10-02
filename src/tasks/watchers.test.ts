import { test } from "node:test";
import assert from "node:assert/strict";
import type { SafeFetchDependencies } from "../tools/web_fetch.js";
import type { Task, TriggerSpec, WatchState } from "./types.js";
import {
  createWatchCheck,
  observeCondition,
  safeRegexExec,
  selectHtml,
  type WatchMail,
  type WatcherDeps,
} from "./watchers.js";

const NOW = Date.parse("2026-10-02T08:00:00Z");
const signal = new AbortController().signal;

function watcher(trigger: TriggerSpec, watch?: WatchState): Task {
  return {
    id: "t_0123456789ab",
    version: 1,
    owner: null,
    kind: "watcher",
    title: "watch",
    instruction: "tell me",
    origin: { kind: "api" },
    host: "any",
    trigger,
    ...(watch ? { watch } : {}),
    budget: { tokens: 1000, wallclockMs: 1000, maxToolCalls: 1 },
    notify: "on_hit",
    state: "scheduled",
    enabled: true,
    createdDisabled: false,
    createdAt: 0,
    updatedAt: 0,
    authFailureCount: 0,
    runs: [],
  };
}

/** A public-looking host served from memory; counts what actually went out. */
function site(pages: () => { status?: number; type?: string; body: string }) {
  const requested: string[] = [];
  const safeFetch: SafeFetchDependencies = {
    lookup: async () => [{ address: "93.184.216.34", family: 4 }],
    transport: async (url) => {
      requested.push(url);
      const page = pages();
      return new Response(page.body, {
        status: page.status ?? 200,
        headers: { "content-type": page.type ?? "text/html" },
      });
    },
  };
  return { requested, deps: { safeFetch } satisfies WatcherDeps };
}

/** Poll repeatedly, threading the watch state the way the runner does. */
async function poll(
  trigger: TriggerSpec,
  deps: WatcherDeps,
  bodies: string[],
  onEach?: () => void,
) {
  const check = createWatchCheck(deps);
  let watch: WatchState | undefined;
  const hits: Array<string | null> = [];
  for (let i = 0; i < bodies.length; i++) {
    onEach?.();
    const outcome = await check(watcher(trigger, watch), { signal, now: NOW + i * 60_000 });
    assert.equal(outcome.error, undefined, `poll ${i}`);
    hits.push(outcome.hit ? outcome.hit.summary : null);
    watch = { ...outcome.watch, ...(outcome.hit ? { lastHitAt: NOW + i * 60_000 } : {}) };
  }
  return hits;
}

// ── helpers ──

test("selectHtml: tag, #id and .class, nested elements, several matches", () => {
  const html = `
    <div class="card featured"><span class="price">$1,299</span><div class="inner">in <b>stock</b></div></div>
    <div class="card"><span class="price">$949</span></div>
    <p id="stock">3 left</p><img class="price" src="x.png">`;
  assert.deepEqual(selectHtml(html, "span.price"), ["$1,299", "$949"]);
  assert.deepEqual(selectHtml(html, "#stock"), ["3 left"]);
  assert.deepEqual(selectHtml(html, "div.card.featured"), [
    '<span class="price">$1,299</span><div class="inner">in <b>stock</b></div>',
  ]);
  assert.deepEqual(selectHtml(html, "img.price"), [""]);
  assert.deepEqual(selectHtml(html, ".missing"), []);
});

test("safeRegexExec returns the first capture group, and gives up on catastrophic patterns", () => {
  assert.deepEqual(safeRegexExec("price: \\$(\\d+)", "Price: $42 today"), { match: "42" });
  assert.deepEqual(safeRegexExec("sold out", "In stock"), { match: null });
  assert.deepEqual(safeRegexExec("(", "x"), { error: "invalid regular expression" });
  const started = Date.now();
  const result = safeRegexExec("^(a+)+$", `${"a".repeat(40)}!`);
  assert.deepEqual(result, { error: "regular expression took too long on this page" });
  assert.ok(Date.now() - started < 3000, "bounded, not minutes");
});

test("observeCondition fires on the rising edge and needs two contrary readings to re-arm", () => {
  const seq = [false, true, true, false, true, false, false, true];
  const fired: boolean[] = [];
  let watch: WatchState | undefined;
  for (const condition of seq) {
    const step = observeCondition(watch, condition);
    fired.push(step.fire);
    watch = step.watch;
  }
  //                     F      T     T      F(1)   T      F(1)   F(2)   T
  assert.deepEqual(fired, [false, true, false, false, false, false, false, true]);
  assert.equal(
    observeCondition(undefined, true).fire,
    true,
    "already true on the first look is a hit",
  );
});

// ── web ──

test("web/changed: the first look is a baseline; a change hits once; flapping back stays quiet", async () => {
  let body = "";
  const { deps } = site(() => ({
    body: `<html><body><h1>${body}</h1><script>ads(${Math.random()})</script></body></html>`,
  }));
  const bodies = ["Closed", "Closed", "Open", "Open", "Closed", "Open", "Sold out"];
  let i = 0;
  const hits = await poll(
    { kind: "web", url: "https://example.com/status", mode: "changed" },
    deps,
    bodies,
    () => {
      body = bodies[i++]!;
    },
  );
  assert.deepEqual(
    hits.map((h) => h !== null),
    //  base   same   change same   back   again  new
    [false, false, true, false, false, false, true],
    "script noise is stripped; a return to already-reported content is not news",
  );
  assert.equal(hits[2], "example.com changed.");
});

test("web/appears + contains: edge-triggered, with hysteresis against a flapping page", async () => {
  let body = "";
  const { deps } = site(() => ({ body: `<p>${body}</p>` }));
  const bodies = [
    "Sold out",
    "AVAILABLE now",
    "available",
    "Sold out",
    "Available",
    "Sold out",
    "Sold out",
    "Available",
  ];
  let i = 0;
  const hits = await poll(
    { kind: "web", url: "https://example.com/camp", mode: "appears", contains: "available" },
    deps,
    bodies,
    () => {
      body = bodies[i++]!;
    },
  );
  assert.deepEqual(
    hits.map((h) => h !== null),
    [false, true, false, false, false, false, false, true],
  );
  assert.equal(hits[1], '"available" is now on example.com.');
});

test("web/disappears: fires when the text (or the selected element) goes away", async () => {
  let body = "";
  const { deps } = site(() => ({ body }));
  const bodies = [
    '<div id="banner">Waitlist only</div>',
    '<div id="banner">Waitlist only</div>',
    "<div>Book now</div>",
  ];
  let i = 0;
  const bySelector = await poll(
    { kind: "web", url: "https://example.com/", mode: "disappears", selector: "#banner" },
    deps,
    bodies,
    () => {
      body = bodies[i++]!;
    },
  );
  assert.deepEqual(
    bySelector.map((h) => h !== null),
    [false, false, true],
  );
  i = 0;
  const byText = await poll(
    { kind: "web", url: "https://example.com/", mode: "disappears", contains: "waitlist" },
    deps,
    bodies,
    () => {
      body = bodies[i++]!;
    },
  );
  assert.deepEqual(
    byText.map((h) => h !== null),
    [false, false, true],
  );
});

test("web/below with selector + regex reads a price and fires when it crosses the threshold", async () => {
  let price = "";
  const { deps } = site(() => ({
    body: `<div class="other">$5</div><span class="price">Now: ${price} <small>was $1,499.00</small></span>`,
  }));
  const prices = ["$1,299.00", "$1,050", "$949.50", "$930", "$1,200", "$1,200", "$899"];
  let i = 0;
  const hits = await poll(
    {
      kind: "web",
      url: "https://shop.example.com/item",
      mode: "below",
      selector: "span.price",
      regex: "Now: \\$([\\d,.]+)",
      threshold: 1000,
    },
    deps,
    prices,
    () => {
      price = prices[i++]!;
    },
  );
  assert.deepEqual(hits, [
    null,
    null,
    "shop.example.com: 949.5 is below 1000.",
    null,
    null,
    null,
    "shop.example.com: 899 is below 1000.",
  ]);
});

test("web: a non-2xx page, a missing number and a runaway regex are failures, not hits", async () => {
  const check = createWatchCheck(site(() => ({ status: 503, body: "busy" })).deps);
  const down = await check(
    watcher({ kind: "web", url: "https://example.com/", mode: "disappears", contains: "x" }),
    {
      signal,
      now: NOW,
    },
  );
  assert.match(down.error!, /HTTP 503/);
  assert.equal(down.hit, undefined, "an outage must not look like 'it disappeared'");
  assert.equal(down.watch.failures, 1);

  const noNumber = await createWatchCheck(site(() => ({ body: "<p>call us</p>" })).deps)(
    watcher(
      { kind: "web", url: "https://example.com/", mode: "above", threshold: 5 },
      { failures: 2 },
    ),
    { signal, now: NOW },
  );
  assert.match(noNumber.error!, /no number found/);
  assert.equal(noNumber.watch.failures, 3);

  const slow = await createWatchCheck(site(() => ({ body: `<p>${"a".repeat(40)}!</p>` })).deps)(
    watcher({ kind: "web", url: "https://example.com/", mode: "appears", regex: "^(a+)+$" }),
    { signal, now: NOW },
  );
  assert.match(slow.error!, /took too long/);
});

// ── SSRF ──

test("a watcher cannot be pointed at loopback, private, link-local or metadata addresses", async () => {
  const { requested, deps } = site(() => ({ body: "secret" }));
  const check = createWatchCheck(deps);
  for (const url of [
    "http://127.0.0.1:8080/admin",
    "http://localhost/",
    "http://10.0.0.5/",
    "http://192.168.1.1/router",
    "http://169.254.169.254/latest/meta-data/",
    "http://[::1]/",
  ]) {
    for (const trigger of [
      { kind: "web", url, mode: "changed" },
      { kind: "rss", url },
    ] as TriggerSpec[]) {
      const outcome = await check(watcher(trigger), { signal, now: NOW });
      assert.match(outcome.error ?? "", /refusing|blocked|private|loopback/i, url);
      assert.equal(outcome.hit, undefined);
      assert.equal(outcome.watch.failures, 1);
    }
  }
  assert.deepEqual(requested, [], "nothing was sent");
});

test("a public name that resolves to a private address, or redirects to one, is refused", async () => {
  const sent: string[] = [];
  const rebinding = createWatchCheck({
    safeFetch: {
      lookup: async () => [{ address: "10.1.2.3", family: 4 }],
      transport: async (url) => {
        sent.push(url);
        return new Response("internal");
      },
    },
  });
  const a = await rebinding(
    watcher({ kind: "web", url: "https://innocent.example.com/", mode: "changed" }),
    {
      signal,
      now: NOW,
    },
  );
  assert.match(a.error!, /blocked address 10\.1\.2\.3/);
  assert.deepEqual(sent, []);

  const redirecting = createWatchCheck({
    safeFetch: {
      lookup: async () => [{ address: "93.184.216.34", family: 4 }],
      transport: async (url) => {
        sent.push(url);
        return new Response(null, {
          status: 302,
          headers: { location: "http://169.254.169.254/latest/meta-data/" },
        });
      },
    },
  });
  const b = await redirecting(
    watcher({ kind: "web", url: "https://innocent.example.com/", mode: "changed" }),
    {
      signal,
      now: NOW,
    },
  );
  assert.match(b.error!, /refusing to fetch private\/loopback host/);
  assert.deepEqual(
    sent,
    ["https://innocent.example.com/"],
    "the redirect target was never requested",
  );
});

// ── rss ──

function feed(items: Array<{ id: string; title: string; summary?: string }>): string {
  return `<?xml version="1.0"?><rss version="2.0"><channel><title>Release notes</title>${items
    .map(
      (i) =>
        `<item><guid>${i.id}</guid><title>${i.title}</title><link>https://example.com/${i.id}</link>` +
        `<description>${i.summary ?? ""}</description></item>`,
    )
    .join("")}</channel></rss>`;
}

test("rss: existing items are a baseline; only new items matching a keyword hit, once", async () => {
  let items = [
    { id: "1", title: "v1.0 released" },
    { id: "2", title: "Security advisory for v0.9" },
  ];
  const { deps } = site(() => ({ type: "application/rss+xml", body: feed(items) }));
  const check = createWatchCheck(deps);
  const trigger: TriggerSpec = {
    kind: "rss",
    url: "https://example.com/feed.xml",
    keywords: ["security", "CVE"],
  };

  const first = await check(watcher(trigger), { signal, now: NOW });
  assert.equal(first.hit, undefined, "the backlog is not news");
  assert.deepEqual(first.watch.seen, ["1", "2"]);

  items = [{ id: "3", title: "v1.1 released" }, ...items];
  const boring = await check(watcher(trigger, first.watch), { signal, now: NOW });
  assert.equal(boring.hit, undefined, "new, but no keyword");
  assert.deepEqual(boring.watch.seen, ["1", "2", "3"]);

  items = [
    { id: "5", title: "Patch notes", summary: "Fixes cve-2026-1234 in the parser" },
    { id: "4", title: "SECURITY: rotate your tokens" },
    ...items,
  ];
  const hit = await check(watcher(trigger, boring.watch), { signal, now: NOW });
  assert.equal(hit.hit!.summary, "2 new items in Release notes.");
  assert.match(hit.hit!.detail!, /Patch notes — https:\/\/example\.com\/5/);
  assert.match(hit.hit!.detail!, /SECURITY: rotate your tokens/);

  // The same poll repeated from the OLD state (a lost state write) yields the same key.
  const replay = await check(watcher(trigger, boring.watch), { signal, now: NOW + 1 });
  assert.equal(replay.hit!.key, hit.hit!.key);
  // …and from the new state, nothing.
  assert.equal((await check(watcher(trigger, hit.watch), { signal, now: NOW })).hit, undefined);
});

test("rss with no keywords reports every new item", async () => {
  let items = [{ id: "1", title: "one" }];
  const { deps } = site(() => ({ type: "application/xml", body: feed(items) }));
  const check = createWatchCheck(deps);
  const trigger: TriggerSpec = { kind: "rss", url: "https://example.com/feed.xml" };
  const base = await check(watcher(trigger), { signal, now: NOW });
  items = [{ id: "2", title: "two" }, ...items];
  const next = await check(watcher(trigger, base.watch), { signal, now: NOW });
  assert.equal(next.hit!.summary, "1 new item in Release notes.");
});

// ── mail ──

const mail = (uid: string, from: string, subject: string): WatchMail => ({
  uid,
  accountId: "acct1",
  from: `${from} <${from.toLowerCase().replace(/\s+/g, ".")}@example.com>`,
  fromAddress: `${from.toLowerCase().replace(/\s+/g, ".")}@example.com`,
  subject,
  date: NOW,
});

test("mail: baseline first, then new mail matching sender and subject — metadata only", async () => {
  let inbox = [mail("1", "Landlord", "Rent reminder"), mail("2", "Newsletter", "Weekly digest")];
  const sinceSeen: number[] = [];
  const check = createWatchCheck({
    listMail: async (sinceMs) => {
      sinceSeen.push(sinceMs);
      return inbox;
    },
  });
  const trigger: TriggerSpec = { kind: "mail", from: "landlord", subject: "rent" };
  const base = await check(watcher(trigger), { signal, now: NOW });
  assert.equal(base.hit, undefined);
  assert.deepEqual(base.watch.seen, ["acct1:1"]);
  assert.equal(sinceSeen[0], NOW - 24 * 3_600_000);

  inbox = [
    ...inbox,
    mail("3", "Landlord", "Lease renewal"),
    mail("4", "Landlord", "RENT increase notice"),
  ];
  const hit = await check(watcher(trigger, base.watch), { signal, now: NOW + 60_000 });
  assert.equal(hit.hit!.summary, "1 new matching message.");
  assert.match(hit.hit!.detail!, /Landlord <landlord@example\.com>: RENT increase notice/);
  assert.deepEqual(hit.watch.seen, ["acct1:1", "acct1:4"]);
  assert.equal((await check(watcher(trigger, hit.watch), { signal, now: NOW })).hit, undefined);
});

test("mail: a one-time code or sign-in link in a subject never reaches the hit", async () => {
  let inbox: WatchMail[] = [];
  const check = createWatchCheck({ listMail: async () => inbox });
  const trigger: TriggerSpec = { kind: "mail", from: "bank" };
  const base = await check(watcher(trigger), { signal, now: NOW });
  inbox = [
    mail("7", "Bank", "Your verification code is 482913"),
    mail("8", "Bank", "Sign in: https://bank.example.com/login?token=abcdef0123456789abcdef"),
  ];
  const hit = await check(watcher(trigger, base.watch), { signal, now: NOW + 60_000 });
  assert.equal(hit.hit!.summary, "2 new matching messages.");
  const said = `${hit.hit!.summary}\n${hit.hit!.detail}`;
  assert.ok(!said.includes("482913"), "the code is gone");
  assert.ok(!said.includes("abcdef0123456789abcdef"), "the sign-in token is gone");
  assert.match(said, /Bank/);
});

test("mail: an unconnected mail module is a failure the user is told about, not a silent no-op", async () => {
  const check = createWatchCheck({
    listMail: async () => {
      throw new Error("no mailbox is connected");
    },
  });
  const outcome = await check(watcher({ kind: "mail", from: "x" }), { signal, now: NOW });
  assert.equal(outcome.error, "no mailbox is connected");
  assert.equal(outcome.watch.failures, 1);
});

test("mail: with consent not granted the default path refuses before touching any mailbox", async () => {
  const previous = process.env.LISA_HOME;
  const os = await import("node:os");
  const fs = await import("node:fs");
  const path = await import("node:path");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "lisa-watch-mail-"));
  process.env.LISA_HOME = home;
  try {
    const outcome = await createWatchCheck()(watcher({ kind: "mail", from: "x" }), {
      signal,
      now: NOW,
    });
    assert.match(outcome.error!, /mail access has not been granted/);
  } finally {
    if (previous === undefined) delete process.env.LISA_HOME;
    else process.env.LISA_HOME = previous;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

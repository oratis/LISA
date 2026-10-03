import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import type { ToolContext } from "../types.js";
import { SEARCH_OUTBOUND_POLICY, createWebSearchTool, parseDuckDuckGo } from "./web_search.js";
import type { DnsLookupAll, ResolvedAddress } from "./web_fetch.js";

const PUBLIC: ResolvedAddress = { address: "93.184.216.34", family: 4 };
const publicLookup: DnsLookupAll = async () => [PUBLIC];
const ctx = (): ToolContext => ({ cwd: "/", signal: new AbortController().signal, log: () => {} });

const PAGE = `
<a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.org%2Fa&amp;rut=1">Alpha</a>
<a class="result__snippet" href="#">about alpha</a>
<a rel="nofollow" class="result__a" href="https://example.net/b">Beta</a>
<a class="result__snippet" href="#">about beta</a>
<a rel="nofollow" class="result__a" href="ftp://example.net/c">Gamma</a>
<a class="result__snippet" href="#">about gamma</a>`;
const page = (): Response =>
  new Response(PAGE, { status: 200, headers: { "content-type": "text/html" } });

// These tests describe the LOCAL edition; the hosted behaviour is in cloud_web.test.ts.
// The local default egress is the process fetch, so it is replaced for the run:
// a test that forgets its stub fails instead of reaching the real provider.
let previousEdition: string | undefined;
const realFetch = globalThis.fetch;
before(() => {
  previousEdition = process.env.LISA_EDITION;
  delete process.env.LISA_EDITION;
  globalThis.fetch = async () => {
    throw new Error("web_search test tried to reach the network");
  };
});
after(() => {
  globalThis.fetch = realFetch;
  if (previousEdition !== undefined) process.env.LISA_EDITION = previousEdition;
});

describe("parseDuckDuckGo", () => {
  test("unwraps redirect links, keeps http(s) results only, honours the limit", () => {
    assert.deepEqual(parseDuckDuckGo(PAGE, 10), [
      { title: "Alpha", url: "https://example.org/a", snippet: "about alpha" },
      { title: "Beta", url: "https://example.net/b", snippet: "about beta" },
    ]);
    assert.equal(parseDuckDuckGo(PAGE, 1).length, 1);
    assert.deepEqual(parseDuckDuckGo("<html></html>", 10), []);
  });

  test("hostile result markup is parsed in one linear pass", () => {
    // ~12 KB of the first shape took ~50 s with the previous regexes (review F1);
    // 1 MB is the most of a results page the tool ever reads.
    const shapes: Array<[string, (size: number) => string, number]> = [
      ["unclosed result anchors", (n) => '<a class="result__a" href="x"'.repeat(n / 29), 0],
      ["an unterminated class", (n) => '<a class="result__a ' + "x ".repeat(n / 2), 0],
      ["bare anchors", (n) => "<a ".repeat(n / 3), 0],
      [
        "endless complete results",
        (n) => '<a class="result__a" href="https://e.example/">t</a>'.repeat(n / 50),
        20,
      ],
    ];
    for (const [label, build, expected] of shapes) {
      for (const size of [12_000, 1_000_000]) {
        const html = build(size);
        const started = performance.now();
        const results = parseDuckDuckGo(html, 20);
        const elapsed = performance.now() - started;
        assert.equal(results.length, expected, label);
        assert.ok(elapsed < 250, `${label} at ${size} chars: ${elapsed.toFixed(0)} ms`);
      }
    }
  });
});

describe("SEARCH_OUTBOUND_POLICY", () => {
  test("only the provider's own hosts, over https on 443", () => {
    const allow = SEARCH_OUTBOUND_POLICY.allowHost!;
    assert.equal(allow("html.duckduckgo.com"), true);
    assert.equal(allow("duckduckgo.com"), true);
    assert.equal(allow("evilduckduckgo.com"), false);
    assert.equal(allow("duckduckgo.com.evil.example"), false);
    assert.deepEqual(SEARCH_OUTBOUND_POLICY.allowedProtocols, ["https:"]);
    assert.deepEqual(SEARCH_OUTBOUND_POLICY.allowedPorts, [443]);
  });
});

describe("web_search — local edition default egress", () => {
  test("is the process fetch even with no proxy configured (Clash / Surge fake-ip DNS)", async () => {
    // TUN "fake-ip" mode answers 198.18.0.0/15 for every name and sets no
    // *_PROXY variable. The guarded path refuses that answer as reserved, so a
    // guarded default broke local search for these users (review F2).
    let lookups = 0;
    let pinnedSends = 0;
    const calls: string[] = [];
    const tool = createWebSearchTool({
      lookup: async () => {
        lookups++;
        return [{ address: "198.18.0.7", family: 4 }];
      },
      transport: async () => {
        pinnedSends++;
        return page();
      },
      ambientFetch: async (input: string | URL | Request) => {
        calls.push(String(input));
        return page();
      },
    });
    const out = await tool.execute({ query: "weather" }, ctx());
    assert.deepEqual(calls, ["https://html.duckduckgo.com/html/?q=weather"]);
    assert.equal(lookups, 0);
    assert.equal(pinnedSends, 0);
    assert.match(out, /1\. Alpha/);
  });

  test("the hosted edition stays guarded, whatever options are passed", async () => {
    const previous = process.env.LISA_EDITION;
    process.env.LISA_EDITION = "cloud";
    try {
      for (const egress of [undefined, "ambient", "guarded"] as const) {
        let ambientCalls = 0;
        const sent: string[] = [];
        const tool = createWebSearchTool({
          ...(egress ? { egress } : {}),
          lookup: publicLookup,
          transport: async (url) => {
            sent.push(url);
            return page();
          },
          ambientFetch: async () => {
            ambientCalls++;
            return page();
          },
        });
        await tool.execute({ query: "x" }, ctx());
        assert.equal(ambientCalls, 0, String(egress));
        assert.equal(sent.length, 1, String(egress));
      }
    } finally {
      if (previous === undefined) delete process.env.LISA_EDITION;
      else process.env.LISA_EDITION = previous;
    }
  });
});

describe("web_search — guarded egress (always in cloud, opt-in locally)", () => {
  test("resolves, validates and pins the provider address", async () => {
    const sent: Array<{ url: string; pinned: ResolvedAddress; ua: string | null }> = [];
    const tool = createWebSearchTool({
      egress: "guarded",
      lookup: publicLookup,
      transport: async (url, init, pinned) => {
        sent.push({ url, pinned, ua: new Headers(init.headers).get("user-agent") });
        return page();
      },
    });
    const out = await tool.execute({ query: "hello world", limit: 1 }, ctx());
    assert.equal(sent.length, 1);
    assert.equal(sent[0]!.url, "https://html.duckduckgo.com/html/?q=hello%20world");
    assert.deepEqual(sent[0]!.pinned, PUBLIC);
    assert.match(sent[0]!.ua ?? "", /Mozilla/);
    assert.match(out, /1\. Alpha/);
    assert.equal(out.includes("Beta"), false);
  });

  test("a provider name that resolves to a private address is refused", async () => {
    let sent = 0;
    const tool = createWebSearchTool({
      egress: "guarded",
      lookup: async () => [{ address: "127.0.0.1", family: 4 }],
      transport: async () => {
        sent++;
        return page();
      },
    });
    await assert.rejects(() => tool.execute({ query: "x" }, ctx()), /blocked address/);
    assert.equal(sent, 0);
  });

  test("a redirect off the provider is refused", async () => {
    const tool = createWebSearchTool({
      egress: "guarded",
      lookup: publicLookup,
      transport: async () =>
        new Response(null, { status: 302, headers: { location: "http://169.254.169.254/" } }),
    });
    await assert.rejects(() => tool.execute({ query: "x" }, ctx()), /private\/loopback/);
  });
});

describe("web_search — ambient egress (the local default)", () => {
  test("uses the process fetch, with redirects handled manually", async () => {
    const calls: Array<{ url: string; redirect: RequestRedirect | undefined }> = [];
    const tool = createWebSearchTool({
      egress: "ambient",
      ambientFetch: async (input: string | URL | Request, init?: RequestInit) => {
        calls.push({ url: String(input), redirect: init?.redirect });
        return page();
      },
    });
    const out = await tool.execute({ query: "x" }, ctx());
    assert.deepEqual(calls, [{ url: "https://html.duckduckgo.com/html/?q=x", redirect: "manual" }]);
    assert.match(out, /Alpha/);
  });

  for (const [label, location, pattern] of [
    ["an internal address", "http://127.0.0.1:8080/", /private\/loopback/],
    ["the metadata IP", "http://169.254.169.254/", /private\/loopback/],
    ["another site", "https://attacker.example.com/", /refuses host/],
  ] as const) {
    test(`a redirect to ${label} is refused even without address pinning`, async () => {
      let calls = 0;
      const tool = createWebSearchTool({
        egress: "ambient",
        ambientFetch: async () => {
          calls++;
          return new Response(null, { status: 302, headers: { location } });
        },
      });
      await assert.rejects(() => tool.execute({ query: "x" }, ctx()), pattern);
      assert.equal(calls, 1);
    });
  }

  test("a redirect loop inside the provider is cut off", async () => {
    const tool = createWebSearchTool({
      egress: "ambient",
      ambientFetch: async () =>
        new Response(null, {
          status: 302,
          headers: { location: "https://duckduckgo.com/html/" },
        }),
    });
    await assert.rejects(() => tool.execute({ query: "x" }, ctx()), /too many redirects/);
  });
});

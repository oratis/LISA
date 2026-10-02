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
let previousEdition: string | undefined;
before(() => {
  previousEdition = process.env.LISA_EDITION;
  delete process.env.LISA_EDITION;
});
after(() => {
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

describe("web_search — guarded egress (the default without a proxy)", () => {
  test("resolves, validates and pins the provider address", async () => {
    const sent: Array<{ url: string; pinned: ResolvedAddress; ua: string | null }> = [];
    const tool = createWebSearchTool({
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
      lookup: publicLookup,
      transport: async () =>
        new Response(null, { status: 302, headers: { location: "http://169.254.169.254/" } }),
    });
    await assert.rejects(() => tool.execute({ query: "x" }, ctx()), /private\/loopback/);
  });
});

describe("web_search — ambient egress (local user behind a proxy)", () => {
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

import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  isPrivateHost,
  assertAllowedUrl,
  fetchFollowingSafeRedirects,
} from "./web_fetch.js";

describe("isPrivateHost — blocks internal ranges", () => {
  for (const h of [
    "localhost",
    "127.0.0.1",
    "127.1.2.3",
    "10.0.0.5",
    "192.168.1.1",
    "169.254.169.254", // cloud metadata endpoint — the classic SSRF target
    "172.16.0.1",
    "172.31.255.255",
    "0.0.0.0",
    "::1",
    "fc00::1",
    "fd12:3456::1",
    "fe80::1",
  ]) {
    test(`blocks ${h}`, () => assert.equal(isPrivateHost(h), true));
  }
});

describe("isPrivateHost — allows public hosts", () => {
  for (const h of ["example.com", "8.8.8.8", "1.1.1.1", "github.com", "172.32.0.1", "11.0.0.1"]) {
    test(`allows ${h}`, () => assert.equal(isPrivateHost(h), false));
  }
});

describe("assertAllowedUrl", () => {
  test("rejects non-http(s) protocols", () => {
    assert.throws(() => assertAllowedUrl(new URL("ftp://example.com/x")), /only http/);
    assert.throws(() => assertAllowedUrl(new URL("file:///etc/passwd")), /only http/);
  });
  test("rejects private hosts", () => {
    assert.throws(() => assertAllowedUrl(new URL("http://127.0.0.1:8000/")), /private/);
    assert.throws(() => assertAllowedUrl(new URL("http://169.254.169.254/latest/meta-data/")), /private/);
  });
  test("strips IPv6 brackets before checking", () => {
    assert.throws(() => assertAllowedUrl(new URL("http://[::1]:9000/")), /private/);
  });
  test("accepts public https", () => {
    assert.doesNotThrow(() => assertAllowedUrl(new URL("https://example.com/page")));
  });
});

describe("fetchFollowingSafeRedirects — closes the SSRF redirect bypass", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  function stubFetch(handler: (url: string) => Response) {
    globalThis.fetch = (async (input: any) => {
      const url = typeof input === "string" ? input : input.url;
      return handler(url);
    }) as typeof fetch;
  }

  test("a public URL that 302s to 127.0.0.1 is REFUSED (the exploit)", async () => {
    stubFetch((url) => {
      if (url.startsWith("https://evil.example.com")) {
        return new Response(null, { status: 302, headers: { location: "http://127.0.0.1:8000/secret" } });
      }
      return new Response("LEAKED INTERNAL DATA", { status: 200 });
    });
    await assert.rejects(
      () => fetchFollowingSafeRedirects("https://evil.example.com/start", undefined),
      /private\/loopback/,
    );
  });

  test("redirect to cloud metadata IP is refused", async () => {
    stubFetch((url) => {
      if (url.includes("evil"))
        return new Response(null, { status: 301, headers: { location: "http://169.254.169.254/latest/meta-data/iam/" } });
      return new Response("creds", { status: 200 });
    });
    await assert.rejects(
      () => fetchFollowingSafeRedirects("https://evil.example.com/", undefined),
      /private\/loopback/,
    );
  });

  test("a normal 200 passes through", async () => {
    stubFetch(() => new Response("hello", { status: 200, headers: { "content-type": "text/plain" } }));
    const res = await fetchFollowingSafeRedirects("https://example.com/ok", undefined);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), "hello");
  });

  test("redirect chain between public hosts is followed", async () => {
    let hops = 0;
    stubFetch((url) => {
      hops++;
      if (url === "https://a.example.com/") return new Response(null, { status: 302, headers: { location: "https://b.example.com/" } });
      if (url === "https://b.example.com/") return new Response("final", { status: 200 });
      return new Response("?", { status: 404 });
    });
    const res = await fetchFollowingSafeRedirects("https://a.example.com/", undefined);
    assert.equal(await res.text(), "final");
    assert.equal(hops, 2);
  });

  test("redirect loop is capped (>5 hops throws)", async () => {
    stubFetch((url) => {
      // Always bounce to a fresh public URL → infinite loop without the cap.
      const n = Number(new URL(url).searchParams.get("n") ?? "0");
      return new Response(null, { status: 302, headers: { location: `https://x.example.com/?n=${n + 1}` } });
    });
    await assert.rejects(
      () => fetchFollowingSafeRedirects("https://x.example.com/?n=0", undefined),
      /too many redirects/,
    );
  });
});

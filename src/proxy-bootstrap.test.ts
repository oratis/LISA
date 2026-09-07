import { test, describe } from "node:test";
import assert from "node:assert/strict";

// The module keeps process-wide state (one ProxyAgent per process), so these
// tests are ordered: the no-proxy case runs before anything installs, and the
// verbose-announce case loads a fresh module instance via a query-string
// specifier so it starts from "not installed" again. node --test runs each
// file in its own process, so the global dispatcher never leaks into other
// suites.
const PROXY_VARS = ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"] as const;
function clearProxyEnv(): void {
  for (const k of PROXY_VARS) delete process.env[k];
}

describe("configureProxyFromEnv", () => {
  test("no proxy env → nothing installed, nothing logged, no status line", async () => {
    clearProxyEnv();
    const mod = await import("./proxy-bootstrap.js");
    const logs: string[] = [];
    mod.configureProxyFromEnv({ log: (m) => logs.push(m), verbose: true });
    assert.deepEqual(logs, []);
    assert.equal(mod.isProxyInstalled(), false);
    assert.equal(mod.proxyStatusLine(), null);
  });

  test("quiet by default: installs the bridge without printing the banner", async () => {
    clearProxyEnv();
    process.env.HTTPS_PROXY = "http://127.0.0.1:7897";
    const mod = await import("./proxy-bootstrap.js");
    const logs: string[] = [];
    mod.configureProxyFromEnv({ log: (m) => logs.push(m) });
    assert.deepEqual(logs, [], "the success banner is opt-in");
    assert.equal(mod.isProxyInstalled(), true);
    // …but the same line stays available for serve startup / doctor.
    assert.equal(
      mod.proxyStatusLine(),
      "[proxy] outbound HTTP routed through http://127.0.0.1:7897 (Accept-Encoding=identity)",
    );
  });

  test("idempotent: a later verbose call neither re-installs nor re-announces", async () => {
    const mod = await import("./proxy-bootstrap.js");
    const logs: string[] = [];
    mod.configureProxyFromEnv({ log: (m) => logs.push(m), verbose: true });
    assert.deepEqual(logs, []);
  });

  test("verbose: announces exactly once on install (fresh module instance)", async () => {
    clearProxyEnv();
    process.env.HTTPS_PROXY = "http://127.0.0.1:7897";
    const fresh = (await import("./proxy-bootstrap.js?instance=verbose")) as typeof import("./proxy-bootstrap.js");
    assert.equal(fresh.isProxyInstalled(), false, "query-string import must yield a new module instance");
    const logs: string[] = [];
    fresh.configureProxyFromEnv({ log: (m) => logs.push(m), verbose: true });
    fresh.configureProxyFromEnv({ log: (m) => logs.push(m), verbose: true });
    assert.deepEqual(logs, [
      "[proxy] outbound HTTP routed through http://127.0.0.1:7897 (Accept-Encoding=identity)",
    ]);
  });
});

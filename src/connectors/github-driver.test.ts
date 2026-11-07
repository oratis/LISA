import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { LocalGitHubDriver } from "./github-driver.js";
import type { PinnedTransport } from "../tools/web_fetch.js";
const repo = { id: 42, fullName: "octocat/project", private: true };
const repoJson = { id: 42, full_name: "octocat/project", private: true };
const lookup = async () => [{ address: "140.82.113.6", family: 4 as const }];
const signal = () => AbortSignal.timeout(5000);

test("all GitHub reads are GET to the fixed HTTPS host, with pinned DNS and no redirects", async () => {
  const seen: string[] = [];
  const transport: PinnedTransport = async (url, init, pinned) => {
    assert.equal(new URL(url).origin, "https://api.github.com");
    assert.equal(init.method, "GET");
    assert.equal(init.redirect, "manual");
    assert.equal(pinned.address, "140.82.113.6");
    assert.equal((init.headers as Record<string, string>).Authorization, "Bearer fixture-token");
    seen.push(new URL(url).pathname);
    return Response.json(url.includes("?per_page") ? [] : repoJson);
  };
  const driver = new LocalGitHubDriver({ network: { lookup, transport } });
  await driver.read("fixture-token", repo, "commits", signal());
  assert.deepEqual(seen, ["/repos/octocat/project", "/repos/octocat/project/commits"]);
  await assert.rejects(
    driver.repository("fixture-token", "owner/repo?redirect=evil", signal()),
    /invalid_repository/,
  );
  await assert.rejects(
    driver.repository("fixture-token", "owner/..", signal()),
    /invalid_repository/,
  );
});

test("DNS rebinding, redirects and repository identity changes fail closed", async () => {
  const privateDNS = new LocalGitHubDriver({
    network: {
      lookup: async () => [{ address: "127.0.0.1", family: 4 }],
      transport: async () => assert.fail("must not connect"),
    },
  });
  await assert.rejects(privateDNS.account("secret", signal()), /github_unavailable/);
  let calls = 0;
  const redirect = new LocalGitHubDriver({
    network: {
      lookup,
      transport: async () => {
        calls++;
        return new Response(null, { status: 302, headers: { location: "https://evil.example" } });
      },
    },
  });
  await assert.rejects(redirect.account("secret", signal()), /github_request_failed/);
  assert.equal(calls, 1);
  const replaced = new LocalGitHubDriver({
    network: { lookup, transport: async () => Response.json({ ...repoJson, id: 99 }) },
  });
  await assert.rejects(
    replaced.read("secret", repo, "commits", signal()),
    /github_repository_changed/,
  );
});

test("device login uses an isolated config, pins the verified account, cleans temporary files", async () => {
  let configPath = "";
  const args: string[][] = [];
  let code = "";
  const driver = new LocalGitHubDriver({
    network: { lookup, transport: async () => Response.json({ id: 12, login: "octocat" }) },
    runGh: async (argv, _signal, config, emit) => {
      args.push(argv);
      configPath = config!;
      assert.equal((await fs.stat(config!)).mode & 0o777, 0o700);
      if (argv[1] === "login") {
        emit!("ABCD-1234");
        return "";
      }
      if (argv[1] === "status")
        return JSON.stringify({
          hosts: { "github.com": [{ login: "octocat", state: "success", tokenSource: "keyring" }] },
        });
      return "fixture-token";
    },
  });
  const result = await driver.authorize("login", signal(), (value) => {
    code = value;
  });
  assert.equal(result.account.id, 12);
  assert.equal(code, "ABCD-1234");
  assert.deepEqual(args[2], ["auth", "token", "--hostname", "github.com", "--user", "octocat"]);
  await assert.rejects(fs.stat(configPath), { code: "ENOENT" });
});

test("gh plaintext fallback is refused and its temporary credential file is removed", async () => {
  let configPath = "";
  const driver = new LocalGitHubDriver({
    runGh: async (args, _signal, config) => {
      configPath = config!;
      if (args[1] === "login") {
        await fs.writeFile(config! + "/hosts.yml", "fixture-secret");
        return "";
      }
      if (args[1] === "status")
        return JSON.stringify({
          hosts: {
            "github.com": [{ login: "octocat", state: "success", tokenSource: "oauth_token" }],
          },
        });
      assert.fail("must not import an insecure token");
    },
  });
  await assert.rejects(
    driver.authorize("login", signal(), () => {}),
    /github_secure_storage_required/,
  );
  await assert.rejects(fs.stat(configPath), { code: "ENOENT" });
});

test("HTTP failures never expose tokens or response bodies in errors", async () => {
  const driver = new LocalGitHubDriver({
    network: { lookup, transport: async () => new Response("fixture-token", { status: 401 }) },
  });
  await assert.rejects(driver.account("fixture-token", signal()), (error) => {
    assert.equal((error as Error).message, "github_reauthorization_required");
    return true;
  });
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { LinearReadonlyDriver, isLinearReadRequest, LINEAR_READ_TOOLS } from "./linear-driver.js";
import { LINEAR_ENDPOINT, type LinearCredential } from "./linear-oauth.js";
import type { CredentialAccess } from "./types.js";
import { ConnectorError } from "./types.js";
const user = {
  id: "00000000-0000-4000-8000-000000000001",
  name: "Fixture",
  email: "fixture@example.com",
};
const team = {
  id: "00000000-0000-4000-8000-000000000002",
  name: "Selected team",
  access: "team" as const,
};
const another = "00000000-0000-4000-8000-000000000003";
const issue = {
  id: "FIX-1",
  uuid: "00000000-0000-4000-8000-000000000004",
  teamId: team.id,
  identifier: "FIX-1",
  title: "A task",
  url: "https://linear.app/fixture/issue/FIX-1",
};
const signal = () => AbortSignal.timeout(5000);
function credentials(expiry = Date.now() + 3600_000) {
  let c: LinearCredential = {
      clientId: "client",
      accessToken: "fixture-access",
      refreshToken: "fixture-refresh",
      expiry,
      scope: "read",
    },
    replacements = 0;
  const access: CredentialAccess = {
    use: (fn) =>
      fn(JSON.stringify(c), async (raw) => {
        c = JSON.parse(raw);
        replacements++;
      }),
  };
  return { access, current: () => c, replacements: () => replacements };
}
test("Linear rejects writes, unknown arguments and unselected teams before networking", async () => {
  let connections = 0;
  const driver = new LinearReadonlyDriver({
    connect: async () => {
      connections++;
      throw new Error("must not connect");
    },
  });
  for (const [input, error] of [
    [{ operation: "create" }, "read_operation_required"],
    [{ operation: "issues", resourceId: another }, "resource_not_granted"],
    [{ operation: "issues", resourceId: team.id, page: 6 }, "invalid_page"],
    [
      { operation: "issues", resourceId: team.id, url: "https://evil.example" },
      "read_operation_required",
    ],
  ] as const)
    await assert.rejects(
      driver.read(credentials().access, user, [team], input, signal()),
      new RegExp(error),
    );
  assert.equal(connections, 0);
  assert.deepEqual(
    (
      (await driver.read(credentials().access, user, [team], { operation: "list" }, signal())) as {
        resources: unknown[];
      }
    ).resources,
    [team],
  );
});
test("Linear pins the read endpoint/tools, checks identity and team, bounds and labels untrusted results", async () => {
  let changedUser = false,
    changedTeam = false,
    reads = 0;
  const c = credentials();
  const driver = new LinearReadonlyDriver({
    connect: async (endpoint, token, _fetch, _signal, reviewed, work) => {
      assert.equal(endpoint, LINEAR_ENDPOINT);
      assert.equal(token, c.current().accessToken);
      assert.deepEqual(reviewed, LINEAR_READ_TOOLS);
      return work({
        call: async (name, args) => {
          if (name === "get_user") {
            assert.equal(args.query, "me");
            return { ...user, id: changedUser ? another : user.id };
          }
          if (name === "get_team")
            return { ...team, key: "FIX", id: changedTeam ? another : team.id };
          assert.equal(name, "list_issues");
          assert.equal(args.team, "FIX");
          assert.equal(args.includeSubTeams, false);
          assert.ok((args.fields as string[]).includes("teamId"));
          assert.equal(args.assignee, "me");
          assert.equal(args.limit, 20);
          assert.equal(args.includeArchived, false);
          reads++;
          return {
            issues: [
              {
                ...issue,
                description: "x".repeat(1500) + "fixture-access",
                title: "fixture-access",
                url: "https://evil.example/read",
              },
            ],
            hasNextPage: true,
            cursor: "next",
          };
        },
      });
    },
  });
  const input = { operation: "issues", resourceId: team.id, assignedToMe: true };
  const result = (await driver.read(c.access, user, [team], input, signal())) as {
    untrusted: boolean;
    truncated: boolean;
    issues: Array<{ description: string; title: string; url: string }>;
  };
  assert.equal(result.untrusted, true);
  assert.equal(result.truncated, true);
  assert.equal(result.issues[0]!.description.length, 1200);
  assert.equal(result.issues[0]!.url, "");
  assert.ok(!JSON.stringify(result).includes("fixture-access"));
  changedUser = true;
  await assert.rejects(
    driver.read(c.access, user, [team], input, signal()),
    /connector_account_changed/,
  );
  changedUser = false;
  changedTeam = true;
  await assert.rejects(
    driver.read(c.access, user, [team], input, signal()),
    /resource_not_granted/,
  );
  assert.equal(reads, 1);
});
test("Linear follows bounded cursors internally and refuses mismatched issue teams", async () => {
  let mismatch = false;
  const cursors: unknown[] = [];
  const driver = new LinearReadonlyDriver({
    connect: async (_e, _t, _f, _s, _r, work) =>
      work({
        call: async (name, args) => {
          if (name === "get_user") return user;
          if (name === "get_team") return { ...team, key: "FIX" };
          if (name === "list_teams") return { teams: [team] };
          cursors.push(args.cursor);
          return {
            issues: [{ ...issue, teamId: mismatch ? another : team.id }],
            hasNextPage: !args.cursor,
            ...(!args.cursor ? { cursor: "next" } : {}),
          };
        },
      }),
  });
  assert.deepEqual(await driver.resources(credentials().access, 1, signal()), [team]);
  assert.deepEqual(await driver.resources(credentials().access, 2, signal()), []);
  await driver.read(
    credentials().access,
    user,
    [team],
    { operation: "issues", resourceId: team.id, page: 2 },
    signal(),
  );
  assert.deepEqual(cursors, [undefined, "next"]);
  mismatch = true;
  await assert.rejects(
    driver.read(
      credentials().access,
      user,
      [team],
      { operation: "issues", resourceId: team.id },
      signal(),
    ),
    /linear_resource_mismatch/,
  );
});
test("Linear persists the rotated token pair before connecting; cancelled reads never connect", async () => {
  const c = credentials(0);
  let calls = 0;
  const driver = new LinearReadonlyDriver({
    fetch: () => async (url, init) => {
      assert.equal(new URL(url).pathname, "/token");
      assert.equal(new URLSearchParams(String(init?.body)).get("refresh_token"), "fixture-refresh");
      return new Response(
        JSON.stringify({
          access_token: "rotated-access",
          refresh_token: "rotated-refresh",
          token_type: "bearer",
          scope: "read",
          expires_in: 3600,
        }),
      );
    },
    connect: async (_e, token, _f, _s, _r, work) => {
      calls++;
      assert.equal(c.replacements(), 1);
      assert.equal(token, c.current().accessToken);
      assert.equal(c.current().refreshToken, "rotated-refresh");
      return work({ call: async () => user });
    },
  });
  assert.deepEqual(await driver.account(c.access, signal()), user);
  assert.equal(calls, 1);
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(driver.account(c.access, abort.signal));
  assert.equal(calls, 1);
});
test("Linear intent is explicit, read-only, and does not treat generic project requests as consent", () => {
  for (const text of ["查看 Linear 工单", "summarize my Linear tasks", "Linear 阻塞事项"])
    assert.equal(isLinearReadRequest(text), true);
  for (const text of [
    "创建 Linear 工单",
    "update Linear issue",
    "查看项目进展",
    "assign Linear issue",
  ])
    assert.equal(isLinearReadRequest(text), false);
});

test("Linear retries one transient transport failure, but never retries authorization failures", async () => {
  let calls = 0,
    failures = 1,
    code = "mcp_unavailable";
  const driver = new LinearReadonlyDriver({
    connect: async (_e, _t, _f, _s, _r, work) => {
      calls++;
      if (calls <= failures) throw new ConnectorError(code);
      return work({ call: async () => user });
    },
  });
  assert.deepEqual(await driver.account(credentials().access, signal()), user);
  assert.equal(calls, 2);
  calls = 0;
  failures = 10;
  await assert.rejects(driver.account(credentials().access, signal()), /mcp_unavailable/);
  assert.equal(calls, 2);
  calls = 0;
  code = "linear_reauthorization_required";
  await assert.rejects(
    driver.account(credentials().access, signal()),
    /linear_reauthorization_required/,
  );
  assert.equal(calls, 1);
});

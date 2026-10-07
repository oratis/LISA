/**
 * Review finding 3: a sandboxed shell is `auto` under Warden, so it must not be
 * able to reach the approval API (the server's own port) or Warden's state
 * directory. Both are denied in every bounded profile.
 */
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { buildMacosSeatbeltPolicy } from "./macos.js";
import {
  _resetSandboxProtectionsForTest,
  protectFromSandbox,
  sandboxProtections,
} from "./protect.js";
import { wrapForSandbox } from "./sandbox.js";

const HOME = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "lisa-protect-")));
const previousHome = process.env.LISA_HOME;
process.env.LISA_HOME = HOME;
after(() => {
  if (previousHome === undefined) delete process.env.LISA_HOME;
  else process.env.LISA_HOME = previousHome;
  fs.rmSync(HOME, { recursive: true, force: true });
});

function run(
  command: string,
  args: string[],
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: 15_000 }, (err, stdout, stderr) => {
      const code = err ? ((err as NodeJS.ErrnoException & { code?: number }).code ?? 1) : 0;
      resolve({ code: typeof code === "number" ? code : 1, stdout, stderr });
    });
  });
}

describe("sandbox protections", () => {
  test("the warden directory and the LISA port are always on the list", () => {
    _resetSandboxProtectionsForTest();
    const base = sandboxProtections({});
    assert.ok(base.paths.includes(path.join(HOME, "warden")));
    assert.deepEqual(base.tcpPorts, [5757]);
    assert.deepEqual(sandboxProtections({ LISA_PORT: "6001" }).tcpPorts, [5757, 6001]);
    assert.deepEqual(sandboxProtections({ LISA_PORT: "not-a-port" }).tcpPorts, [5757]);

    protectFromSandbox({ port: 49152, path: "/some/tenant/warden" });
    protectFromSandbox({ port: 0 });
    protectFromSandbox({ port: 70000 });
    protectFromSandbox({ path: "relative/warden" });
    const after = sandboxProtections({});
    assert.deepEqual(after.tcpPorts, [5757, 49152]);
    assert.ok(after.paths.includes("/some/tenant/warden"));
    assert.equal(after.paths.includes("relative/warden"), false);
    _resetSandboxProtectionsForTest();
  });

  test("a symlinked home is denied under its resolved path too", () => {
    const real = path.join(HOME, "real-home");
    const link = path.join(HOME, "link-home");
    fs.mkdirSync(path.join(real, "warden"), { recursive: true });
    fs.symlinkSync(real, link);
    _resetSandboxProtectionsForTest();
    protectFromSandbox({ path: path.join(link, "warden") });
    const { paths } = sandboxProtections({});
    assert.ok(paths.includes(path.join(link, "warden")));
    assert.ok(paths.includes(path.join(real, "warden")));
    _resetSandboxProtectionsForTest();
  });

  test("every bounded seatbelt profile ends with the denials, after the allows", () => {
    for (const mode of ["workspace-write", "read-only"] as const) {
      for (const allowNetwork of [true, false]) {
        const policy = buildMacosSeatbeltPolicy({
          cwd: "/work/project",
          allowNetwork,
          mode,
          denyPaths: ["/Users/x/.lisa/warden"],
          denyTcpPorts: [5757, 49152],
        });
        const lines = policy.split("\n");
        const lastAllow = lines.findLastIndex((l) => l.startsWith("(allow"));
        const firstDeny = lines.findIndex((l) => l.startsWith("(deny file-read*"));
        assert.ok(firstDeny > lastAllow, `${mode}/${allowNetwork}: denials must come last`);
        assert.ok(
          policy.includes('(deny file-read* file-write* (subpath "/Users/x/.lisa/warden"))'),
        );
        for (const port of [5757, 49152]) {
          assert.ok(policy.includes(`(deny network-outbound (remote tcp "localhost:${port}"))`));
          assert.ok(policy.includes(`(deny network-outbound (remote tcp "*:${port}"))`));
        }
      }
    }
    // Nothing to deny ⇒ the profile is exactly what it was.
    const plain = buildMacosSeatbeltPolicy({ cwd: "/w", allowNetwork: true });
    assert.equal(plain.includes("(deny file-read*"), false);
    assert.equal(plain.includes("network-outbound"), false);
  });

  test(
    "live: a sandboxed shell cannot read or write warden state, or reach the server port",
    { skip: process.platform !== "darwin" ? "seatbelt is macOS-only" : false },
    async () => {
      _resetSandboxProtectionsForTest();
      const wardenDir = path.join(HOME, "warden");
      fs.mkdirSync(wardenDir, { recursive: true });
      fs.writeFileSync(path.join(wardenDir, "grants.json"), "GRANTS-SECRET");
      const workspace = path.join(HOME, "ws");
      fs.mkdirSync(workspace, { recursive: true });
      fs.writeFileSync(path.join(workspace, "ok.txt"), "WORKSPACE-OK");

      const lisa = http.createServer((_req, res) => res.end("APPROVAL-API"));
      const other = http.createServer((_req, res) => res.end("OTHER-SERVICE"));
      await new Promise<void>((r) => lisa.listen(0, "127.0.0.1", r));
      await new Promise<void>((r) => other.listen(0, "127.0.0.1", r));
      const lisaPort = (lisa.address() as AddressInfo).port;
      const otherPort = (other.address() as AddressInfo).port;
      protectFromSandbox({ port: lisaPort });

      const sh = async (script: string, allowNetwork = true) => {
        const wrapped = await wrapForSandbox(
          { mode: "workspace-write", allowNetwork, cwd: workspace },
          script,
        );
        try {
          return await run(wrapped.command, wrapped.args);
        } finally {
          await wrapped.cleanup?.();
        }
      };

      try {
        // Control: the workspace and an unrelated local service still work.
        assert.match((await sh(`cat ${workspace}/ok.txt`)).stdout, /WORKSPACE-OK/);
        assert.match(
          (await sh(`curl -s -m 5 http://127.0.0.1:${otherPort}/`)).stdout,
          /OTHER-SERVICE/,
        );

        const read = await sh(`cat ${wardenDir}/grants.json`);
        assert.equal(read.stdout.includes("GRANTS-SECRET"), false, "read denied");
        assert.notEqual(read.code, 0);
        assert.notEqual((await sh(`ls ${wardenDir}`)).code, 0, "listing denied");
        await sh(`echo '{"version":1,"grants":[]}' > ${wardenDir}/grants.json`);
        await sh(`echo x > ${wardenDir}/rules.json`);
        assert.equal(fs.readFileSync(path.join(wardenDir, "grants.json"), "utf8"), "GRANTS-SECRET");
        assert.equal(fs.existsSync(path.join(wardenDir, "rules.json")), false, "write denied");

        for (const allowNetwork of [true, false]) {
          for (const host of ["127.0.0.1", "localhost"]) {
            const api = await sh(
              `curl -s -m 5 http://${host}:${lisaPort}/api/approvals; echo rc=$?`,
              allowNetwork,
            );
            assert.equal(api.stdout.includes("APPROVAL-API"), false, `${host}/${allowNetwork}`);
            assert.match(api.stdout, /rc=[1-9]/, `${host}/${allowNetwork}: connection refused`);
          }
        }
      } finally {
        lisa.close();
        other.close();
        _resetSandboxProtectionsForTest();
      }
    },
  );
});

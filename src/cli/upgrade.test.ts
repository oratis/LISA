import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  AUTOSTART_LABEL,
  BREW_FORMULA,
  compareVersions,
  detectInstall,
  formatStep,
  kickstartCommand,
  manualInstructions,
  PACKAGE_NAME,
  runUpgrade,
  upgradeCommands,
  type InstallFacts,
  type Step,
} from "./upgrade.js";

/**
 * The default is a real Homebrew install on Apple silicon: `bin/lisa` is a
 * symlink into the Cellar, and the formula wraps the npm package — so the
 * resolved path contains both `/Cellar/` and `/node_modules/@oratis/lisa/`,
 * which is exactly why detection checks Cellar first.
 */
const facts = (over: Partial<InstallFacts> = {}): InstallFacts => ({
  entry: "/opt/homebrew/bin/lisa",
  realEntry: `/opt/homebrew/Cellar/lisa/0.24.0/libexec/lib/node_modules/${PACKAGE_NAME}/dist/cli.js`,
  brewPrefix: "/opt/homebrew",
  npmPrefix: "/opt/homebrew",
  repoRoot: null,
  platform: "darwin",
  ...over,
});

describe("detectInstall", () => {
  test("a Cellar path is Homebrew, wherever the prefix is", () => {
    const d = detectInstall(
      facts({ realEntry: "/opt/homebrew/Cellar/lisa/0.24.0/libexec/dist/cli.js", brewPrefix: null }),
    );
    assert.equal(d.flavor, "homebrew");
  });

  test("Intel Macs and Linuxbrew prefixes work too", () => {
    assert.equal(
      detectInstall(
        facts({
          realEntry: "/usr/local/Cellar/lisa/0.24.0/libexec/dist/cli.js",
          brewPrefix: "/usr/local",
        }),
      ).flavor,
      "homebrew",
    );
    assert.equal(
      detectInstall(facts({ realEntry: "/opt/homebrew/opt/lisa/bin/lisa" })).flavor,
      "homebrew",
    );
  });

  test("a package path is an npm global install", () => {
    const d = detectInstall(
      facts({
        realEntry: `/usr/local/lib/node_modules/${PACKAGE_NAME}/dist/cli.js`,
        brewPrefix: null,
        npmPrefix: "/usr/local",
      }),
    );
    assert.equal(d.flavor, "npm-global");
    assert.match(d.reason, /\/usr\/local\/lib/);
  });

  test("the npm global prefix alone is enough when the shim isn't a package path", () => {
    assert.equal(
      detectInstall(
        facts({ realEntry: "/Users/x/.nvm/versions/node/v22.0.0/bin/lisa", brewPrefix: null, npmPrefix: "/Users/x/.nvm/versions/node/v22.0.0" }),
      ).flavor,
      "npm-global",
    );
  });

  test("a checkout wins over nothing, and a Cellar path still wins over a checkout", () => {
    assert.equal(
      detectInstall(
        facts({ realEntry: "/Users/x/Projects/LISA/dist/cli.js", brewPrefix: null, npmPrefix: null, repoRoot: "/Users/x/Projects/LISA" }),
      ).flavor,
      "source",
    );
    // `brew install` of a checkout-shaped path: Cellar is conclusive.
    assert.equal(
      detectInstall(
        facts({ realEntry: "/opt/homebrew/Cellar/lisa/0.24.0/libexec/dist/cli.js", repoRoot: "/opt/homebrew/Cellar/lisa/0.24.0" }),
      ).flavor,
      "homebrew",
    );
  });

  test("no evidence at all is 'unknown', not a guess", () => {
    assert.equal(
      detectInstall(facts({ realEntry: "/somewhere/odd/lisa", brewPrefix: null, npmPrefix: null })).flavor,
      "unknown",
    );
  });
});

describe("upgradeCommands", () => {
  test("Homebrew updates the tap before upgrading the formula", () => {
    assert.deepEqual(upgradeCommands("homebrew").map(formatStep), [
      "brew update",
      `brew upgrade ${BREW_FORMULA}`,
    ]);
  });

  test("npm global pins @latest", () => {
    assert.deepEqual(upgradeCommands("npm-global").map(formatStep), [
      `npm install -g ${PACKAGE_NAME}@latest`,
    ]);
  });

  test("a checkout and an unknown install run nothing automatically", () => {
    assert.deepEqual(upgradeCommands("source"), []);
    assert.deepEqual(upgradeCommands("unknown"), []);
    assert.match(manualInstructions("source", "/Users/x/LISA").join("\n"), /git pull/);
    assert.match(manualInstructions("unknown").join("\n"), /npm install -g/);
  });
});

describe("kickstartCommand", () => {
  test("targets the user's GUI domain and forces a restart", () => {
    assert.equal(formatStep(kickstartCommand(501)), `launchctl kickstart -k gui/501/${AUTOSTART_LABEL}`);
  });

  test("the label still matches src/autostart/install.ts", async () => {
    // A copied constant is only safe if something notices when it drifts.
    const here = path.dirname(fileURLToPath(import.meta.url));
    const src = await fs.readFile(path.resolve(here, "..", "autostart", "install.ts"), "utf8");
    const found = /const PLIST_LABEL = "([^"]+)"/.exec(src)?.[1];
    assert.equal(found, AUTOSTART_LABEL);
  });
});

describe("compareVersions", () => {
  test("orders releases numerically, not lexically", () => {
    assert.equal(compareVersions("0.24.0", "0.9.0"), 1);
    assert.equal(compareVersions("0.24.0", "0.24.0"), 0);
    assert.equal(compareVersions("1.0.0", "0.99.99"), 1);
    assert.equal(compareVersions("0.24.1", "0.24.10"), -1);
  });

  test("tolerates a v prefix and short versions", () => {
    assert.equal(compareVersions("v1.2", "1.2.0"), 0);
    assert.equal(compareVersions("2", "1.9.9"), 1);
  });

  test("a prerelease sorts below its release", () => {
    assert.equal(compareVersions("1.0.0-rc.1", "1.0.0"), -1);
    assert.equal(compareVersions("1.0.0", "1.0.0-rc.1"), 1);
  });
});

/** Collects the log and every command a run would have executed. */
function harness(opts: {
  facts?: Partial<InstallFacts>;
  local?: string;
  latest?: string | null;
  loaded?: boolean;
  fail?: string;
}) {
  const lines: string[] = [];
  const ran: string[] = [];
  const run = async (s: Step): Promise<string> => {
    const printed = formatStep(s);
    if (opts.fail && printed.startsWith(opts.fail)) throw new Error("boom: command failed");
    ran.push(printed);
    return s.args.includes("--version") ? (opts.latest ?? "0.25.0") : "";
  };
  return {
    lines,
    ran,
    call: (over: Parameters<typeof runUpgrade>[0] = {}) =>
      runUpgrade({
        facts: facts(opts.facts),
        localVersion: async () => opts.local ?? "0.24.0",
        fetchLatest: async () => (opts.latest === undefined ? "0.25.0" : opts.latest),
        autostartLoaded: async () => opts.loaded === true,
        uid: 501,
        run,
        log: (l) => lines.push(l),
        ...over,
      }),
    text: () => lines.join("\n"),
  };
}

describe("runUpgrade", () => {
  test("--check compares and changes nothing", async () => {
    const h = harness({ loaded: true });
    assert.equal(await h.call({ check: true }), 0);
    assert.deepEqual(h.ran, []);
    assert.match(h.text(), /0\.24\.0 → 0\.25\.0 available/);
    assert.match(h.text(), /run `lisa upgrade`/);
  });

  test("--check on the newest version says so and still exits 0", async () => {
    const h = harness({ local: "0.25.0", latest: "0.25.0" });
    assert.equal(await h.call({ check: true }), 0);
    assert.match(h.text(), /already on the newest published version/);
  });

  test("--check survives an unreachable registry", async () => {
    const h = harness({ latest: null });
    assert.equal(await h.call({ check: true }), 0);
    assert.match(h.text(), /registry unreachable/);
  });

  test("--dry-run prints the commands, including the daemon restart", async () => {
    const h = harness({ loaded: true });
    assert.equal(await h.call({ dryRun: true }), 0);
    assert.deepEqual(h.ran, []);
    assert.match(h.text(), /brew update/);
    assert.match(h.text(), new RegExp(`brew upgrade ${BREW_FORMULA.replace(/\//g, "\\/")}`));
    assert.match(h.text(), /launchctl kickstart -k gui\/501\/ai\.lisa\.autostart/);
  });

  test("--dry-run says why there is no restart when the agent isn't loaded", async () => {
    const h = harness({ loaded: false });
    await h.call({ dryRun: true });
    assert.doesNotMatch(h.text(), /kickstart/);
    assert.match(h.text(), /no loaded LaunchAgent/);
  });

  test("a real run upgrades then kickstarts the loaded LaunchAgent", async () => {
    const h = harness({ loaded: true });
    assert.equal(await h.call(), 0);
    assert.deepEqual(h.ran, [
      "brew update",
      `brew upgrade ${BREW_FORMULA}`,
      "lisa --version",
      `launchctl kickstart -k gui/501/${AUTOSTART_LABEL}`,
    ]);
    assert.match(h.text(), /0\.24\.0 → 0\.25\.0/);
    assert.match(h.text(), /restarted the login agent/);
  });

  test("no LaunchAgent, no kickstart", async () => {
    const h = harness({ loaded: false });
    await h.call();
    assert.ok(!h.ran.some((c) => c.startsWith("launchctl")));
  });

  test("a non-macOS host never touches launchctl", async () => {
    const h = harness({ facts: { platform: "linux" }, loaded: true });
    await h.call();
    assert.ok(!h.ran.some((c) => c.startsWith("launchctl")));
  });

  test("an npm-global install runs the npm command", async () => {
    const h = harness({
      facts: { realEntry: `/usr/local/lib/node_modules/${PACKAGE_NAME}/dist/cli.js`, brewPrefix: null },
    });
    await h.call();
    assert.equal(h.ran[0], `npm install -g ${PACKAGE_NAME}@latest`);
  });

  test("a failing command exits 1 and says which one", async () => {
    const h = harness({ loaded: true, fail: "brew upgrade" });
    assert.equal(await h.call(), 1);
    assert.match(h.text(), /`brew upgrade .*` failed — Lisa is still on 0\.24\.0/);
    assert.ok(!h.ran.some((c) => c.startsWith("launchctl")), "no restart after a failed upgrade");
  });

  test("a source checkout prints instructions and runs nothing", async () => {
    const h = harness({
      facts: {
        realEntry: "/Users/x/Projects/LISA/dist/cli.js",
        brewPrefix: null,
        npmPrefix: null,
        repoRoot: "/Users/x/Projects/LISA",
      },
      loaded: true,
    });
    assert.equal(await h.call(), 0);
    assert.deepEqual(h.ran, []);
    assert.match(h.text(), /source checkout/);
    assert.match(h.text(), /git pull && npm install && npm run build/);
  });

  test("a kickstart failure is a warning, not a failed upgrade", async () => {
    const h = harness({ loaded: true, fail: "launchctl" });
    assert.equal(await h.call(), 0);
    assert.match(h.text(), /couldn't restart the daemon/);
    assert.match(h.text(), /run it yourself: launchctl kickstart/);
  });
});

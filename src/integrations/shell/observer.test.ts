import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { extractArgv0, parseHistoryArgv0s, shellActivity } from "./observer.js";

describe("extractArgv0 (program name only)", () => {
  test("plain command", () => assert.equal(extractArgv0("git status"), "git"));
  test("strips leading env assignments", () =>
    assert.equal(extractArgv0('NODE_ENV=prod FOO="a b" npm run build'), "npm"));
  test("basenames a path", () => assert.equal(extractArgv0("/usr/local/bin/node script.js"), "node"));
  test("strips a leading subshell paren", () => assert.equal(extractArgv0("(cd x && make)"), "cd"));
  test("rejects flags / empty / comments", () => {
    assert.equal(extractArgv0("--help"), null);
    assert.equal(extractArgv0("   "), null);
    assert.equal(extractArgv0("# a comment"), null);
  });
});

describe("parseHistoryArgv0s", () => {
  test("plain (bash) lines", () => {
    assert.deepEqual(parseHistoryArgv0s("git status\nnpm test\n"), ["git", "npm"]);
  });
  test("zsh EXTENDED_HISTORY prefix", () => {
    assert.deepEqual(parseHistoryArgv0s(": 1718337600:0;git push\n: 1718337601:2;docker ps"), ["git", "docker"]);
  });
  test("skips bash HISTTIMEFORMAT timestamp lines", () => {
    assert.deepEqual(parseHistoryArgv0s("#1718337600\ngit log\n#1718337601\nls -la"), ["git", "ls"]);
  });
});

describe("PRIVACY: only argv[0] is ever surfaced", () => {
  test("secrets in command arguments never appear — only the program name", () => {
    const hist = [
      ': 1718337600:0;git commit -m "fix: AKIA-SUPER-SECRET leaked into logs"',
      'curl -H "Authorization: Bearer sk-tok-PRIVATE" https://api.secret-host.example',
      "export DB_PASSWORD=hunter2",
    ].join("\n");
    const blob = JSON.stringify(shellActivity(parseHistoryArgv0s(hist)));
    // program names are fine to surface…
    assert.match(blob, /git/);
    assert.match(blob, /curl/);
    // …but nothing from the arguments may leak.
    assert.doesNotMatch(blob, /SECRET|PRIVATE|hunter2|Bearer|AKIA|sk-tok|secret-host/);
  });
});

describe("shellActivity", () => {
  test("turnCount, lastCommandName, deduped recent lastTools, no files", () => {
    const a = shellActivity(["git", "npm", "git", "docker"]);
    assert.equal(a.turnCount, 4);
    assert.equal(a.lastCommandName, "docker");
    assert.deepEqual(a.lastTools, ["npm", "git", "docker"]);
    assert.deepEqual(a.filesTouched, []);
  });
});

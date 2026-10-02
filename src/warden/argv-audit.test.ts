/**
 * Warden classifies some tools as `read` or `self`, which makes them `auto`.
 * That is only true if a model-controlled string can never become an OPTION of
 * the subprocess the tool runs. This file is the audit: one test per tool that
 * spawns a process, named for why it is safe (or what was fixed).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { gitDiffArgs, reviewDiffTool } from "../tools/review_diff.js";
import { isNpmPackageSpec, npmInfoTool } from "../tools/npm_info.js";
import { buildGhArgs } from "../tools/github.js";
import { sayArgs } from "../voice/speak.js";
import { ytDlpArgs } from "../kb/ingest/adapters/ytdlp.js";
import type { ToolContext } from "../types.js";

const ctx = (cwd: string): ToolContext => ({
  cwd,
  signal: new AbortController().signal,
  log: () => {},
});

async function source(rel: string): Promise<string> {
  return await fs.readFile(new URL(rel, import.meta.url), "utf8");
}

test("review_diff: a target can no longer be a git option (was: --output=<path> overwrote any file)", async () => {
  for (const bad of ["--output=/tmp/x", "-O/tmp/x", "--no-index", "-", "--ext-diff", "a\nb"]) {
    const args = gitDiffArgs(bad);
    assert.equal(Array.isArray(args), false, bad);
  }
  assert.deepEqual(gitDiffArgs("main...HEAD"), ["diff", "--end-of-options", "main...HEAD"]);
  assert.deepEqual(gitDiffArgs("HEAD~3", ["--stat"]), [
    "diff",
    "--stat",
    "--end-of-options",
    "HEAD~3",
  ]);
  assert.deepEqual(gitDiffArgs("head", ["--stat"]), ["diff", "--stat", "HEAD"]);
  assert.deepEqual(gitDiffArgs("staged"), ["diff", "--cached"]);

  // The reviewer's reproduction, end to end against real git.
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lisa-argv-"));
  const repo = path.join(dir, "repo");
  await fs.mkdir(repo);
  const git = (...a: string[]) => execFileSync("git", ["-C", repo, ...a], { stdio: "pipe" });
  git("init", "-q");
  await fs.writeFile(path.join(repo, "a.txt"), "one\n");
  git("add", "a.txt");
  git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init");
  await fs.writeFile(path.join(repo, "a.txt"), "one\ntwo\n");
  const victim = path.join(dir, "victim.txt");
  await fs.writeFile(victim, "ORIGINAL\n");
  const out = await reviewDiffTool.execute({ cwd: repo, target: `--output=${victim}` }, ctx(repo));
  assert.match(out, /not a git ref or range/);
  assert.equal(await fs.readFile(victim, "utf8"), "ORIGINAL\n", "the file was not overwritten");
  // A legitimate target still works, including the --stat header.
  const ok = await reviewDiffTool.execute({ cwd: repo, target: "HEAD" }, ctx(repo));
  assert.match(ok, /a\.txt/);
  assert.match(ok, /\+two/);
  await fs.rm(dir, { recursive: true, force: true });
});

test("npm_info view: the package is validated and passed after `--` (was: --registry=… as a package)", async () => {
  for (const bad of [
    "--registry=https://evil.example/",
    "-g",
    "--userconfig=/etc/passwd",
    "",
    "a b; rm",
  ]) {
    assert.equal(isNpmPackageSpec(bad), false, bad);
    const out = await npmInfoTool.execute({ action: "view", package: bad }, ctx(os.tmpdir()));
    assert.match(out, /package name/, bad);
  }
  for (const good of ["left-pad", "@scope/pkg", "react@^18.2.0", "typescript@5.6.x"]) {
    assert.equal(isNpmPackageSpec(good), true, good);
  }
  assert.match(await source("../tools/npm_info.ts"), /\["view", "--json", "--", input\.package\]/);
});

test("npm_info outdated/audit: argv is fixed, only the working directory is chosen", async () => {
  const src = await source("../tools/npm_info.ts");
  assert.match(src, /\["outdated", "--json"\]/);
  assert.match(src, /\["audit", "--json"\]/);
});

test("speak: the text goes after `--` (was: -o<path> made say write a file)", () => {
  assert.deepEqual(sayArgs({ text: "-o/Users/x/.zshrc" }), ["--", "-o/Users/x/.zshrc"]);
  assert.deepEqual(sayArgs({ text: "hi", voice: "Samantha", rate: 180 }), [
    "-v",
    "Samantha",
    "-r",
    "180",
    "--",
    "hi",
  ]);
});

test("kb_ingest → yt-dlp: the URL goes after `--` (so it can never be --exec)", () => {
  const args = ytDlpArgs("--exec=touch /tmp/pwned");
  assert.equal(args.at(-2), "--");
  assert.equal(args.at(-1), "--exec=touch /tmp/pwned");
});

test("github read actions: a number is a positive integer, so it cannot be a gh flag", () => {
  for (const action of ["issue_view", "pr_view", "run_view"] as const) {
    for (const bad of [-1, 0, 1.5, "--web", "-R evil/repo", Number.NaN]) {
      const built = buildGhArgs({ action, number: bad as unknown as number });
      assert.ok("error" in built, `${action} ${String(bad)}`);
    }
    const ok = buildGhArgs({ action, number: 12 });
    assert.ok("args" in ok && ok.args.includes("12"));
  }
  // issue_list's only free value is consumed as the VALUE of --state.
  const list = buildGhArgs({ action: "issue_list", state: "--web" as unknown as "open" });
  assert.ok("args" in list);
  assert.equal(list.args[list.args.indexOf("--state") + 1], "--web");
});

test("grep: the pattern follows -e, the glob is glued to --include=, the path is absolute", async () => {
  const src = await source("../tools/grep.ts");
  assert.match(src, /args\.push\("-e", input\.pattern, target\)/);
  assert.match(src, /`--include=\$\{input\.glob\}`/);
  assert.match(src, /fs\.resolvePath\(ctx\.cwd, input\.path \?\? "\."\)/);
  assert.match(src, /shell\.exec\("grep", args/, "argv exec, not a shell string");
});

test("repo_digest: `since` is glued to --since=, so it is always that option's value", async () => {
  assert.match(await source("../tools/repo_digest.ts"), /`--since=\$\{since\}`/);
});

test("soul_history / soul_diff: since is glued to --since=, the path follows `--`", async () => {
  const src = await source("../soul/git.ts");
  assert.equal(src.match(/args\.push\(`--since=\$\{opts\.since\}`\)/g)?.length, 2);
  assert.equal(src.match(/args\.push\("--", opts\.pathRel\)/g)?.length, 2);
});

test("pr_status: argv is fixed; the model only picks the repo directory", async () => {
  const src = await source("../tools/pr_status.ts");
  assert.match(src, /if \(input\.mine\) args\.push\("--author", "@me"\)/);
  assert.equal(/args\.push\([^)]*input\.(?!mine)/.test(src), false);
});

test("github_link: git argv is fixed; the opener receives one https URL built from the remote", async () => {
  const src = await source("../tools/github_link.ts");
  assert.match(src, /\["-C", root, "remote", "get-url", "origin"\]/);
  assert.match(src, /\["-C", root, "rev-parse", "--abbrev-ref", "HEAD"\]/);
  assert.match(src, /\["-C", root, "rev-parse", "HEAD"\]/);
});

test("dispatch_status, inspect_agent, list_agents, agent_recap, advise_now spawn nothing", async () => {
  for (const file of [
    "dispatch_status",
    "inspect_agent",
    "list_agents",
    "agent_recap",
    "advise_now",
  ]) {
    const src = await source(`../tools/${file}.ts`);
    assert.equal(/\brunIn\(|\bspawn\(|\bexecFile\(|shell\.(run|exec)\(/.test(src), false, file);
  }
});

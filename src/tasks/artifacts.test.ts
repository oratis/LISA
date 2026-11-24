import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, describe, test } from "node:test";
import { homeScope } from "../paths.js";
import { handleTasksApi } from "../web/tasks-api.js";
import { MAX_ARTIFACT_BYTES, publicArtifactsForRun, resolveTaskArtifact } from "./artifacts.js";
import { checkpointRun, createRun, createTask, updateTask } from "./store.js";
import type { TaskRun } from "./types.js";
import { ensureTaskWorkspace } from "./workspace.js";

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "lisa-artifacts-")));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

describe("task artifact containment and HTTP delivery", () => {
  test("serves workspace-contained file/text/link artifacts with safe headers and blocks traversal, symlinks, unsafe links, and oversized files", async () => {
    const homeA = path.join(TMP, "home-a");
    const homeB = path.join(TMP, "home-b");
    const outsideFile = path.join(TMP, "secret-outside.txt");
    fs.mkdirSync(homeA, { recursive: true });
    fs.mkdirSync(homeB, { recursive: true });
    fs.writeFileSync(outsideFile, "TOP_SECRET_OUTSIDE");

    let taskId = "";
    let runId = "";

    await homeScope.run(homeA, async () => {
      const task = await createTask({
        kind: "goal",
        title: "Quarterly report",
        instruction: "Produce brief.",
        origin: { kind: "api" },
        owner: null,
        goalMilestones: [
          { id: "m1", title: "Collect metrics", done: true, evidence: "report.md written" },
        ],
      });
      taskId = task.id;
      const ws = await ensureTaskWorkspace(task.id);
      const reportPath = path.join(ws, "report.md");
      const htmlPath = path.join(ws, "page.html");
      const escapeLink = path.join(ws, "escape.txt");
      const bigPath = path.join(ws, "huge.txt");
      fs.writeFileSync(reportPath, "# Q4 Summary\nAll green.");
      fs.writeFileSync(htmlPath, "<script>alert(1)</script>");
      fs.symlinkSync(outsideFile, escapeLink);
      fs.writeFileSync(bigPath, Buffer.alloc(MAX_ARTIFACT_BYTES + 16, 65));

      const run = await createRun(task.id, { trigger: "manual" });
      runId = run.id;
      run.state = "succeeded";
      run.summary = "Generated report.";
      run.artifacts = [
        { id: "report", kind: "file", title: "Q4 Report", value: reportPath },
        { id: "html", kind: "file", title: "Unsafe HTML", value: "page.html" },
        { id: "escape", kind: "file", title: "Escaping Symlink", value: escapeLink },
        { id: "traversal", kind: "file", title: "Traversal", value: "../../secret-outside.txt" },
        { id: "big", kind: "file", title: "Oversized", value: bigPath },
        { id: "note", kind: "text", title: "Note", value: "Plain text summary" },
        { id: "goodlink", kind: "link", title: "Docs", value: "https://example.com/report" },
        { id: "badlink", kind: "link", title: "XSS", value: "javascript:alert(1)" },
      ];
      await checkpointRun(run);
      await updateTask(task.id, (t) => {
        t.runs.push(run.id);
      });

      // Public projection omits raw host paths for file artifacts.
      const pub = publicArtifactsForRun(run);
      const pubReport = pub.find((a) => a.id === "report");
      assert.ok(pubReport);
      assert.equal(pubReport.filename, "report.md");
      assert.equal(pubReport.value, undefined);

      // Direct containment unit checks.
      const escRes = await resolveTaskArtifact(run, "escape");
      assert.equal(escRes.ok, false);
      if (!escRes.ok) assert.equal(escRes.status, 403);

      const travRes = await resolveTaskArtifact(run, "traversal");
      assert.equal(travRes.ok, false);
      if (!travRes.ok) assert.equal(travRes.status, 403);

      const bigRes = await resolveTaskArtifact(run, "big");
      assert.equal(bigRes.ok, false);
      if (!bigRes.ok) assert.equal(bigRes.status, 413);

      const badLinkRes = await resolveTaskArtifact(run, "badlink");
      assert.equal(badLinkRes.ok, false);
      if (!badLinkRes.ok) assert.equal(badLinkRes.status, 403);
    });

    // HTTP route check with tenant scoping.
    let activeHome = homeA;
    const server = http.createServer((req, res) => {
      void homeScope.run(activeHome, () =>
        handleTasksApi(req, res, req.url ?? "/", {
          cloud: false,
          profile: "local-owner",
          uid: null,
          runner: null,
        }),
      );
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const addr = server.address() as { port: number };
      const base = `http://127.0.0.1:${addr.port}/api/tasks/${taskId}/runs/${runId}/artifacts`;

      // Valid markdown file preview carries nosniff + sandbox CSP.
      const mdRes = await fetch(`${base}/report`);
      assert.equal(mdRes.status, 200);
      assert.equal(mdRes.headers.get("x-content-type-options"), "nosniff");
      assert.equal(mdRes.headers.get("content-security-policy"), "default-src 'none'; sandbox");
      assert.match(mdRes.headers.get("content-disposition") ?? "", /^inline;/);
      assert.equal(await mdRes.text(), "# Q4 Summary\nAll green.");

      // HTML artifact is forced to attachment + sandbox CSP.
      const htmlRes = await fetch(`${base}/html`);
      assert.equal(htmlRes.status, 200);
      assert.match(htmlRes.headers.get("content-disposition") ?? "", /^attachment;/);
      assert.equal(htmlRes.headers.get("content-security-policy"), "default-src 'none'; sandbox");

      // Symlink escape returns 403 without leaking host paths.
      const escHttp = await fetch(`${base}/escape`);
      assert.equal(escHttp.status, 403);
      const escText = await escHttp.text();
      assert.ok(!escText.includes(TMP));

      // Safe link returns JSON with validated URL.
      const linkHttp = await fetch(`${base}/goodlink`);
      assert.equal(linkHttp.status, 200);
      const linkJson = (await linkHttp.json()) as { url: string };
      assert.equal(linkJson.url, "https://example.com/report");

      // Separate tenant home gets 404 (cannot access homeA's task artifacts).
      activeHome = homeB;
      const otherTenant = await fetch(`${base}/report`);
      assert.equal(otherTenant.status, 404);
    } finally {
      server.close();
    }
  });

  test("supports legacy index-based artifact IDs when artifact.id is omitted", async () => {
    const run: TaskRun = {
      id: "run_legacy",
      taskId: "tsk_legacy",
      startedAt: Date.now(),
      state: "succeeded",
      tokens: { in: 0, out: 0 },
      toolCalls: 0,
      executedDigests: {},
      artifacts: [{ kind: "text", title: "Legacy Note", value: "hello legacy" }],
    };
    const res = await resolveTaskArtifact(run, "0");
    assert.equal(res.ok, true);
    if (res.ok && res.kind === "text") {
      assert.equal(res.body.toString("utf8"), "hello legacy");
    }
  });
});

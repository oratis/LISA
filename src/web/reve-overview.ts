import fs from "node:fs/promises";
import path from "node:path";
import { reflectionsDir } from "../paths.js";
import { autonomyDir, readAutonomyRuns } from "../autonomy/runs.js";
import { normalizeAutonomyState, defaultAutonomyState } from "../autonomy/state.js";
import { readMemory, MEMORY_MAX_BYTES } from "../memory/store.js";
import { recentMemoryRevisions } from "../memory/review.js";
import { kbGraphFile } from "../kb/paths.js";
import type { KbGraphJson } from "../kb/links.js";
import { listDesires, effectiveDesireIntensity } from "../soul/store.js";
import { assertHomeDirectory, readHomeTextOrEmpty } from "../home-files.js";

async function readAutonomySetting() {
  const raw = await readHomeTextOrEmpty(path.join(autonomyDir(), "state.json"), 16_384);
  return raw ? normalizeAutonomyState(JSON.parse(raw)).enabled : defaultAutonomyState().enabled;
}

async function recentReflections(since: number) {
  let files: string[];
  try {
    await assertHomeDirectory(reflectionsDir());
    files = await fs.readdir(reflectionsDir());
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
  const candidates: { file: string; at: number }[] = [];
  for (const file of files.filter((f) => /^[a-zA-Z0-9_-]+\.json$/.test(f))) {
    const st = await fs.lstat(path.join(reflectionsDir(), file));
    if (st.isFile() && st.mtimeMs >= since && st.size < 128_000)
      candidates.push({ file, at: st.mtimeMs });
  }
  const out = [];
  for (const { file, at } of candidates.sort((a, b) => b.at - a.at).slice(0, 12)) {
    const raw = await readHomeTextOrEmpty(path.join(reflectionsDir(), file), 128_000);
    if (!raw) continue;
    const r = JSON.parse(raw);
    if (typeof r.summary !== "string") continue;
    out.push({
      sessionId: file.slice(0, -5),
      at: new Date(at).toISOString(),
      summary: r.summary.slice(0, 2000),
      appliedCount: Array.isArray(r.applied) ? r.applied.length : 0,
      skipped: Array.isArray(r.skipped)
        ? r.skipped
            .filter((s: unknown) => typeof s === "string")
            .map((s: string) => s.slice(0, 240))
            .slice(0, 8)
        : [],
    });
  }
  return out;
}

async function knowledgeHealth() {
  const raw = await readHomeTextOrEmpty(kbGraphFile(), 8 * 1024 * 1024);
  const graph: KbGraphJson = raw
    ? JSON.parse(raw)
    : { nodes: [], edges: [], broken: [], orphans: [], hubs: [], generatedAt: "" };
  if (!Array.isArray(graph.nodes) || !Array.isArray(graph.broken) || !Array.isArray(graph.orphans))
    throw new Error("corrupt KB graph");
  return {
    sources: graph.nodes.filter((n) => n.layer === "sources").length,
    pages: graph.nodes.filter((n) => n.layer === "wiki").length,
    brokenCount: graph.broken.length,
    orphanCount: graph.orphans.length,
    broken: graph.broken
      .slice(0, 5)
      .map((b) => ({ from: String(b.from).slice(0, 160), target: String(b.target).slice(0, 160) })),
    orphans: graph.orphans
      .slice(0, 5)
      .map((ref) => ({ ref, title: graph.nodes.find((n) => n.key === ref)?.title ?? ref })),
  };
}

export async function buildReveOverview(days = 7) {
  days = Number.isFinite(days) ? Math.max(1, Math.min(30, Math.floor(days))) : 7;
  const since = Date.now() - days * 86_400_000;
  const partial: string[] = [];
  async function section<T>(name: string, fallback: T, run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch {
      partial.push(name);
      return fallback;
    }
  }
  const [runs, user, memory, versions, reflections, knowledge, desires, enabled] =
    await Promise.all([
      section("activity", [], () => readAutonomyRuns(days * 86_400_000)),
      section("userMemory", null, () => readMemory("user")),
      section("workingMemory", null, () => readMemory("memory")),
      section("memoryChanges", [], () => recentMemoryRevisions(100)),
      section("reflections", [], () => recentReflections(since)),
      section("knowledge", null, knowledgeHealth),
      section("desires", [], listDesires),
      section("autonomy", false, readAutonomySetting),
    ]);
  const revisions = versions.filter(
    (r) => Date.parse(r.createdAt) >= since && r.before !== r.after,
  );
  const count = (n: number | undefined) => (Number.isFinite(n) && n! >= 0 ? n! : 0);
  const usage = runs.reduce(
    (sum, r) => ({
      inputTokens: sum.inputTokens + count(r.inputTokens),
      outputTokens: sum.outputTokens + count(r.outputTokens),
      cacheReadTokens: sum.cacheReadTokens + count(r.cacheReadTokens),
      cacheWriteTokens: sum.cacheWriteTokens + count(r.cacheWriteTokens),
      incompleteCacheRuns: sum.incompleteCacheRuns + (r.cacheReadTokens === undefined ? 1 : 0),
    }),
    {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      incompleteCacheRuns: 0,
    },
  );
  return {
    generatedAt: new Date().toISOString(),
    days,
    limits: { runs: 2000, revisionsPerStore: 100, displayedRecords: 20 },
    enabled,
    partial: [...new Set(partial)],
    stats: {
      runs: runs.length,
      completed: runs.filter((r) => r.outcome === "done").length,
      issues: runs.filter((r) => r.outcome === "error" || r.outcome === "blocked").length,
      changes: revisions.filter((r) => r.status === "applied" && !r.restores).length,
      corrections: revisions
        .filter((r) => r.status === "applied" && !r.restores)
        .reduce(
          (n, r) => n + r.changes.filter((c) => c.kind === "replace" || c.kind === "remove").length,
          0,
        ),
      usage,
    },
    memory: {
      user: {
        bytes: user === null ? null : Buffer.byteLength(user, "utf8"),
        limit: MEMORY_MAX_BYTES.user,
      },
      memory: {
        bytes: memory === null ? null : Buffer.byteLength(memory, "utf8"),
        limit: MEMORY_MAX_BYTES.memory,
      },
    },
    revisions: revisions.slice(0, 20).map((r) => ({
      id: r.id,
      store: r.store,
      at: r.createdAt,
      status: r.status,
      restores: r.restores,
      changeCount: r.changes.length,
      sources: r.sources.length,
      reason: (r.changes[0]?.reason ?? "").slice(0, 300),
      canRestore: r.status === "applied" && (r.store === "user" ? user : memory) === r.after,
    })),
    reflections,
    knowledge,
    desires: desires
      .filter((d) => !d.closed)
      .sort((a, b) => effectiveDesireIntensity(b) - effectiveDesireIntensity(a))
      .slice(0, 4)
      .map((d) => ({
        slug: d.slug,
        what: d.what.slice(0, 240),
        why: d.why.slice(0, 400),
        actionable: d.actionable,
        needsUser: d.pursuit === "needs-user",
      })),
    runs: runs
      .slice(-20)
      .reverse()
      .map((r) => ({
        kind: r.kind,
        at: r.startedAt,
        outcome: r.outcome,
        inputTokens: count(r.inputTokens),
        outputTokens: count(r.outputTokens),
        durationMs: count(r.durationMs),
        note: r.note?.slice(0, 200),
      })),
  };
}

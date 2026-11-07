import fs from "node:fs/promises";
import path from "node:path";
import { homeScope, reflectionsDir } from "../../../src/paths.js";
import { writeMemory } from "../../../src/memory/store.js";
import { createMemoryReview, applyMemoryReview } from "../../../src/memory/review.js";
import { evidenceFromHistory } from "../../../src/memory/evidence.js";
import { recordAutonomyRun } from "../../../src/autonomy/runs.js";
import { SessionStore } from "../../../src/sessions/store.js";
import { kbGraphFile } from "../../../src/kb/paths.js";

/** Synthetic preview data, persisted through the real memory revision path. */
export async function seedReve(home: string) {
  return homeScope.run(home, async () => {
    await writeMemory("memory", "- Atlas API port: 3000\n- Backups run on Sundays.");
    await writeMemory("user", "- Prefers concise explanations in Chinese.");
    const session = await SessionStore.create({ cwd: home, model: "fixture" });
    const evidence = evidenceFromHistory(
      [
        {
          role: "user",
          content: "Atlas has moved permanently to port 5757. Keep the Sunday backup schedule.",
        },
      ],
      session.id,
    );
    await session.appendMessage({ role: "user", content: evidence[0]!.text });
    const revision = await applyMemoryReview(await createMemoryReview("memory", evidence), [
      {
        kind: "replace",
        old_text: "Atlas API port: 3000",
        new_text: "Atlas API port: 5757",
        reason: "Atlas 的端口已更新，保留原有备份安排。",
        evidence: [{ id: evidence[0]!.id, quote: evidence[0]!.text }],
      },
    ]);
    await recordAutonomyRun({
      kind: "reflect",
      startedAt: new Date().toISOString(),
      durationMs: 4200,
      inputTokens: 3,
      outputTokens: 198,
      cacheReadTokens: 1853,
      cacheWriteTokens: 0,
      outcome: "done",
      note: "Corrected an outdated port from the user's source message.",
    });
    await recordAutonomyRun({
      kind: "idle",
      startedAt: new Date().toISOString(),
      durationMs: 1200,
      inputTokens: 420,
      outputTokens: 85,
      outcome: "no-update",
      note: "Reviewed pending knowledge links; no memory changes needed.",
    });
    await fs.mkdir(reflectionsDir(), { recursive: true });
    await fs.writeFile(
      path.join(reflectionsDir(), `${session.id}.json`),
      JSON.stringify({
        summary:
          "Atlas 的端口已从 3000 改为 5757。保留周日备份安排，避免把项目配置变化扩展到无关记忆。",
        applied: ["memory:memory:consolidated"],
        skipped: [],
      }),
    );
    await fs.mkdir(path.dirname(kbGraphFile()), { recursive: true });
    await fs.writeFile(
      kbGraphFile(),
      JSON.stringify({
        nodes: [
          { key: "sources/atlas-notes", layer: "sources", title: "Atlas 项目记录" },
          { key: "wiki/deploy", layer: "wiki", title: "部署约定" },
        ],
        edges: [],
        broken: [{ from: "wiki/deploy", target: "deployment-checklist" }],
        orphans: ["wiki/deploy"],
        hubs: [],
      }),
    );
    return revision.revisionId;
  });
}

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { skillImportCatalog, importSkill } from "./catalog.js";
import { discoverSkills } from "./discovery.js";

test("project and personal skills are discoverable; external imports preserve resources and reject symlinks", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "lisa-skills-catalog-"));
  const previous = {
    LISA_HOME: process.env.LISA_HOME,
    CODEX_HOME: process.env.CODEX_HOME,
    CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
  };
  Object.assign(process.env, {
    LISA_HOME: path.join(root, "lisa"),
    CODEX_HOME: path.join(root, "codex"),
    CLAUDE_CONFIG_DIR: path.join(root, "claude"),
  });
  async function skill(dir: string, name: string) {
    await fs.mkdir(path.join(dir, name), { recursive: true });
    await fs.writeFile(
      path.join(dir, name, "SKILL.md"),
      `---\nname: ${name}\ndescription: Test workflow\n---\nUse scripts/task.sh\n`,
    );
  }
  try {
    const project = path.join(root, "project");
    await skill(path.join(project, ".agents/skills"), "project-only");
    assert.deepEqual(
      (await discoverSkills(project)).skills.map((s) => [s.frontmatter.name, s.scope]),
      [["project-only", "project"]],
    );
    assert.equal((await discoverSkills(null)).skills.length, 0);
    const external = path.join(root, "codex/skills");
    await skill(external, "import-me");
    await fs.mkdir(path.join(external, "import-me/scripts"));
    await fs.writeFile(
      path.join(external, "import-me/scripts/task.sh"),
      "#!/bin/sh\necho fixture\n",
      { mode: 0o700 },
    );
    assert.equal((await skillImportCatalog())[0]?.source, "codex");
    await importSkill("codex", "import-me");
    assert.equal((await discoverSkills(project)).skills.length, 2);
    assert.match(
      await fs.readFile(path.join(root, "lisa/skills/import-me/scripts/task.sh"), "utf8"),
      /echo fixture/,
    );
    await assert.rejects(importSkill("codex", "import-me"), /already/);
    await assert.rejects(importSkill("codex", "../escape"), /invalid/);
    await skill(external, "unsafe-link");
    await fs.symlink(
      path.join(root, "lisa/skills/import-me/SKILL.md"),
      path.join(external, "unsafe-link/leak"),
    );
    await assert.rejects(importSkill("codex", "unsafe-link"), /symbolic/);
    assert.equal(
      (await fs.readdir(path.join(root, "lisa/skills"))).some((s) => s.startsWith(".import-")),
      false,
    );
    assert.equal(
      (await discoverSkills(project)).skills.some((s) => s.frontmatter.name === "unsafe-link"),
      false,
    );
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await fs.rm(root, { recursive: true, force: true });
  }
});

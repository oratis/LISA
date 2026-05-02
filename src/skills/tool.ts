import type { ToolDefinition } from "../types.js";
import {
  createSkill,
  deleteSkill,
  getSkill,
  listSkills,
  patchSkill,
  rewriteSkill,
  validateSkillName,
} from "./manager.js";

interface SkillManageInput {
  action: "list" | "view" | "create" | "patch" | "rewrite" | "delete";
  name?: string;
  description?: string;
  body?: string;
  old_string?: string;
  new_string?: string;
  tags?: string[];
}

export const skillManageTool: ToolDefinition<SkillManageInput, string> = {
  name: "skill_manage",
  description:
    "Manage Lisa's reusable skills (procedural knowledge stored as markdown). " +
    "Use this whenever you discover a workflow worth keeping for next time, " +
    "or want to refine an existing skill after using it. Actions: " +
    "`list` (no args) returns the skill index; " +
    "`view` requires `name`; " +
    "`create` requires `name`, `description`, `body` (optional `tags`); " +
    "`patch` requires `name`, `old_string`, `new_string` (must match exactly once); " +
    "`rewrite` requires `name`, `body` (optional `description`); " +
    "`delete` requires `name`. Skill names: lowercase + digits + hyphens, ≤63 chars.",
  inputSchema: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["list", "view", "create", "patch", "rewrite", "delete"],
      },
      name: { type: "string" },
      description: { type: "string", maxLength: 1024 },
      body: { type: "string" },
      old_string: { type: "string" },
      new_string: { type: "string" },
      tags: { type: "array", items: { type: "string" } },
    },
    required: ["action"],
  },
  async execute(input) {
    switch (input.action) {
      case "list": {
        const skills = await listSkills();
        if (skills.length === 0) return "No skills saved yet.";
        return skills
          .map(
            (s) =>
              `- ${s.frontmatter.name} — ${s.frontmatter.description}` +
              (s.frontmatter.tags?.length
                ? ` [${s.frontmatter.tags.join(", ")}]`
                : ""),
          )
          .join("\n");
      }
      case "view": {
        if (!input.name) throw new Error("`name` required for view");
        validateSkillName(input.name);
        const skill = await getSkill(input.name);
        if (!skill) return `Skill "${input.name}" not found.`;
        return `# ${skill.frontmatter.name}\n${skill.frontmatter.description}\n\n${skill.body}`;
      }
      case "create": {
        if (!input.name || !input.description || input.body == null) {
          throw new Error("`name`, `description`, `body` required for create");
        }
        await createSkill(
          {
            name: input.name,
            description: input.description,
            tags: input.tags,
          },
          input.body,
        );
        return `Created skill "${input.name}". It will appear in the skill index from the next session.`;
      }
      case "patch": {
        if (!input.name || input.old_string == null || input.new_string == null) {
          throw new Error("`name`, `old_string`, `new_string` required for patch");
        }
        await patchSkill(input.name, input.old_string, input.new_string);
        return `Patched skill "${input.name}".`;
      }
      case "rewrite": {
        if (!input.name || input.body == null) {
          throw new Error("`name` and `body` required for rewrite");
        }
        await rewriteSkill(input.name, input.body, input.description);
        return `Rewrote skill "${input.name}".`;
      }
      case "delete": {
        if (!input.name) throw new Error("`name` required for delete");
        await deleteSkill(input.name);
        return `Deleted skill "${input.name}".`;
      }
      default:
        throw new Error(`unknown action: ${(input as { action: string }).action}`);
    }
  },
};

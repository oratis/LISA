import fs from "node:fs/promises";
import path from "node:path";
import { atomicWrite, ensureDir, pathExists } from "../fs-utils.js";
import type { ToolDefinition } from "../types.js";

interface FilePatch {
  path: string;
  action: "create" | "update" | "delete";
  content?: string;
  edits?: { old_string: string; new_string: string; replace_all?: boolean }[];
}

interface ApplyPatchInput {
  patches: FilePatch[];
}

export const applyPatchTool: ToolDefinition<ApplyPatchInput, string> = {
  name: "apply_patch",
  description:
    "Apply a structured multi-file patch in one tool call. Each patch declares an `action` " +
    "(`create`, `update`, or `delete`). For `create` and full-file `update`, supply `content`. " +
    "For surgical edits, supply `edits` (array of {old_string, new_string, replace_all?}). " +
    "All file changes succeed-or-fail together (atomic per file, sequential across files). " +
    "Use this instead of multiple `edit` calls when you need to land related changes across several files.",
  inputSchema: {
    type: "object",
    properties: {
      patches: {
        type: "array",
        items: {
          type: "object",
          properties: {
            path: { type: "string" },
            action: { type: "string", enum: ["create", "update", "delete"] },
            content: { type: "string" },
            edits: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  old_string: { type: "string" },
                  new_string: { type: "string" },
                  replace_all: { type: "boolean" },
                },
                required: ["old_string", "new_string"],
              },
            },
          },
          required: ["path", "action"],
        },
      },
    },
    required: ["patches"],
  },
  async execute(input, ctx) {
    const summary: string[] = [];
    for (const patch of input.patches) {
      const abs = path.resolve(ctx.cwd, patch.path);
      if (patch.action === "create") {
        if (await pathExists(abs)) {
          throw new Error(`create: ${abs} already exists`);
        }
        if (patch.content == null) {
          throw new Error(`create: ${abs} requires content`);
        }
        await ensureDir(path.dirname(abs));
        await atomicWrite(abs, patch.content);
        summary.push(`create ${abs} (${patch.content.length} chars)`);
      } else if (patch.action === "delete") {
        if (!(await pathExists(abs))) {
          throw new Error(`delete: ${abs} does not exist`);
        }
        await fs.unlink(abs);
        summary.push(`delete ${abs}`);
      } else if (patch.action === "update") {
        if (!(await pathExists(abs))) {
          throw new Error(`update: ${abs} does not exist (use create instead)`);
        }
        if (patch.content != null) {
          await atomicWrite(abs, patch.content);
          summary.push(`update ${abs} (full rewrite, ${patch.content.length} chars)`);
        } else if (patch.edits && patch.edits.length > 0) {
          let current = await fs.readFile(abs, "utf8");
          for (const edit of patch.edits) {
            const occurrences = countOccurrences(current, edit.old_string);
            if (occurrences === 0) {
              throw new Error(
                `update ${abs}: old_string not found: ${edit.old_string.slice(0, 60)}…`,
              );
            }
            if (occurrences > 1 && !edit.replace_all) {
              throw new Error(
                `update ${abs}: old_string matches ${occurrences} places; pass replace_all:true or add context`,
              );
            }
            current = edit.replace_all
              ? current.split(edit.old_string).join(edit.new_string)
              : current.replace(edit.old_string, edit.new_string);
          }
          await atomicWrite(abs, current);
          summary.push(`update ${abs} (${patch.edits.length} edits)`);
        } else {
          throw new Error(`update ${abs}: provide either content or edits`);
        }
      }
    }
    return summary.join("\n");
  },
};

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let idx = 0;
  while ((idx = haystack.indexOf(needle, idx)) !== -1) {
    count++;
    idx += needle.length;
  }
  return count;
}

import { exportTaskAsRecipe, findRecipe, installRecipe, listRecipes } from "../recipes/store.js";

export async function runRecipesCommand(args: readonly string[]): Promise<number> {
  const [sub, ...rest] = args;
  if (!sub || sub === "--help" || sub === "-h") {
    console.log(
      "usage:\n" +
        "  lisa recipes list [--json]\n" +
        "  lisa recipes show <id|file.json>\n" +
        "  lisa recipes install <id|file.json> [--dry-run]\n" +
        "  lisa recipes export <taskId> [--out <file.json>]",
    );
    return 0;
  }

  if (sub === "list") {
    const items = await listRecipes();
    if (rest.includes("--json")) {
      console.log(JSON.stringify({ recipes: items }, null, 2));
      return 0;
    }
    for (const item of items) {
      const badge = item.verified ? "verified" : "unverified";
      console.log(
        `${item.recipe.id.padEnd(24)} [${item.recipe.task.kind}] (${item.source}, ${badge}) — ${item.recipe.name}`,
      );
    }
    return 0;
  }

  if (sub === "show") {
    const target = rest[0];
    if (!target) {
      console.error("usage: lisa recipes show <id|file.json>");
      return 2;
    }
    const found = await findRecipe(target);
    if (!found) {
      console.error(`Recipe not found: ${target}`);
      return 1;
    }
    console.log(JSON.stringify(found, null, 2));
    return 0;
  }

  if (sub === "install") {
    const target = rest.find((a) => !a.startsWith("-"));
    const dryRun = rest.includes("--dry-run");
    if (!target) {
      console.error("usage: lisa recipes install <id|file.json> [--dry-run]");
      return 2;
    }
    const found = await findRecipe(target);
    if (!found) {
      console.error(`Recipe not found: ${target}`);
      return 1;
    }
    const res = await installRecipe(found.recipe, { dryRun });
    console.log(
      `Permissions for ${found.recipe.id}:\n` +
        `  tools:      ${res.permissions.tools.join(", ")}\n` +
        `  categories: ${res.permissions.categories.join(", ")}\n` +
        `  summary:    ${res.permissions.summary}`,
    );
    if (res.dryRun) {
      console.log("(dry-run: no task created)");
    } else if (res.task) {
      console.log(
        `Installed disabled draft task ${res.task.id} ("${res.task.title}"). Review and enable with: lisa tasks enable ${res.task.id}`,
      );
    }
    return 0;
  }

  if (sub === "export") {
    const taskId = rest.find((a) => !a.startsWith("-"));
    let outPath: string | undefined;
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === "--out") outPath = rest[++i];
      else if (rest[i]!.startsWith("--out=")) outPath = rest[i]!.slice("--out=".length);
    }
    if (!taskId) {
      console.error("usage: lisa recipes export <taskId> [--out <file.json>]");
      return 2;
    }
    const recipe = await exportTaskAsRecipe(taskId, { outPath });
    if (outPath) console.log(`Exported recipe "${recipe.id}" to ${outPath}`);
    else console.log(JSON.stringify(recipe, null, 2));
    return 0;
  }

  console.error(`unknown recipes subcommand: ${sub}`);
  return 2;
}

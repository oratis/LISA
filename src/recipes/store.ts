/**
 * Recipe Gallery validation, Ed25519 signature verification, storage, install,
 * and de-privatized export ("recipe, not meal" — W11).
 */
import crypto from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import { atomicWrite } from "../fs-utils.js";
import { lisaHome } from "../paths.js";
import { createTask, getTask } from "../tasks/store.js";
import type { Task } from "../tasks/types.js";
import { parseNewTask } from "../tasks/validate.js";
import { detectDataClasses } from "../warden/preview.js";
import { BUILTIN_RECIPES } from "./builtins.js";
import {
  RECIPE_SCHEMA_VERSION,
  type Recipe,
  type RecipeListItem,
  type RecipeSignature,
} from "./types.js";

const RECIPE_ID_RE = /^[a-z0-9][a-z0-9-]{1,62}$/;
const SIGN_DOMAIN = "lisa-recipe-v1";

export function recipesDir(home: string = lisaHome()): string {
  return path.join(home, "recipes");
}

function stableSortValue(val: unknown): unknown {
  if (Array.isArray(val)) return val.map(stableSortValue);
  if (val && typeof val === "object") {
    const record = val as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(record).sort()) {
      const v = record[k];
      if (v !== undefined) out[k] = stableSortValue(v);
    }
    return out;
  }
  return val;
}

/** Canonical signing bytes for a recipe (excludes `signature`). */
export function canonicalRecipePayload(recipe: Omit<Recipe, "signature">): Buffer {
  const { signature: _ignored, ...unsigned } = recipe as Recipe;
  return Buffer.from(`${SIGN_DOMAIN}\n${JSON.stringify(stableSortValue(unsigned))}`, "utf8");
}

/** Sign a recipe with an Ed25519 private key. */
export function signRecipe(
  recipe: Omit<Recipe, "signature">,
  opts: { keyId: string; privateKey: crypto.KeyLike; publicKeyPem: string },
): Recipe {
  const sig = crypto.sign(null, canonicalRecipePayload(recipe), opts.privateKey);
  return {
    ...recipe,
    signature: {
      algorithm: "ed25519",
      keyId: opts.keyId,
      publicKeyPem: opts.publicKeyPem.trim(),
      signature: sig.toString("base64"),
    },
  };
}

/** Verify an optional Ed25519 recipe signature. */
export function verifyRecipeSignature(recipe: Recipe): {
  present: boolean;
  valid: boolean;
  reason?: string;
} {
  if (!recipe.signature) return { present: false, valid: false };
  const s = recipe.signature;
  if (s.algorithm !== "ed25519" || !s.publicKeyPem || !s.signature) {
    return { present: true, valid: false, reason: "malformed signature fields" };
  }
  try {
    const pub = crypto.createPublicKey(s.publicKeyPem);
    if (pub.asymmetricKeyType !== "ed25519") {
      return { present: true, valid: false, reason: "public key is not Ed25519" };
    }
    const sigBytes = Buffer.from(s.signature, "base64");
    if (sigBytes.length !== 64) {
      return { present: true, valid: false, reason: "Ed25519 signature must be 64 bytes" };
    }
    const ok = crypto.verify(null, canonicalRecipePayload(recipe), pub, sigBytes);
    return ok
      ? { present: true, valid: true }
      : { present: true, valid: false, reason: "signature verification failed" };
  } catch {
    return { present: true, valid: false, reason: "invalid key or signature encoding" };
  }
}

/** Reject recipes carrying secret-like tokens or personal PII. */
function containsSecretOrPrivateMemory(raw: unknown): string | null {
  const text = JSON.stringify(raw) ?? "";
  const classes = detectDataClasses(text);
  if (classes.includes("secret")) {
    return "Recipe appears to contain embedded secrets or API keys and cannot be accepted.";
  }
  if (/BEGIN\s+(?:RSA|EC|OPENSSH|PGP)\s+PRIVATE KEY/i.test(text)) {
    return "Recipe contains private key material and cannot be accepted.";
  }
  return null;
}

export type RecipeValidationResult =
  { ok: true; recipe: Recipe; verified: boolean } | { ok: false; error: string };

export function validateRecipe(raw: unknown): RecipeValidationResult {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "Recipe must be a JSON object." };
  }
  const r = raw as Record<string, unknown>;
  if (r.version !== RECIPE_SCHEMA_VERSION) {
    return { ok: false, error: `Unsupported recipe version (expected ${RECIPE_SCHEMA_VERSION}).` };
  }
  if (typeof r.id !== "string" || !RECIPE_ID_RE.test(r.id)) {
    return { ok: false, error: "Recipe id must match /^[a-z0-9][a-z0-9-]{1,62}$/." };
  }
  if (typeof r.name !== "string" || !r.name.trim() || r.name.length > 120) {
    return { ok: false, error: "Recipe name is required (max 120 chars)." };
  }
  if (typeof r.description !== "string" || !r.description.trim() || r.description.length > 600) {
    return { ok: false, error: "Recipe description is required (max 600 chars)." };
  }
  if (typeof r.author !== "string" || !r.author.trim() || r.author.length > 120) {
    return { ok: false, error: "Recipe author is required (max 120 chars)." };
  }
  const tags = Array.isArray(r.tags)
    ? r.tags.filter((t): t is string => typeof t === "string" && t.trim().length > 0).slice(0, 12)
    : [];

  const perm = r.permissions as Record<string, unknown> | undefined;
  if (!perm || typeof perm !== "object" || Array.isArray(perm)) {
    return { ok: false, error: "Recipe permissions manifest is required." };
  }
  if (
    !Array.isArray(perm.tools) ||
    !perm.tools.every((t) => typeof t === "string" && t.trim().length > 0) ||
    !Array.isArray(perm.categories) ||
    !perm.categories.every((c) => typeof c === "string" && c.trim().length > 0) ||
    typeof perm.summary !== "string" ||
    !perm.summary.trim()
  ) {
    return {
      ok: false,
      error: "Recipe permissions must list tools, categories, and a non-empty summary.",
    };
  }
  const networkHosts = Array.isArray(perm.networkHosts)
    ? perm.networkHosts.filter((h): h is string => typeof h === "string" && h.trim().length > 0)
    : undefined;

  if (!r.task || typeof r.task !== "object" || Array.isArray(r.task)) {
    return { ok: false, error: "Recipe task template is required." };
  }
  const taskParsed = parseNewTask(r.task, {
    cloud: false,
    origin: { kind: "recipe" },
    owner: null,
  });
  if (!taskParsed.ok) {
    return { ok: false, error: `Invalid recipe task: ${taskParsed.error}` };
  }

  const secretCheck = containsSecretOrPrivateMemory({
    name: r.name,
    description: r.description,
    permissions: perm,
    task: r.task,
  });
  if (secretCheck) return { ok: false, error: secretCheck };

  const recipe: Recipe = {
    version: RECIPE_SCHEMA_VERSION,
    id: r.id,
    name: r.name.trim(),
    description: r.description.trim(),
    author: r.author.trim(),
    tags,
    permissions: {
      tools: perm.tools.map((t) => t.trim()),
      categories: perm.categories.map((c) => c.trim()),
      ...(networkHosts && networkHosts.length ? { networkHosts } : {}),
      summary: perm.summary.trim(),
    },
    task: {
      kind: taskParsed.value.kind,
      title: taskParsed.value.title,
      instruction: taskParsed.value.instruction,
      ...(taskParsed.value.schedule ? { schedule: taskParsed.value.schedule } : {}),
      ...(taskParsed.value.trigger ? { trigger: taskParsed.value.trigger } : {}),
      ...(taskParsed.value.notify ? { notify: taskParsed.value.notify } : {}),
    },
    ...(r.signature && typeof r.signature === "object"
      ? { signature: r.signature as RecipeSignature }
      : {}),
  };

  const sigCheck = verifyRecipeSignature(recipe);
  if (sigCheck.present && !sigCheck.valid) {
    return {
      ok: false,
      error: `Invalid recipe signature: ${sigCheck.reason ?? "verification failed"}`,
    };
  }

  return { ok: true, recipe, verified: sigCheck.present && sigCheck.valid };
}

/** List built-in recipes plus any valid local recipes under `<lisaHome>/recipes/`. */
export async function listRecipes(home: string = lisaHome()): Promise<RecipeListItem[]> {
  const out: RecipeListItem[] = BUILTIN_RECIPES.map((recipe) => ({
    recipe,
    source: "builtin",
    verified: true,
  }));
  const seen = new Set(out.map((item) => item.recipe.id));

  try {
    const files = await fsp.readdir(recipesDir(home));
    for (const file of files.sort()) {
      if (!file.endsWith(".json")) continue;
      try {
        const raw = JSON.parse(await fsp.readFile(path.join(recipesDir(home), file), "utf8"));
        const validated = validateRecipe(raw);
        if (!validated.ok || seen.has(validated.recipe.id)) continue;
        seen.add(validated.recipe.id);
        out.push({ recipe: validated.recipe, source: "local", verified: validated.verified });
      } catch {
        /* ignore malformed local recipe file */
      }
    }
  } catch {
    /* local recipes dir is optional */
  }
  return out;
}

export async function findRecipe(
  idOrPath: string,
  home: string = lisaHome(),
): Promise<RecipeListItem | null> {
  const list = await listRecipes(home);
  const byId = list.find((item) => item.recipe.id === idOrPath);
  if (byId) return byId;

  if (idOrPath.endsWith(".json")) {
    const raw = JSON.parse(await fsp.readFile(path.resolve(idOrPath), "utf8"));
    const validated = validateRecipe(raw);
    if (!validated.ok) throw new Error(validated.error);
    return { recipe: validated.recipe, source: "local", verified: validated.verified };
  }
  return null;
}

/**
 * Install a recipe into the user's Task Engine.
 * Invariant: installed tasks ALWAYS start DISABLED (`enabled: false, createdDisabled: true`)
 * so the user explicitly reviews permissions before any unattended execution.
 */
export async function installRecipe(
  recipe: Recipe,
  opts: { dryRun?: boolean; home?: string } = {},
): Promise<{ task?: Task; permissions: Recipe["permissions"]; dryRun: boolean }> {
  const validated = validateRecipe(recipe);
  if (!validated.ok) throw new Error(validated.error);
  if (opts.dryRun) {
    return { permissions: validated.recipe.permissions, dryRun: true };
  }
  const parsed = parseNewTask(
    {
      ...validated.recipe.task,
      envelope: {
        tools: validated.recipe.permissions.tools,
        categories: validated.recipe.permissions.categories,
      },
    },
    { cloud: false, origin: { kind: "recipe" }, owner: null },
  );
  if (!parsed.ok) throw new Error(parsed.error);
  const task = await createTask({
    ...parsed.value,
    enabled: false,
    createdDisabled: true,
  });
  return { task, permissions: validated.recipe.permissions, dryRun: false };
}

/** Export an existing local task as a de-privatized shareable recipe JSON. */
export async function exportTaskAsRecipe(
  taskId: string,
  opts: { id?: string; author?: string; outPath?: string } = {},
): Promise<Recipe> {
  const task = await getTask(taskId);
  if (!task) throw new Error(`Task not found: ${taskId}`);
  const slug =
    opts.id ??
    task.title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 50);
  const recipe: Recipe = {
    version: RECIPE_SCHEMA_VERSION,
    id: RECIPE_ID_RE.test(slug) ? slug : `recipe-${task.id.slice(0, 8)}`,
    name: task.title,
    description: `Exported ${task.kind} recipe from LISA Task Engine.`,
    author: opts.author ?? "Local Author",
    tags: [task.kind, "exported"],
    permissions: {
      tools: task.envelope?.tools ? [...task.envelope.tools] : ["read"],
      categories: task.envelope?.categories ? [...task.envelope.categories] : ["read"],
      summary: "Review requested tools and categories before enabling.",
    },
    task: {
      kind: task.kind,
      title: task.title,
      instruction: task.instruction,
      ...(task.schedule ? { schedule: task.schedule } : {}),
      ...(task.trigger ? { trigger: task.trigger } : {}),
      notify: task.notify,
    },
  };
  const checked = validateRecipe(recipe);
  if (!checked.ok) throw new Error(checked.error);
  if (opts.outPath) {
    await atomicWrite(path.resolve(opts.outPath), JSON.stringify(checked.recipe, null, 2) + "\n");
  }
  return checked.recipe;
}

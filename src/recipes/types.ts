/**
 * Recipe Gallery types ("recipe, not meal" — W11).
 *
 * A Recipe packages reusable routines, watchers, or goal blueprints WITH an
 * explicit permission manifest and optional Ed25519 signature — NEVER personal
 * memory, credentials, or auto-enabled unattended tasks.
 */
import type { ScheduleSpec, TaskKind, TaskNotify, TriggerSpec } from "../tasks/types.js";

export const RECIPE_SCHEMA_VERSION = 1;

export interface RecipePermissions {
  /** Exact tools the recipe expects (e.g. ["web_search", "kb_write"]). */
  tools: string[];
  /** Warden action categories touched (e.g. ["read", "self"]). */
  categories: string[];
  /** Optional hostnames the recipe fetches or queries. */
  networkHosts?: string[];
  /** Human-readable explanation of why these permissions are needed. */
  summary: string;
}

export interface RecipeTaskTemplate {
  kind: TaskKind;
  title: string;
  instruction: string;
  schedule?: ScheduleSpec;
  trigger?: TriggerSpec;
  notify?: TaskNotify;
}

export interface RecipeSignature {
  algorithm: "ed25519";
  keyId: string;
  publicKeyPem: string;
  /** Base64 Ed25519 signature over canonical recipe payload (excluding signature). */
  signature: string;
}

export interface Recipe {
  version: typeof RECIPE_SCHEMA_VERSION;
  id: string;
  name: string;
  description: string;
  author: string;
  tags: string[];
  permissions: RecipePermissions;
  task: RecipeTaskTemplate;
  signature?: RecipeSignature;
}

export interface RecipeListItem {
  recipe: Recipe;
  source: "builtin" | "local";
  verified: boolean;
}

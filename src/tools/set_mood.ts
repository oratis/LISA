import path from "node:path";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { moodBus } from "../mood-bus.js";
import type { ToolDefinition } from "../types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Resolve relative to the built dist/ tree at runtime.
const MOODS_DIR = path.resolve(__dirname, "..", "web", "assets", "lisa");

interface SetMoodInput {
  mood: string;
}

let cached: { at: number; slugs: Set<string> } | null = null;
const CACHE_TTL_MS = 30_000;

async function loadAvailableSlugs(): Promise<Set<string>> {
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.slugs;
  try {
    const files = await fs.readdir(MOODS_DIR);
    const slugs = new Set(
      files
        .filter((f) => f.endsWith(".png"))
        .map((f) => f.slice(0, -".png".length)),
    );
    cached = { at: Date.now(), slugs };
    return slugs;
  } catch {
    cached = { at: Date.now(), slugs: new Set() };
    return cached.slugs;
  }
}

export async function availableMoodSlugs(): Promise<string[]> {
  const set = await loadAvailableSlugs();
  return Array.from(set).sort();
}

export const setMoodTool: ToolDefinition<SetMoodInput, string> = {
  name: "set_mood",
  description:
    "Update Lisa's visible avatar to match her current mood/state. Call this " +
    "near the START of a response when your mood or activity meaningfully " +
    "shifts — e.g. about to run a destructive command (`scared`), focused " +
    "coding work (`working-coding`), thanking the user (`grateful`), " +
    "celebrating a win (`cheering`). Don't call it every turn — only when " +
    "the avatar would actually change. The full catalog is in your system " +
    "prompt; pick the closest match by slug.",
  inputSchema: {
    type: "object",
    properties: {
      mood: {
        type: "string",
        description:
          "kebab-case mood slug from the catalog (e.g. happy, working-coding, sleepy).",
      },
    },
    required: ["mood"],
  },
  async execute(input) {
    const slugs = await loadAvailableSlugs();
    const mood = input.mood.toLowerCase().trim();
    if (!slugs.has(mood)) {
      const fuzzy = Array.from(slugs)
        .filter((s) => s.includes(mood) || mood.includes(s))
        .slice(0, 5);
      throw new Error(
        `unknown mood "${mood}". Closest: ${fuzzy.join(", ") || "(none)"}. Use one of the slugs from the catalog.`,
      );
    }
    moodBus.set(mood);
    return `mood→${mood}`;
  },
};

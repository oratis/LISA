/**
 * Screen advisor — periodic, opt-in screen-aware coaching.
 *
 * When enabled, the server captures a full-screen screenshot every N minutes,
 * asks the model for the single best next coding step grounded in what's on
 * screen, and pushes it to the Lisa Island as a suggestion card. Clicking it
 * prefills the suggestion into the chat composer so the user can confirm before
 * any coding agent is dispatched.
 *
 * PRIVACY (this is a sensitive capability — treat it as such):
 *   - DISABLED by default. Nothing is captured until the user turns it on in
 *     Settings.
 *   - The screenshot only leaves the machine for the single analysis call to
 *     the model the user already uses; the image is never persisted by LISA
 *     (capture writes a temp PNG that the capture layer deletes), and only the
 *     short text suggestion is kept in memory.
 *   - The suggestion never auto-runs anything: clicking it only prefills chat.
 *
 * This module is provider-agnostic and side-effect-light so the parsing and
 * config logic can be unit-tested without a real LLM or a real screen.
 */

import fsp from "node:fs/promises";
import path from "node:path";
import { LISA_HOME } from "../paths.js";

export interface ScreenAdvisorConfig {
  /** Master switch. Off by default — capture only happens when true. */
  enabled: boolean;
  /** Minutes between captures. Clamped to [MIN, MAX]. */
  intervalMinutes: number;
}

export const DEFAULT_SCREEN_ADVISOR_CONFIG: ScreenAdvisorConfig = {
  enabled: false,
  intervalMinutes: 10,
};

export const MIN_INTERVAL_MINUTES = 2;
export const MAX_INTERVAL_MINUTES = 240;

export const SCREEN_ADVISOR_CONFIG_PATH = path.join(LISA_HOME, "screen-advisor.json");

/** Coerce arbitrary input into a valid config (clamped interval, boolean enabled). */
export function normalizeConfig(
  raw: Partial<ScreenAdvisorConfig> | null | undefined,
): ScreenAdvisorConfig {
  const enabled = raw?.enabled === true;
  let n = Number(raw?.intervalMinutes);
  if (!Number.isFinite(n)) n = DEFAULT_SCREEN_ADVISOR_CONFIG.intervalMinutes;
  n = Math.round(n);
  if (n < MIN_INTERVAL_MINUTES) n = MIN_INTERVAL_MINUTES;
  if (n > MAX_INTERVAL_MINUTES) n = MAX_INTERVAL_MINUTES;
  return { enabled, intervalMinutes: n };
}

export async function loadScreenAdvisorConfig(
  p: string = SCREEN_ADVISOR_CONFIG_PATH,
): Promise<ScreenAdvisorConfig> {
  try {
    const raw = JSON.parse(await fsp.readFile(p, "utf8")) as Partial<ScreenAdvisorConfig>;
    return normalizeConfig(raw);
  } catch {
    return { ...DEFAULT_SCREEN_ADVISOR_CONFIG };
  }
}

export async function saveScreenAdvisorConfig(
  cfg: ScreenAdvisorConfig,
  p: string = SCREEN_ADVISOR_CONFIG_PATH,
): Promise<ScreenAdvisorConfig> {
  const norm = normalizeConfig(cfg);
  await fsp.mkdir(path.dirname(p), { recursive: true });
  await fsp.writeFile(p, JSON.stringify(norm, null, 2));
  return norm;
}

/** A single screen-grounded next-step suggestion. */
export interface ScreenSuggestion {
  /** ≤8-word imperative headline. */
  title: string;
  /** 1–2 sentences citing what was on screen. */
  rationale: string;
  /** Self-contained prompt a coding agent could act on. */
  task: string;
  /** ISO timestamp, stamped by the caller. */
  at: string;
}

export const SCREEN_ADVISOR_SYSTEM = `You are Lisa's screen advisor. You are shown ONE screenshot of the user's screen. Suggest the single highest-value next CODING step, grounded in what is actually visible — an error, a failing test, a TODO/FIXME, an open file, a diff, a PR, a design. Be specific and actionable: prefer something a coding agent could pick up and finish.

Respond with ONLY a compact JSON object — no prose, no markdown, no code fences:
{"title":"<=8-word imperative headline","rationale":"1-2 sentences citing what you saw","task":"a self-contained prompt for a coding agent: exactly what to do, and in which file/dir if visible"}

If the screen shows nothing actionable for coding (a video, a chat, the desktop, unrelated browsing), respond with exactly: {"skip":true}`;

/**
 * Tolerantly parse the model's reply into a suggestion. Strips code fences,
 * extracts the first JSON object, and returns null for {"skip":true} or any
 * malformed / incomplete reply (so the loop simply surfaces nothing).
 */
export function parseSuggestion(text: string | null | undefined): Omit<ScreenSuggestion, "at"> | null {
  if (!text) return null;
  let s = text.trim();
  // Drop a leading ```json / ``` fence and a trailing fence if present.
  s = s.replace(/^```[a-zA-Z]*\s*/, "").replace(/\s*```$/, "").trim();
  const a = s.indexOf("{");
  const b = s.lastIndexOf("}");
  if (a < 0 || b <= a) return null;
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(s.slice(a, b + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (obj.skip === true) return null;
  const title = typeof obj.title === "string" ? obj.title.trim() : "";
  const task = typeof obj.task === "string" ? obj.task.trim() : "";
  if (!title || !task) return null;
  const rationale = typeof obj.rationale === "string" ? obj.rationale.trim() : "";
  return {
    title: title.slice(0, 120),
    rationale: rationale.slice(0, 400),
    task: task.slice(0, 2000),
  };
}

/** Minimal provider surface the analyzer needs (keeps the engine testable). */
export interface SuggestionProvider {
  runTurn(opts: {
    systemPrompt: string;
    messages: Array<{ role: "user" | "assistant"; content: unknown }>;
    tools: unknown[];
    model: string;
    maxTokens?: number;
  }): Promise<{ content: Array<{ type: string; text?: string }> }>;
}

/** Run one screenshot through the model and parse the suggestion (or null). */
export async function analyzeScreenshot(opts: {
  provider: SuggestionProvider;
  model: string;
  imageBase64: string;
  mediaType?: string;
}): Promise<Omit<ScreenSuggestion, "at"> | null> {
  const result = await opts.provider.runTurn({
    systemPrompt: SCREEN_ADVISOR_SYSTEM,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "Here is my screen right now. What is the single best next coding step?" },
          {
            type: "image",
            source: {
              type: "base64",
              media_type: opts.mediaType ?? "image/png",
              data: opts.imageBase64,
            },
          },
        ],
      },
    ],
    tools: [],
    model: opts.model,
    maxTokens: 600,
  });
  const textBlock = result.content.find((b) => b.type === "text");
  return parseSuggestion(textBlock?.text ?? "");
}

import fs from "node:fs/promises";
import path from "node:path";
import { lisaHome } from "../paths.js";
import { atomicWrite } from "../fs-utils.js";
export interface ExpressionPreferences {
  display: "auto" | "static" | "emoji" | "off";
  frequency: "restrained" | "lively";
}
export const defaultExpressionPreferences: ExpressionPreferences = {
  display: "auto",
  frequency: "restrained",
};
export function parseExpressionPreferences(v: unknown): ExpressionPreferences {
  if (!v || typeof v !== "object") throw new Error("Invalid expression preferences");
  const p = v as ExpressionPreferences;
  if (
    !["auto", "static", "emoji", "off"].includes(p.display) ||
    !["restrained", "lively"].includes(p.frequency)
  )
    throw new Error("Invalid expression preferences");
  return { display: p.display, frequency: p.frequency };
}
export async function readExpressionPreferences(): Promise<ExpressionPreferences> {
  try {
    return parseExpressionPreferences(
      JSON.parse(await fs.readFile(path.join(lisaHome(), "expression-preferences.json"), "utf8")),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { ...defaultExpressionPreferences };
    // A damaged preference must not silently re-enable animations.
    return { display: "static", frequency: "restrained" };
  }
}
export async function writeExpressionPreferences(v: unknown): Promise<ExpressionPreferences> {
  const prefs = parseExpressionPreferences(v);
  await atomicWrite(
    path.join(lisaHome(), "expression-preferences.json"),
    JSON.stringify(prefs) + "\n",
  );
  return prefs;
}

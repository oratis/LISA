import fs from "node:fs/promises";
import path from "node:path";
import { lisaHome } from "../../paths.js";

function filePath(): string {
  return path.join(lisaHome(), "sense", "social", "policy.json");
}

export async function socialPublishingPaused(): Promise<boolean> {
  if (process.env.LISA_SOCIAL_PUBLISH_PAUSED === "1") return true;
  try {
    const parsed = JSON.parse(await fs.readFile(filePath(), "utf8")) as {
      paused?: unknown;
    };
    return parsed.paused === true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    return true; // corrupt/unreadable policy fails closed
  }
}

export async function setSocialPublishingPaused(paused: boolean): Promise<void> {
  const file = filePath();
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await fs.writeFile(
    file,
    JSON.stringify({ version: 1, paused, updatedAt: new Date().toISOString() }, null, 2),
    { encoding: "utf8", mode: 0o600 },
  );
}

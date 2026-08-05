import fs from "node:fs/promises";
import path from "node:path";
import { lisaHome } from "../../paths.js";

export interface SocialAuditRecord {
  at: string;
  draftId: string;
  revision: number;
  digestPrefix: string;
  state: string;
  targets: Array<{
    targetKey: string;
    ok: boolean;
    platformPostId?: string;
    error?: string;
  }>;
}

export async function appendSocialAudit(record: SocialAuditRecord): Promise<void> {
  const file = path.join(lisaHome(), "sense", "social", "audit.jsonl");
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await fs.appendFile(file, `${JSON.stringify(record)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await fs.chmod(file, 0o600);
}

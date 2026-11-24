/**
 * Authorized, sandbox-contained task artifact resolution & preview helpers
 * (A04 / B04 of docs/PLAN_PRODUCT_ALIGNMENT_2026-10-24.md).
 *
 * Security invariants:
 *  - Every file artifact MUST resolve through `fs.realpath` strictly inside
 *    the owning task's isolated workspace `<lisaHome>/task-workspaces/<taskId>/`.
 *  - Symlinks escaping the task workspace, `..` traversal, non-regular files,
 *    and files exceeding `MAX_ARTIFACT_BYTES` are rejected fail-closed without
 *    revealing host filesystem paths.
 *  - Responses carry `X-Content-Type-Options: nosniff` and
 *    `Content-Security-Policy: default-src 'none'; sandbox`; HTML/SVG/unknown
 *    types are forced to `Content-Disposition: attachment` so active content
 *    never executes inside the main LISA origin.
 */
import fsp from "node:fs/promises";
import path from "node:path";
import type { TaskArtifact, TaskRun } from "./types.js";
import { taskWorkspaceDir } from "./workspace.js";

export const MAX_ARTIFACT_BYTES = 2 * 1024 * 1024; // 2 MiB preview/download cap

export interface PublicTaskArtifact {
  id: string;
  kind: TaskArtifact["kind"];
  title?: string;
  /** Present for `text` and safe http(s) `link`; omitted for `file` so host paths never leak. */
  value?: string;
  /** Basename for `file` artifacts (never an absolute host path). */
  filename?: string;
  previewUrl: string;
  downloadUrl: string;
}

export type ResolvedArtifact =
  | {
      ok: true;
      kind: "file" | "text";
      contentType: string;
      filename: string;
      forceAttachment: boolean;
      body: Buffer;
    }
  | {
      ok: true;
      kind: "link";
      id: string;
      title?: string;
      url: string;
    }
  | {
      ok: false;
      status: 400 | 403 | 404 | 413;
      error: string;
    };

const SAFE_MIME_BY_EXT: Readonly<Record<string, { mime: string; attachmentOnly?: boolean }>> = {
  ".txt": { mime: "text/plain; charset=utf-8" },
  ".md": { mime: "text/markdown; charset=utf-8" },
  ".markdown": { mime: "text/markdown; charset=utf-8" },
  ".json": { mime: "application/json; charset=utf-8" },
  ".csv": { mime: "text/csv; charset=utf-8" },
  ".log": { mime: "text/plain; charset=utf-8" },
  ".yaml": { mime: "text/plain; charset=utf-8" },
  ".yml": { mime: "text/plain; charset=utf-8" },
  ".png": { mime: "image/png" },
  ".jpg": { mime: "image/jpeg" },
  ".jpeg": { mime: "image/jpeg" },
  ".webp": { mime: "image/webp" },
  ".gif": { mime: "image/gif" },
  ".pdf": { mime: "application/pdf" },
  ".html": { mime: "text/html; charset=utf-8", attachmentOnly: true },
  ".htm": { mime: "text/html; charset=utf-8", attachmentOnly: true },
  ".svg": { mime: "image/svg+xml", attachmentOnly: true },
};

function artifactIdOf(artifact: TaskArtifact, index: number): string {
  return artifact.id && /^[a-zA-Z0-9_-]{1,64}$/.test(artifact.id) ? artifact.id : String(index);
}

function sanitizeFilename(raw: string, fallback: string): string {
  const base = path
    .basename(raw || "")
    .replace(/[^\w.\- ]+/g, "_")
    .trim();
  if (!base || base === "." || base === "..") return fallback;
  return base.slice(0, 120);
}

function safeHttpUrl(raw: string): string | null {
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    if (parsed.username || parsed.password) return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

/** Build client-safe artifact descriptors without leaking absolute host file paths. */
export function publicArtifactsForRun(
  run: Pick<TaskRun, "taskId" | "id" | "artifacts">,
): PublicTaskArtifact[] {
  const list = run.artifacts ?? [];
  return list.map((artifact, index) => {
    const id = artifactIdOf(artifact, index);
    const base = `/api/tasks/${encodeURIComponent(run.taskId)}/runs/${encodeURIComponent(run.id)}/artifacts/${encodeURIComponent(id)}`;
    if (artifact.kind === "file") {
      return {
        id,
        kind: "file",
        title: artifact.title,
        filename: sanitizeFilename(artifact.value, `artifact-${id}`),
        previewUrl: base,
        downloadUrl: `${base}?download=1`,
      };
    }
    if (artifact.kind === "link") {
      const safe = safeHttpUrl(artifact.value);
      return {
        id,
        kind: "link",
        title: artifact.title,
        ...(safe ? { value: safe } : {}),
        previewUrl: base,
        downloadUrl: `${base}?download=1`,
      };
    }
    return {
      id,
      kind: "text",
      title: artifact.title,
      value: artifact.value,
      previewUrl: base,
      downloadUrl: `${base}?download=1`,
    };
  });
}

function findArtifact(
  run: TaskRun,
  artifactId: string,
): { artifact: TaskArtifact; id: string } | null {
  const list = run.artifacts ?? [];
  for (let i = 0; i < list.length; i++) {
    const item = list[i]!;
    const id = artifactIdOf(item, i);
    if (id === artifactId) return { artifact: item, id };
  }
  return null;
}

function isInsideDir(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel !== "" && rel !== ".." && !rel.startsWith(".." + path.sep) && !path.isAbsolute(rel);
}

/** Resolve one artifact from a verified TaskRun under strict workspace containment. */
export async function resolveTaskArtifact(
  run: TaskRun,
  artifactId: string,
): Promise<ResolvedArtifact> {
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(artifactId)) {
    return { ok: false, status: 400, error: "invalid_artifact_id" };
  }
  const found = findArtifact(run, artifactId);
  if (!found) {
    return { ok: false, status: 404, error: "artifact_not_found" };
  }
  const { artifact, id } = found;

  if (artifact.kind === "text") {
    const body = Buffer.from(artifact.value, "utf8");
    if (body.byteLength > MAX_ARTIFACT_BYTES) {
      return { ok: false, status: 413, error: "artifact_too_large" };
    }
    const name = sanitizeFilename(
      artifact.title ? `${artifact.title}.txt` : `artifact-${id}.txt`,
      `artifact-${id}.txt`,
    );
    return {
      ok: true,
      kind: "text",
      contentType: "text/plain; charset=utf-8",
      filename: name,
      forceAttachment: false,
      body,
    };
  }

  if (artifact.kind === "link") {
    const url = safeHttpUrl(artifact.value);
    if (!url) {
      return { ok: false, status: 403, error: "artifact_link_unsafe" };
    }
    return {
      ok: true,
      kind: "link",
      id,
      title: artifact.title,
      url,
    };
  }

  // `kind === "file"`: must resolve inside `<lisaHome>/task-workspaces/<taskId>/`.
  let wsReal: string;
  try {
    wsReal = await fsp.realpath(taskWorkspaceDir(run.taskId));
  } catch {
    return { ok: false, status: 404, error: "artifact_not_found" };
  }

  const rawPath = artifact.value;
  if (!rawPath || rawPath.includes("\0")) {
    return { ok: false, status: 403, error: "artifact_path_denied" };
  }
  const candidate = path.isAbsolute(rawPath) ? rawPath : path.resolve(wsReal, rawPath);
  let realTarget: string;
  try {
    realTarget = await fsp.realpath(candidate);
  } catch {
    return { ok: false, status: 404, error: "artifact_not_found" };
  }

  if (!isInsideDir(wsReal, realTarget)) {
    return { ok: false, status: 403, error: "artifact_path_denied" };
  }

  let stat;
  try {
    stat = await fsp.stat(realTarget);
  } catch {
    return { ok: false, status: 404, error: "artifact_not_found" };
  }
  if (!stat.isFile()) {
    return { ok: false, status: 403, error: "artifact_not_regular_file" };
  }
  if (stat.size > MAX_ARTIFACT_BYTES) {
    return { ok: false, status: 413, error: "artifact_too_large" };
  }

  const body = await fsp.readFile(realTarget);
  const ext = path.extname(realTarget).toLowerCase();
  const mimeInfo = SAFE_MIME_BY_EXT[ext];
  return {
    ok: true,
    kind: "file",
    contentType: mimeInfo?.mime ?? "application/octet-stream",
    filename: sanitizeFilename(path.basename(realTarget), `artifact-${id}`),
    forceAttachment: mimeInfo ? mimeInfo.attachmentOnly === true : true,
    body,
  };
}

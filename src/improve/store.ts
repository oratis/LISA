/**
 * Versioned personal capability store, atomic preview/apply/rollback,
 * upstream conflict detection, and de-privatized community export for
 * Improve LISA M0/M1 (docs/PLAN_IMPROVE_LISA_2026-11-07.md).
 *
 * All state lives inside `<lisaHome>/improvements/` (mode 0700, files 0600),
 * strictly scoped to the active tenant/user home. Applying or rolling back a
 * capability NEVER touches normal chat sessions, soul files, or memory.
 */
import crypto from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import { atomicWrite } from "../fs-utils.js";
import { lisaHome } from "../paths.js";
import { withFileLock } from "../soul/lock.js";
import { detectDataClasses, redactSecrets } from "../warden/preview.js";
import {
  IMPROVE_SCHEMA_VERSION,
  type AcceptanceCheckResult,
  type CapabilityVersion,
  type ChangeSet,
  type ChangeSetFile,
  type ContributionExport,
  type ImprovementCapabilityKind,
  type ImprovementRecord,
  type ImprovementsState,
} from "./types.js";

const PACKAGE_ID_RE = /^[a-z0-9][a-z0-9-]{1,62}$/;
const MAX_FILES_PER_CHANGESET = 16;
const MAX_FILE_BYTES = 128 * 1024;
const UPSTREAM_REPO = "oratis/LISA";
const UPSTREAM_BRANCH = "main";

export function improvementsDir(home: string = lisaHome()): string {
  return path.join(home, "improvements");
}

function stateFile(home: string): string {
  return path.join(improvementsDir(home), "state.json");
}

function lockFile(home: string): string {
  return path.join(improvementsDir(home), "state.lock");
}

function emptyState(): ImprovementsState {
  return {
    version: IMPROVE_SCHEMA_VERSION,
    profileVersion: 0,
    items: [],
    activeCapabilities: {},
    versionArchive: {},
  };
}

function newId(prefix: string): string {
  return `${prefix}_${crypto.randomBytes(6).toString("hex")}`;
}

function sha256(text: string): string {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

function isSafeRelativeFilePath(p: string): boolean {
  if (!p || p.includes("\0") || p.startsWith("/") || p.startsWith("\\")) return false;
  if (/^[a-zA-Z]:/.test(p)) return false;
  const normalized = path.posix.normalize(p.replace(/\\/g, "/"));
  if (normalized === "." || normalized === ".." || normalized.startsWith("../")) return false;
  return /^[a-zA-Z0-9._/-]{1,160}$/.test(normalized);
}

function computeChangeSetDigest(
  packageId: string,
  kind: ImprovementCapabilityKind,
  files: readonly ChangeSetFile[],
  requiredCapabilities: readonly string[],
): string {
  const payload = JSON.stringify({
    packageId,
    kind,
    requiredCapabilities: [...requiredCapabilities].sort(),
    files: [...files]
      .map((f) => ({ path: f.path, sha256: f.sha256 }))
      .sort((a, b) => a.path.localeCompare(b.path)),
  });
  return sha256(payload);
}

async function readState(home: string): Promise<ImprovementsState> {
  try {
    const raw = JSON.parse(
      await fsp.readFile(stateFile(home), "utf8"),
    ) as Partial<ImprovementsState>;
    if (raw && raw.version === IMPROVE_SCHEMA_VERSION && Array.isArray(raw.items)) {
      return {
        version: IMPROVE_SCHEMA_VERSION,
        profileVersion: typeof raw.profileVersion === "number" ? raw.profileVersion : 0,
        items: raw.items,
        activeCapabilities: raw.activeCapabilities ?? {},
        versionArchive: raw.versionArchive ?? {},
      };
    }
  } catch {
    /* missing or unreadable initializes cleanly */
  }
  return emptyState();
}

async function writeState(home: string, state: ImprovementsState): Promise<void> {
  await fsp.mkdir(improvementsDir(home), { recursive: true, mode: 0o700 });
  await atomicWrite(stateFile(home), JSON.stringify(state, null, 2) + "\n");
  await fsp.chmod(stateFile(home), 0o600).catch(() => undefined);
}

function normalizePackageId(raw: string): string {
  const slug = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return PACKAGE_ID_RE.test(slug) ? slug : `cap-${crypto.randomBytes(3).toString("hex")}`;
}

export interface CreateImprovementInput {
  title: string;
  goal: string;
  kind?: ImprovementCapabilityKind;
  packageId?: string;
  sessionId?: string;
  originSessionId?: string;
  originMessageIds?: string[];
  files?: Array<{ path: string; content: string }>;
  requiredCapabilities?: string[];
}

export function validateChangeSetFiles(
  files: Array<{ path: string; content: string }>,
): { ok: true; files: ChangeSetFile[] } | { ok: false; error: string } {
  if (!Array.isArray(files) || files.length === 0) {
    return { ok: false, error: "ChangeSet must include at least one file." };
  }
  if (files.length > MAX_FILES_PER_CHANGESET) {
    return { ok: false, error: `At most ${MAX_FILES_PER_CHANGESET} files per ChangeSet.` };
  }
  const seen = new Set<string>();
  const out: ChangeSetFile[] = [];
  for (const f of files) {
    if (!f || typeof f.path !== "string" || typeof f.content !== "string") {
      return { ok: false, error: "Each file must provide string path and content." };
    }
    const cleanPath = path.posix.normalize(f.path.replace(/\\/g, "/"));
    if (!isSafeRelativeFilePath(cleanPath)) {
      return { ok: false, error: `Unsafe file path in ChangeSet: ${f.path}` };
    }
    if (seen.has(cleanPath)) {
      return { ok: false, error: `Duplicate file path in ChangeSet: ${cleanPath}` };
    }
    if (Buffer.byteLength(f.content, "utf8") > MAX_FILE_BYTES) {
      return { ok: false, error: `File ${cleanPath} exceeds ${MAX_FILE_BYTES} bytes.` };
    }
    seen.add(cleanPath);
    out.push({ path: cleanPath, content: f.content, sha256: sha256(f.content) });
  }
  return { ok: true, files: out };
}

function runSyntheticChecks(
  kind: ImprovementCapabilityKind,
  files: readonly ChangeSetFile[],
): AcceptanceCheckResult[] {
  const checks: AcceptanceCheckResult[] = [];
  checks.push({
    name: "path-confinement",
    passed: files.every((f) => isSafeRelativeFilePath(f.path)),
    detail: "Every ChangeSet path stays inside the personal capability package.",
  });
  const hasSecret = files.some(
    (f) =>
      detectDataClasses(f.content).includes("secret") ||
      /BEGIN\s+(?:RSA|EC|OPENSSH|PGP)\s+PRIVATE KEY/i.test(f.content),
  );
  checks.push({
    name: "no-embedded-secrets",
    passed: !hasSecret,
    detail: hasSecret
      ? "Secret-like token or private key detected in ChangeSet."
      : "No credentials or private keys detected.",
  });
  if (kind === "preference") {
    const validJson = files.every((f) => {
      if (!f.path.endsWith(".json")) return true;
      try {
        JSON.parse(f.content);
        return true;
      } catch {
        return false;
      }
    });
    checks.push({
      name: "valid-preference-json",
      passed: validJson,
      detail: validJson ? "Preference JSON parses cleanly." : "Invalid JSON in preference file.",
    });
  } else {
    const nonEmpty = files.every((f) => f.content.trim().length > 0);
    checks.push({
      name: "non-empty-capability",
      passed: nonEmpty,
      detail: nonEmpty ? "All capability files are non-empty." : "Empty capability file found.",
    });
  }
  return checks;
}

export async function listImprovements(home: string = lisaHome()): Promise<{
  profileVersion: number;
  items: ImprovementRecord[];
  activeCapabilities: CapabilityVersion[];
}> {
  const state = await readState(home);
  return {
    profileVersion: state.profileVersion,
    items: [...state.items].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    activeCapabilities: Object.values(state.activeCapabilities).sort((a, b) =>
      a.packageId.localeCompare(b.packageId),
    ),
  };
}

export async function getImprovement(
  id: string,
  home: string = lisaHome(),
): Promise<ImprovementRecord | null> {
  const state = await readState(home);
  return state.items.find((item) => item.id === id) ?? null;
}

export async function createImprovement(
  input: CreateImprovementInput,
  home: string = lisaHome(),
  now: number = Date.now(),
): Promise<ImprovementRecord> {
  const title = String(input.title ?? "")
    .trim()
    .slice(0, 120);
  const goal = String(input.goal ?? "")
    .trim()
    .slice(0, 2000);
  if (!title || !goal) {
    throw new Error("Improvement title and goal are required.");
  }
  const kind: ImprovementCapabilityKind =
    input.kind === "preference" || input.kind === "workflow" ? input.kind : "skill";
  const packageId = input.packageId
    ? normalizePackageId(input.packageId)
    : normalizePackageId(title);

  return await withFileLock(
    lockFile(home),
    async () => {
      const state = await readState(home);
      const iso = new Date(now).toISOString();
      const defaultFiles =
        input.files && input.files.length > 0
          ? input.files
          : [
              {
                path: kind === "preference" ? "preferences.json" : "SKILL.md",
                content:
                  kind === "preference"
                    ? JSON.stringify({ title, goal }, null, 2) + "\n"
                    : `---\nname: ${packageId}\ndescription: ${title}\n---\n\n# ${title}\n\n${goal}\n`,
              },
            ];
      const checked = validateChangeSetFiles(defaultFiles);
      if (!checked.ok) throw new Error(checked.error);
      const requiredCapabilities = (input.requiredCapabilities ?? ["read"])
        .map((c) => String(c).trim())
        .filter(Boolean)
        .slice(0, 32);
      const changeSet: ChangeSet = {
        id: newId("cs"),
        revision: 1,
        baseProfileVersion: state.profileVersion,
        files: checked.files,
        digest: computeChangeSetDigest(packageId, kind, checked.files, requiredCapabilities),
        requiredCapabilities,
        acceptanceCases: [],
      };
      const record: ImprovementRecord = {
        id: newId("imp"),
        ...(input.sessionId ? { sessionId: input.sessionId } : {}),
        ...(input.originSessionId ? { originSessionId: input.originSessionId } : {}),
        ...(input.originMessageIds
          ? { originMessageIds: input.originMessageIds.slice(0, 20) }
          : {}),
        packageId,
        kind,
        title,
        goal,
        workStatus: "draft",
        activationStatus: "inactive",
        contributionStatus: "none",
        changeSet,
        history: [],
        createdAt: iso,
        updatedAt: iso,
      };
      state.items.push(record);
      await writeState(home, state);
      return record;
    },
    { timeoutMs: 5_000, staleMs: 30_000 },
  );
}

/**
 * Preview & validate an improvement ChangeSet (optionally updating its files).
 * Changing files increments revision and rotates `digest`, invalidating any
 * earlier approval bound to the previous digest.
 */
export async function previewImprovement(
  id: string,
  opts: {
    files?: Array<{ path: string; content: string }>;
    requiredCapabilities?: string[];
    rebaseToCurrentProfile?: boolean;
  } = {},
  home: string = lisaHome(),
  now: number = Date.now(),
): Promise<ImprovementRecord> {
  return await withFileLock(
    lockFile(home),
    async () => {
      const state = await readState(home);
      const item = state.items.find((i) => i.id === id);
      if (!item) throw new Error(`Improvement not found: ${id}`);

      const rawFiles =
        opts.files ??
        item.changeSet?.files.map((f) => ({ path: f.path, content: f.content })) ??
        [];
      const checked = validateChangeSetFiles(rawFiles);
      if (!checked.ok) {
        item.workStatus = "failed";
        item.updatedAt = new Date(now).toISOString();
        await writeState(home, state);
        throw new Error(checked.error);
      }

      const requiredCapabilities = opts.requiredCapabilities
        ? opts.requiredCapabilities.map((c) => String(c).trim()).filter(Boolean)
        : (item.changeSet?.requiredCapabilities ?? ["read"]);
      const digest = computeChangeSetDigest(
        item.packageId,
        item.kind,
        checked.files,
        requiredCapabilities,
      );
      const acceptanceCases = runSyntheticChecks(item.kind, checked.files);
      const allPassed = acceptanceCases.every((c) => c.passed);
      const prev = item.changeSet;
      const changed = !prev || prev.digest !== digest;

      item.changeSet = {
        id: prev?.id ?? newId("cs"),
        revision: !prev ? 1 : changed ? prev.revision + 1 : prev.revision,
        baseProfileVersion: opts.rebaseToCurrentProfile
          ? state.profileVersion
          : (prev?.baseProfileVersion ?? state.profileVersion),
        files: checked.files,
        digest,
        requiredCapabilities,
        acceptanceCases,
      };
      item.workStatus = allPassed ? "preview_ready" : "failed";
      item.updatedAt = new Date(now).toISOString();
      await writeState(home, state);
      return item;
    },
    { timeoutMs: 5_000, staleMs: 30_000 },
  );
}

export type ApplyImprovementResult =
  | { ok: true; record: ImprovementRecord; version: CapabilityVersion; alreadyActive: boolean }
  | {
      ok: false;
      error: "not_found" | "not_preview_ready" | "digest_mismatch" | "upstream_conflict";
      message: string;
    };

/**
 * Atomically apply a previewed improvement to `<lisaHome>/improvements/active/<packageId>/`.
 * Enforces digest binding and compare-and-swap against `profileVersion` so
 * concurrent improvements never silently overwrite each other.
 */
export async function applyImprovement(
  id: string,
  expectedDigest: string,
  home: string = lisaHome(),
  now: number = Date.now(),
): Promise<ApplyImprovementResult> {
  return await withFileLock(
    lockFile(home),
    async () => {
      const state = await readState(home);
      const item = state.items.find((i) => i.id === id);
      if (!item) return { ok: false, error: "not_found", message: "Improvement not found." };
      if (item.workStatus !== "preview_ready" || !item.changeSet) {
        return {
          ok: false,
          error: "not_preview_ready",
          message: "Run and pass preview checks before applying this improvement.",
        };
      }
      if (!expectedDigest || expectedDigest !== item.changeSet.digest) {
        return {
          ok: false,
          error: "digest_mismatch",
          message: "ChangeSet changed since preview; review the updated preview digest first.",
        };
      }

      const currentActive = state.activeCapabilities[item.packageId];
      // Idempotent apply for the exact already-active digest.
      if (
        item.activationStatus === "active" &&
        currentActive &&
        currentActive.digest === item.changeSet.digest
      ) {
        return { ok: true, record: item, version: currentActive, alreadyActive: true };
      }

      // Detect concurrent / upstream profile version drift.
      if (item.changeSet.baseProfileVersion !== state.profileVersion) {
        item.activationStatus = "conflict";
        item.history.push({
          at: new Date(now).toISOString(),
          action: "conflict",
          fromVersion: currentActive?.version ?? null,
          toVersion: null,
          digest: item.changeSet.digest,
          note: `Expected profileVersion ${item.changeSet.baseProfileVersion}, found ${state.profileVersion}`,
        });
        item.updatedAt = new Date(now).toISOString();
        await writeState(home, state);
        return {
          ok: false,
          error: "upstream_conflict",
          message:
            "Another capability changed your profile since this ChangeSet was drafted. Re-preview against the current version first.",
        };
      }

      const iso = new Date(now).toISOString();
      const archive = state.versionArchive[item.packageId] ?? [];
      const nextVersionNum = (archive[archive.length - 1]?.version ?? 0) + 1;
      const version: CapabilityVersion = {
        packageId: item.packageId,
        version: nextVersionNum,
        digest: item.changeSet.digest,
        kind: item.kind,
        createdAt: iso,
        permissions: [...item.changeSet.requiredCapabilities],
        files: item.changeSet.files,
      };

      // Materialize immutable version directory and active pointer cleanly inside improvements/.
      const pkgDir = path.join(improvementsDir(home), "active", item.packageId);
      await fsp.rm(pkgDir, { recursive: true, force: true });
      for (const f of version.files) {
        const dest = path.join(pkgDir, f.path);
        await fsp.mkdir(path.dirname(dest), { recursive: true, mode: 0o700 });
        await atomicWrite(dest, f.content);
      }

      state.versionArchive[item.packageId] = [...archive, version];
      state.activeCapabilities[item.packageId] = version;
      state.profileVersion += 1;

      item.previousVersion = currentActive?.version;
      item.activeVersion = nextVersionNum;
      item.activationStatus = "active";
      item.changeSet.baseProfileVersion = state.profileVersion;
      item.history.push({
        at: iso,
        action: "apply",
        fromVersion: currentActive?.version ?? null,
        toVersion: nextVersionNum,
        digest: version.digest,
      });
      item.updatedAt = iso;
      await writeState(home, state);
      return { ok: true, record: item, version, alreadyActive: false };
    },
    { timeoutMs: 5_000, staleMs: 30_000 },
  );
}

/**
 * Roll back an applied improvement without touching normal chat sessions or memory.
 */
export async function rollbackImprovement(
  id: string,
  home: string = lisaHome(),
  now: number = Date.now(),
): Promise<ImprovementRecord> {
  return await withFileLock(
    lockFile(home),
    async () => {
      const state = await readState(home);
      const item = state.items.find((i) => i.id === id);
      if (!item) throw new Error(`Improvement not found: ${id}`);

      const iso = new Date(now).toISOString();
      const archive = state.versionArchive[item.packageId] ?? [];
      const current = state.activeCapabilities[item.packageId];
      const prev =
        item.previousVersion !== undefined
          ? archive.find((v) => v.version === item.previousVersion)
          : undefined;

      const pkgDir = path.join(improvementsDir(home), "active", item.packageId);
      await fsp.rm(pkgDir, { recursive: true, force: true });
      if (prev) {
        for (const f of prev.files) {
          const dest = path.join(pkgDir, f.path);
          await fsp.mkdir(path.dirname(dest), { recursive: true, mode: 0o700 });
          await atomicWrite(dest, f.content);
        }
        state.activeCapabilities[item.packageId] = prev;
      } else {
        delete state.activeCapabilities[item.packageId];
      }

      state.profileVersion += 1;
      item.activationStatus = "rolled_back";
      item.activeVersion = prev?.version;
      item.history.push({
        at: iso,
        action: "rollback",
        fromVersion: current?.version ?? null,
        toVersion: prev?.version ?? null,
        digest: prev?.digest ?? "",
      });
      item.updatedAt = iso;
      await writeState(home, state);
      return item;
    },
    { timeoutMs: 5_000, staleMs: 30_000 },
  );
}

/**
 * Build a de-privatized community contribution export + guided fork/Draft PR prep.
 * Works with or without a connected GitHub account; refuses secret/PII leakage.
 */
export async function exportContribution(
  id: string,
  home: string = lisaHome(),
  now: number = Date.now(),
): Promise<{ record: ImprovementRecord; contribution: ContributionExport }> {
  return await withFileLock(
    lockFile(home),
    async () => {
      const state = await readState(home);
      const item = state.items.find((i) => i.id === id);
      if (!item || !item.changeSet) throw new Error(`Improvement not found: ${id}`);

      const sanitizedFiles: Array<{ path: string; content: string }> = [];
      for (const f of item.changeSet.files) {
        if (
          detectDataClasses(f.content).includes("secret") ||
          /BEGIN\s+(?:RSA|EC|OPENSSH|PGP)\s+PRIVATE KEY/i.test(f.content)
        ) {
          throw new Error(
            `Cannot export "${f.path}": secret-like credential or private key detected.`,
          );
        }
        // Scrub local macOS/Linux user home path prefixes so personal usernames never leak.
        const scrubbed = redactSecrets(
          f.content.replace(/\/(?:Users|home)\/[^/\s"'`]+/g, "/Users/example"),
        );
        sanitizedFiles.push({ path: f.path, content: scrubbed });
      }

      const exportDir = path.join(improvementsDir(home), "exports", item.id);
      await fsp.rm(exportDir, { recursive: true, force: true });
      for (const f of sanitizedFiles) {
        const dest = path.join(exportDir, f.path);
        await fsp.mkdir(path.dirname(dest), { recursive: true, mode: 0o700 });
        await atomicWrite(dest, f.content);
      }

      const exportDigest = sha256(
        JSON.stringify(
          sanitizedFiles
            .map((f) => ({ path: f.path, sha256: sha256(f.content) }))
            .sort((a, b) => a.path.localeCompare(b.path)),
        ),
      );
      const branchName = `lisa/improve-${item.packageId}`;
      const prTitle = `feat(skills): ${item.title}`;
      const prBody = [
        `## Summary`,
        item.goal,
        ``,
        `## Files`,
        ...sanitizedFiles.map((f) => `- \`examples/skills/${item.packageId}/${f.path}\``),
        ``,
        `## Permissions`,
        `- Requested capabilities: ${item.changeSet.requiredCapabilities.join(", ")}`,
        `- Export digest: \`${exportDigest}\``,
        ``,
        `_Prepared locally via Improve LISA (de-privatized export; no personal memory or credentials included)._`,
      ].join("\n");
      const compareUrl = `https://github.com/${UPSTREAM_REPO}/compare/${UPSTREAM_BRANCH}...${encodeURIComponent(branchName)}?expand=1&title=${encodeURIComponent(prTitle)}`;

      const contribution: ContributionExport = {
        exportedAt: new Date(now).toISOString(),
        exportDigest,
        upstreamRepo: UPSTREAM_REPO,
        upstreamBranch: UPSTREAM_BRANCH,
        branchName,
        title: prTitle,
        body: prBody,
        compareUrl,
        files: sanitizedFiles.map((f) => f.path),
      };

      item.contribution = contribution;
      item.contributionStatus = "pr_ready";
      item.updatedAt = new Date(now).toISOString();
      await writeState(home, state);
      return { record: item, contribution };
    },
    { timeoutMs: 5_000, staleMs: 30_000 },
  );
}

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { lisaHome } from "../../paths.js";
import type {
  NewSocialDraft,
  SocialDraft,
  SocialDraftPatch,
} from "./types.js";

interface DraftStore {
  version: 1;
  drafts: SocialDraft[];
}

const STORE_VERSION = 1 as const;
const MAX_DRAFTS = 200;
const DEFAULT_APPROVAL_TTL_MS = 10 * 60_000;
let mutationTail: Promise<void> = Promise.resolve();

function storePath(): string {
  return path.join(lisaHome(), "sense", "social", "drafts.json");
}

async function readStore(): Promise<DraftStore> {
  let raw: string;
  try {
    raw = await fs.readFile(storePath(), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { version: STORE_VERSION, drafts: [] };
    }
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error("social draft store is corrupt; refusing to publish");
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    (parsed as { version?: unknown }).version !== STORE_VERSION ||
    !Array.isArray((parsed as { drafts?: unknown }).drafts)
  ) {
    throw new Error("social draft store has an unsupported shape; refusing to publish");
  }
  return parsed as DraftStore;
}

async function writeStore(store: DraftStore): Promise<void> {
  const file = storePath();
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  try {
    await fs.writeFile(tmp, JSON.stringify(store, null, 2), {
      encoding: "utf8",
      mode: 0o600,
    });
    await fs.rename(tmp, file);
    await fs.chmod(file, 0o600);
  } finally {
    await fs.rm(tmp, { force: true }).catch(() => {});
  }
}

async function mutate<T>(fn: (store: DraftStore) => Promise<T> | T): Promise<T> {
  const previous = mutationTail;
  let release!: () => void;
  mutationTail = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    const store = await readStore();
    const result = await fn(store);
    store.drafts = store.drafts
      .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))
      .slice(-MAX_DRAFTS);
    await writeStore(store);
    return result;
  } finally {
    release();
  }
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function requireDraft(store: DraftStore, id: string): SocialDraft {
  const draft = store.drafts.find((candidate) => candidate.id === id);
  if (!draft) throw new Error(`social draft "${id}" not found`);
  return draft;
}

function hasContent(input: NewSocialDraft["canonical"]): boolean {
  return Boolean(
    input.text?.trim() ||
      input.link?.trim() ||
      input.title?.trim() ||
      input.description?.trim() ||
      input.media.length,
  );
}

function assertDraftInput(input: NewSocialDraft): void {
  if (!Array.isArray(input.targets) || input.targets.length === 0) {
    throw new Error("social draft needs at least one target");
  }
  if (!input.canonical || !Array.isArray(input.canonical.media)) {
    throw new Error("social draft canonical.media must be an array");
  }
  if (!hasContent(input.canonical)) {
    throw new Error("social draft needs text, a link, metadata, or media");
  }
  const targetKeys = input.targets.map(
    (target) => `${target.connectorId}:${target.accountId}`,
  );
  if (new Set(targetKeys).size !== targetKeys.length) {
    throw new Error("social draft targets must be unique");
  }
}

/** Stable JSON for approval hashing. Object keys are recursively sorted. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(obj[key])}`)
    .join(",")}}`;
}

export function socialDraftDigest(draft: SocialDraft): string {
  const snapshot = {
    id: draft.id,
    revision: draft.revision,
    targets: draft.targets,
    canonical: draft.canonical,
    variants: draft.variants,
  };
  return crypto.createHash("sha256").update(canonicalJson(snapshot)).digest("hex");
}

export async function listSocialDrafts(): Promise<SocialDraft[]> {
  return clone((await readStore()).drafts);
}

export async function getSocialDraft(id: string): Promise<SocialDraft | null> {
  const draft = (await readStore()).drafts.find((candidate) => candidate.id === id);
  return draft ? clone(draft) : null;
}

export async function createSocialDraft(
  input: NewSocialDraft,
  now: number = Date.now(),
): Promise<SocialDraft> {
  assertDraftInput(input);
  return mutate((store) => {
    const at = new Date(now).toISOString();
    const draft: SocialDraft = {
      id: crypto.randomUUID(),
      revision: 1,
      state: "draft",
      createdAt: at,
      updatedAt: at,
      targets: clone(input.targets),
      canonical: clone(input.canonical),
      variants: clone(input.variants ?? {}),
      events: [{ at, kind: "created" }],
    };
    store.drafts.push(draft);
    return clone(draft);
  });
}

/**
 * Updating any publish-relevant field invalidates an existing approval and
 * moves the draft back to an unapproved state.
 */
export async function updateSocialDraft(
  id: string,
  expectedRevision: number,
  patch: SocialDraftPatch,
  now: number = Date.now(),
): Promise<SocialDraft> {
  return mutate((store) => {
    const draft = requireDraft(store, id);
    if (draft.revision !== expectedRevision) {
      throw new Error(
        `social draft revision changed (expected ${expectedRevision}, found ${draft.revision})`,
      );
    }
    if (["publishing", "published", "partial"].includes(draft.state)) {
      throw new Error(`social draft in state "${draft.state}" cannot be edited`);
    }
    const next: NewSocialDraft = {
      targets: patch.targets ?? draft.targets,
      canonical: patch.canonical ?? draft.canonical,
      variants: patch.variants ?? draft.variants,
    };
    assertDraftInput(next);
    const at = new Date(now).toISOString();
    draft.targets = clone(next.targets);
    draft.canonical = clone(next.canonical);
    draft.variants = clone(next.variants ?? {});
    draft.revision++;
    draft.state = "draft";
    draft.approval = undefined;
    draft.updatedAt = at;
    draft.events.push({ at, kind: "updated" });
    return clone(draft);
  });
}

export async function requestSocialDraftApproval(
  id: string,
  expectedRevision: number,
  now: number = Date.now(),
): Promise<{ draft: SocialDraft; digest: string }> {
  return mutate((store) => {
    const draft = requireDraft(store, id);
    if (draft.revision !== expectedRevision) {
      throw new Error(
        `social draft revision changed (expected ${expectedRevision}, found ${draft.revision})`,
      );
    }
    if (draft.state !== "draft" && draft.state !== "failed") {
      throw new Error(`social draft in state "${draft.state}" cannot request approval`);
    }
    const at = new Date(now).toISOString();
    draft.state = "awaiting-approval";
    draft.approval = undefined;
    draft.updatedAt = at;
    const digest = socialDraftDigest(draft);
    draft.events.push({
      at,
      kind: "approval-requested",
      detail: digest.slice(0, 12),
    });
    return { draft: clone(draft), digest };
  });
}

export async function approveSocialDraft(
  id: string,
  expectedDigest: string,
  now: number = Date.now(),
  ttlMs: number = DEFAULT_APPROVAL_TTL_MS,
): Promise<SocialDraft> {
  return mutate((store) => {
    const draft = requireDraft(store, id);
    if (draft.state !== "awaiting-approval") {
      throw new Error(`social draft in state "${draft.state}" cannot be approved`);
    }
    const actual = socialDraftDigest(draft);
    const expectedBuffer = Buffer.from(expectedDigest, "utf8");
    const actualBuffer = Buffer.from(actual, "utf8");
    if (
      expectedBuffer.length !== actualBuffer.length ||
      !crypto.timingSafeEqual(expectedBuffer, actualBuffer)
    ) {
      throw new Error("social draft changed after preview; approval rejected");
    }
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
      throw new Error("social draft approval TTL must be positive");
    }
    const at = new Date(now).toISOString();
    draft.state = "approved";
    draft.approval = {
      digest: actual,
      approvedAt: at,
      expiresAt: new Date(now + ttlMs).toISOString(),
      approvedBy: "local-user",
    };
    draft.updatedAt = at;
    draft.events.push({ at, kind: "approved", detail: actual.slice(0, 12) });
    return clone(draft);
  });
}

/**
 * Atomically consume an approval before invoking any connector. A claim is
 * one-shot: retries reconcile receipts rather than claiming/publishing again.
 */
export async function claimApprovedSocialDraft(
  id: string,
  expectedDigest: string,
  now: number = Date.now(),
): Promise<SocialDraft> {
  const result = await mutate((store) => {
    const draft = requireDraft(store, id);
    if (draft.state !== "approved" || !draft.approval) {
      throw new Error(`social draft in state "${draft.state}" is not publishable`);
    }
    if (Date.parse(draft.approval.expiresAt) <= now) {
      draft.state = "expired";
      draft.updatedAt = new Date(now).toISOString();
      draft.events.push({ at: draft.updatedAt, kind: "outcome", detail: "approval-expired" });
      return { expired: true as const };
    }
    const actual = socialDraftDigest(draft);
    if (actual !== expectedDigest || draft.approval.digest !== expectedDigest) {
      throw new Error("social draft changed after approval; publish rejected");
    }
    const at = new Date(now).toISOString();
    draft.state = "publishing";
    draft.approval.claimedAt = at;
    draft.updatedAt = at;
    draft.events.push({ at, kind: "claimed", detail: actual.slice(0, 12) });
    return { expired: false as const, draft: clone(draft) };
  });
  if (result.expired) throw new Error("social draft approval expired");
  return result.draft;
}

export async function cancelSocialDraft(
  id: string,
  now: number = Date.now(),
): Promise<SocialDraft> {
  return mutate((store) => {
    const draft = requireDraft(store, id);
    if (["publishing", "published", "partial"].includes(draft.state)) {
      throw new Error(`social draft in state "${draft.state}" cannot be cancelled`);
    }
    const at = new Date(now).toISOString();
    draft.state = "cancelled";
    draft.approval = undefined;
    draft.updatedAt = at;
    draft.events.push({ at, kind: "cancelled" });
    return clone(draft);
  });
}

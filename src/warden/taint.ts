/**
 * Which conversations have read untrusted content — persisted.
 *
 * Taint belongs to the conversation, not the process: the fetched page is
 * still in the history after a restart. So the ids of tainted conversations
 * are kept at `<home>/warden/tainted.json` (ids only, bounded, atomic).
 *
 * Fail closed: if the file cannot be trusted, every conversation that already
 * has history is treated as tainted.
 */
import path from "node:path";
import { withFileLock } from "../soul/lock.js";
import { logWarn } from "../log.js";
import { readJsonState, wardenDir, writeJsonAtomic } from "./store.js";

const TAINT_VERSION = 1;
export const MAX_TAINTED_CONVERSATIONS = 5000;
const MAX_ID_LENGTH = 200;

interface TaintFile {
  version: typeof TAINT_VERSION;
  ids: string[];
}

function taintFile(home?: string): string {
  return path.join(wardenDir(home), "tainted.json");
}

function parseTaintFile(value: unknown): TaintFile | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const doc = value as Record<string, unknown>;
  if (doc.version !== TAINT_VERSION || !Array.isArray(doc.ids)) return null;
  if (doc.ids.length > MAX_TAINTED_CONVERSATIONS * 2) return null;
  for (const id of doc.ids) {
    if (typeof id !== "string" || id.length === 0 || id.length > MAX_ID_LENGTH) return null;
  }
  return { version: TAINT_VERSION, ids: doc.ids as string[] };
}

export interface TaintState {
  ids: ReadonlySet<string>;
  /** The file existed but could not be trusted. */
  corrupt: boolean;
}

export async function loadTaintState(home?: string): Promise<TaintState> {
  const read = await readJsonState(taintFile(home), parseTaintFile);
  if (read.state === "ok") return { ids: new Set(read.value.ids), corrupt: false };
  if (read.state === "corrupt") {
    logWarn(`[warden] tainted.json is corrupt (${read.error}); treating conversations as tainted`);
    return { ids: new Set(), corrupt: true };
  }
  return { ids: new Set(), corrupt: false };
}

/**
 * Is this conversation tainted? `hasHistory` decides the fail-closed case: with
 * an unreadable file, a conversation that already has turns may have read
 * anything.
 */
export async function isConversationTainted(
  conversationId: string,
  opts: { home?: string; hasHistory: boolean },
): Promise<boolean> {
  let state: TaintState;
  try {
    state = await loadTaintState(opts.home);
  } catch (err) {
    logWarn(`[warden] tainted.json unreadable (${(err as Error).message})`);
    return opts.hasHistory;
  }
  if (state.corrupt) return opts.hasHistory;
  return state.ids.has(conversationId);
}

/** Record a conversation as tainted. Idempotent; the oldest ids are dropped past the cap. */
export async function markConversationTainted(
  conversationId: string,
  home?: string,
): Promise<void> {
  if (!conversationId || conversationId.length > MAX_ID_LENGTH) return;
  const file = taintFile(home);
  await withFileLock(`${file}.lock`, async () => {
    const read = await readJsonState(file, parseTaintFile);
    // A corrupt file is left alone. It already means "every conversation with
    // history is tainted"; overwriting it with one id would quietly un-taint
    // all the others.
    if (read.state === "corrupt") return;
    const ids = read.state === "ok" ? read.value.ids.filter((id) => id !== conversationId) : [];
    ids.push(conversationId);
    await writeJsonAtomic(file, {
      version: TAINT_VERSION,
      ids: ids.slice(Math.max(0, ids.length - MAX_TAINTED_CONVERSATIONS)),
    } satisfies TaintFile);
  });
}

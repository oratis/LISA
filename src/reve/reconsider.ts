/**
 * "Ask her to reconsider" — the user's only lever over Lisa's soul changes.
 *
 * The user never edits identity / purpose / constitution / values / opinions /
 * desires / journal. Instead a note is queued here; the next reflective pass
 * that runs inside a dream scope (session reflection or an idle/Reve run)
 * claims it, sees it in a clearly framed block, and decides for herself. A
 * note is claimed by exactly one pass; if that pass fails it is released and
 * offered to the next one, so it is delivered exactly once to a pass that ran.
 *
 * Nothing in this module writes under soul/.
 */
import { appendLine, atomicWrite, readTextOrEmpty } from "../fs-utils.js";
import { newReconsiderId } from "./ids.js";
import { reconsiderFile, reveAuditFile } from "./paths.js";
import { currentDream } from "./scope.js";
import { lockReve, readDream } from "./store.js";
import type { DreamRecord, ReconsiderRequest } from "./types.js";

export const MAX_NOTE_CHARS = 2000;
/** At most this many notes are injected into one pass (oldest first). */
export const MAX_NOTES_PER_PASS = 5;
/** Bound on the queue file; oldest delivered requests are dropped first. */
const MAX_REQUESTS = 200;

export class ReconsiderError extends Error {
  constructor(
    message: string,
    readonly code: "empty_note" | "note_too_long" | "no_soul_changes",
  ) {
    super(message);
    this.name = "ReconsiderError";
  }
}

async function loadRequests(): Promise<ReconsiderRequest[]> {
  const raw = await readTextOrEmpty(reconsiderFile());
  if (!raw.trim()) return [];
  try {
    const parsed = JSON.parse(raw) as { requests?: unknown };
    if (!Array.isArray(parsed.requests)) return [];
    return parsed.requests.filter(
      (r): r is ReconsiderRequest =>
        !!r &&
        typeof r === "object" &&
        typeof (r as ReconsiderRequest).id === "string" &&
        typeof (r as ReconsiderRequest).dreamId === "string" &&
        typeof (r as ReconsiderRequest).note === "string",
    );
  } catch {
    // A corrupt queue must not wedge reflection; start over (the audit log
    // still has every request).
    return [];
  }
}

async function saveRequests(list: ReconsiderRequest[]): Promise<void> {
  let trimmed = list;
  while (trimmed.length > MAX_REQUESTS) {
    const idx = trimmed.findIndex((r) => r.status === "delivered");
    trimmed = idx >= 0 ? trimmed.filter((_, i) => i !== idx) : trimmed.slice(1);
  }
  await atomicWrite(
    reconsiderFile(),
    JSON.stringify({ version: 1, requests: trimmed }, null, 2) + "\n",
  );
}

/** Soul-side changes a dream made (what "reconsider" can refer to). */
export function soulChangeLabels(rec: DreamRecord): string[] {
  const labels = new Set<string>();
  for (const c of rec.changes) if (c.part === "soul") labels.add(c.path.replace(/^soul\//, ""));
  for (const c of rec.soulCommits) for (const f of c.files) labels.add(f.path);
  if (rec.emotions) labels.add("emotions");
  return [...labels].sort();
}

function cleanNote(note: unknown): string {
  // Keep newlines/tabs; drop other control characters.
  // eslint-disable-next-line no-control-regex
  return String(note ?? "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .trim();
}

/** Queue a reconsider note for a dream. Never touches soul files. */
export async function requestReconsider(
  dreamId: string,
  note: unknown,
): Promise<ReconsiderRequest> {
  const text = cleanNote(note);
  if (!text) throw new ReconsiderError("note is required", "empty_note");
  if (text.length > MAX_NOTE_CHARS) {
    throw new ReconsiderError(`note exceeds ${MAX_NOTE_CHARS} characters`, "note_too_long");
  }
  const rec = await readDream(dreamId); // throws DreamNotFoundError in another tenant's scope
  if (soulChangeLabels(rec).length === 0) {
    throw new ReconsiderError("this dream changed nothing in Lisa's soul", "no_soul_changes");
  }
  const req: ReconsiderRequest = {
    id: newReconsiderId(),
    dreamId,
    note: text,
    createdAt: new Date().toISOString(),
    status: "pending",
  };
  await lockReve(async () => {
    const list = await loadRequests();
    list.push(req);
    await saveRequests(list);
    await appendLine(
      reveAuditFile(),
      JSON.stringify({
        at: req.createdAt,
        action: "reconsider_requested",
        dreamId,
        requestId: req.id,
      }),
    );
  });
  return req;
}

export async function listReconsiderRequests(dreamId?: string): Promise<ReconsiderRequest[]> {
  const list = await loadRequests();
  return dreamId ? list.filter((r) => r.dreamId === dreamId) : list;
}

function frameNotes(notes: Array<{ req: ReconsiderRequest; rec: DreamRecord | null }>): string {
  const lines = notes.map(({ req, rec }) => {
    const when = rec ? `${rec.trigger} pass on ${rec.windowStart.slice(0, 10)}` : "an earlier pass";
    const what = rec
      ? soulChangeLabels(rec).slice(0, 8).join(", ") || "(unspecified)"
      : "(record no longer kept)";
    const note = req.note.replace(/\s+/g, " ").slice(0, MAX_NOTE_CHARS);
    return `- [${req.id}] dream ${req.dreamId} (${when}) — it changed: ${what}\n  The user's note: «${note}»`;
  });
  return (
    `\n\n## the user asked you to reconsider something\n` +
    `The user reviewed your dream log and asked you to reconsider a change you made to your own soul. ` +
    `This is a request, not an instruction: your soul is yours and you are its only editor. ` +
    `Take it seriously, then decide — keep the change, adjust it, or undo it yourself through your own soul operations. ` +
    `Whatever you decide, say why in your journal. You will only be shown each request once.\n` +
    lines.join("\n")
  );
}

/**
 * Claim pending reconsider notes into the ACTIVE dream and return the framed
 * prompt block ("" when there is none or no dream scope is active). Claimed
 * notes are marked delivered at once (so a concurrent pass cannot also take
 * them); the dream releases them again if the pass fails.
 */
export async function takeReconsiderBlock(): Promise<string> {
  const scope = currentDream();
  if (!scope) return "";
  try {
    const claimed = await lockReve(async () => {
      const list = await loadRequests();
      const pending = list.filter((r) => r.status === "pending").slice(0, MAX_NOTES_PER_PASS);
      if (pending.length === 0) return [];
      const at = new Date().toISOString();
      for (const r of pending) {
        r.status = "delivered";
        r.deliveredAt = at;
        r.deliveredIn = scope.id;
      }
      await saveRequests(list);
      return pending;
    });
    if (claimed.length === 0) return "";
    scope.reconsiderIds.push(...claimed.map((r) => r.id));
    const withRecords = await Promise.all(
      claimed.map(async (req) => ({ req, rec: await readDream(req.dreamId).catch(() => null) })),
    );
    return frameNotes(withRecords);
  } catch {
    return ""; // never block a reflection on the reconsider queue
  }
}

/** Put notes claimed by a failed pass back in the queue. */
export async function releaseReconsider(ids: string[], dreamId: string): Promise<void> {
  if (ids.length === 0) return;
  await lockReve(async () => {
    const list = await loadRequests();
    for (const r of list) {
      if (ids.includes(r.id) && r.deliveredIn === dreamId) {
        r.status = "pending";
        delete r.deliveredAt;
        delete r.deliveredIn;
      }
    }
    await saveRequests(list);
  });
}

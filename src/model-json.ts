/**
 * Getting the JSON object out of a model reply that was asked for "only JSON".
 *
 * Models mostly comply and sometimes do not: the object arrives after a line
 * of preamble ("好的，以下是反思结果："), inside a code fence, or followed by a
 * closing remark. Those replies contain exactly the object that was asked for;
 * `JSON.parse` on the whole text rejects all of them, and the caller then pays
 * for a retry — or, after the retry, records the pass as unparseable.
 *
 * This reads the reply the way a person would: the first complete JSON object
 * in the text that the caller accepts. It never repairs JSON. A reply whose
 * object is cut off or malformed still yields nothing, and the caller's retry
 * and error paths stay as they are.
 */

/** The index just past the object that opens at `start`, or -1 if it never closes. */
function objectEnd(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === "\\") i++;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) return i + 1;
  }
  return -1;
}

/** Enough to get past any preamble; bounds the work on text that is all braces. */
const MAX_CANDIDATES = 64;

/**
 * The first JSON object in `text` that parses and that `accept` takes, or
 * undefined. Arrays and scalars are not objects. Candidates are tried in the
 * order they open, so a complete outer object wins over anything nested in it.
 *
 * Pass `accept`. When the outer object is cut off, the objects nested in it
 * are still complete, and without a check on shape the first of them would be
 * returned as if it were the reply.
 */
export function extractJsonObject(
  text: string,
  accept: (value: Record<string, unknown>) => boolean = () => true,
): Record<string, unknown> | undefined {
  let tried = 0;
  for (let at = text.indexOf("{"); at !== -1 && tried < MAX_CANDIDATES; tried++) {
    const end = objectEnd(text, at);
    // An opening brace that never closes (prose, a cut-off object) is skipped;
    // a later brace may still open a complete object.
    if (end !== -1) {
      try {
        const value: unknown = JSON.parse(text.slice(at, end));
        if (typeof value === "object" && value !== null && !Array.isArray(value)) {
          const object = value as Record<string, unknown>;
          if (accept(object)) return object;
        }
      } catch {
        // Not JSON (prose in braces, a template placeholder): try the next one.
      }
    }
    at = text.indexOf("{", at + 1);
  }
  return undefined;
}

/**
 * The JSON object in `text` that `accept` takes, but only when there is
 * exactly ONE such top-level object; otherwise undefined.
 *
 * For replies built from untrusted material. A reflection reads conversation
 * text, which can contain a fetched page; if the reply quotes an object of the
 * right shape before its own, "the first one" would be the attacker's. Two
 * candidates mean the reply is ambiguous, and the caller retries. Objects
 * nested inside an accepted one are part of it and are not counted.
 */
export function extractOnlyJsonObject(
  text: string,
  accept: (value: Record<string, unknown>) => boolean,
): Record<string, unknown> | undefined {
  let found: Record<string, unknown> | undefined;
  let tried = 0;
  for (let at = text.indexOf("{"); at !== -1 && tried < MAX_CANDIDATES; tried++) {
    const end = objectEnd(text, at);
    let next = at + 1;
    if (end !== -1) {
      try {
        const value: unknown = JSON.parse(text.slice(at, end));
        if (typeof value === "object" && value !== null && !Array.isArray(value)) {
          const object = value as Record<string, unknown>;
          if (accept(object)) {
            if (found) return undefined;
            found = object;
            next = end; // what is inside it belongs to it
          }
        }
      } catch {
        // Not JSON: try the next brace.
      }
    }
    at = text.indexOf("{", next);
  }
  return found;
}

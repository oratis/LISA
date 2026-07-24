/**
 * Map a raw IMAP connect/probe failure to a plain-language hint for the
 * connect-mailbox UI.
 *
 * Kept as its own pure module so it is unit-testable without importing the web
 * server: the shape of an imapflow auth rejection is subtle enough that it
 * needs a pinned regression test (see connect-error.test.ts).
 */

/** The parts of an imapflow error we key on. All optional — errors vary. */
interface ImapErrorish {
  message?: unknown;
  /** Server text, e.g. "Invalid credentials (Failure)". */
  responseText?: unknown;
  /** e.g. "AUTHENTICATIONFAILED". */
  serverResponseCode?: unknown;
  /** imapflow sets this outright on an auth rejection. */
  authenticationFailed?: unknown;
  /** Node syscall errors, e.g. "ENOTFOUND". */
  code?: unknown;
}

/**
 * The single biggest cause of a failed connect is pasting a login password
 * where an app-password / authorization code is required, so lead with that.
 */
export function friendlyMailError(err: unknown, email: string, host: string): string {
  // imapflow reports an auth rejection as a bare `message: "Command failed"` —
  // the actual signal lives on the error object (authenticationFailed +
  // serverResponseCode "AUTHENTICATIONFAILED" + responseText "Invalid
  // credentials (Failure)"). Match on all of it, not just `message`, or the
  // most common failure of all falls through to the useless generic branch.
  const e = (err ?? {}) as ImapErrorish;
  const raw = err instanceof Error ? err.message : String(err);
  const serverText = typeof e.responseText === "string" && e.responseText ? e.responseText : "";
  const m = [raw, serverText, e.serverResponseCode, e.code]
    .filter((t): t is string => typeof t === "string")
    .join(" ")
    .toLowerCase();
  const isGmail = /(^|@)(gmail\.com|googlemail\.com)$/.test(email.toLowerCase()) || host === "imap.gmail.com";
  const authHint = isGmail
    ? "Gmail rejected the sign-in. Use a 16-character app password (not your Google login password), and make sure 2-Step Verification is on."
    : "Authentication failed. Use an app-password / authorization code from your mail provider — not your login password.";

  // 1. Signals the server states outright. Definitive — check these first.
  if (e.authenticationFailed === true) return authHint;
  if (String(e.serverResponseCode ?? "").toUpperCase() === "AUTHENTICATIONFAILED") return authHint;

  // 2. Transport failures. These carry precise syscall codes, and must be
  //    checked BEFORE the loose auth text heuristic below: a DNS error embeds
  //    the hostname ("getaddrinfo ENOTFOUND imap.nope.invalid"), so a host
  //    containing a word like "invalid" would otherwise be misread as a
  //    credentials problem and send the user chasing the wrong fix.
  if (/enotfound|eai_again|getaddrinfo|no such host|dns/.test(m)) {
    return "Could not find the mail server. Check the IMAP host.";
  }
  if (/timed out|timeout|etimedout|econn|network|socket|refused/.test(m)) {
    return "Could not reach the mail server (network or timeout). Check your connection and the IMAP host.";
  }

  // 3. Text heuristic, for servers that set no structured auth flag. Note
  //    "credential" already covers "Invalid credentials", so no bare "invalid".
  if (/auth|credential|denied|not accepted|username|password|login/.test(m)) {
    return authHint;
  }
  // Prefer the server's own words over imapflow's opaque "Command failed".
  return "Could not connect: " + (serverText || raw).slice(0, 160);
}

/**
 * Disposable-email blocklist (S3) — cheap spam-farm friction on signup.
 *
 * Every account mints a free usage window, so throwaway addresses are the
 * obvious farming vector. This is deliberately a SHORT static list of the
 * high-volume disposable providers, not an arms race: Turnstile and the
 * per-IP signup cap carry the real load, this just removes the laziest tier.
 * `LISA_EMAIL_BLOCKLIST` (comma-separated domains) extends it at deploy time
 * without a code change.
 */

const DISPOSABLE_DOMAINS = new Set([
  "10minutemail.com",
  "10minutemail.net",
  "20minutemail.com",
  "33mail.com",
  "anonaddy.me",
  "burnermail.io",
  "byom.de",
  "dispostable.com",
  "emailondeck.com",
  "fakeinbox.com",
  "getairmail.com",
  "getnada.com",
  "guerrillamail.com",
  "guerrillamail.de",
  "guerrillamail.net",
  "guerrillamail.org",
  "inboxkitten.com",
  "mail-temp.com",
  "mail.tm",
  "mailcatch.com",
  "maildrop.cc",
  "mailinator.com",
  "mailnesia.com",
  "mailsac.com",
  "mintemail.com",
  "mohmal.com",
  "mytemp.email",
  "sharklasers.com",
  "spamgourmet.com",
  "temp-mail.io",
  "temp-mail.org",
  "tempail.com",
  "tempmail.dev",
  "tempmail.plus",
  "tempmailo.com",
  "tempr.email",
  "throwawaymail.com",
  "trash-mail.com",
  "trashmail.com",
  "yopmail.com",
  "yopmail.fr",
  "yopmail.net",
]);

/** Parse the env extension once per call — the list is tiny. */
function extraBlocked(env: NodeJS.ProcessEnv = process.env): string[] {
  return (env.LISA_EMAIL_BLOCKLIST ?? "")
    .split(",")
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean);
}

/** True when the address's domain is a known disposable-mail provider. */
export function isDisposableEmail(email: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const at = email.lastIndexOf("@");
  if (at < 0) return false;
  const domain = email.slice(at + 1).trim().toLowerCase();
  if (!domain) return false;
  return DISPOSABLE_DOMAINS.has(domain) || extraBlocked(env).includes(domain);
}

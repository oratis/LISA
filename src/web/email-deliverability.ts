/**
 * Pre-send address check (docs/PLAN_AUTH_OTP_GOOGLE_v1.0.md A6).
 *
 * Sign-in by code has a failure mode that regular sign-in doesn't: a typo'd
 * address doesn't bounce back to the person who typed it. They wait for a code
 * that went somewhere else, burn a slot of their daily send budget, and have no
 * way to tell a bad address from a slow one. So we look *before* we send.
 *
 * Two stages, cheapest first:
 *
 *  1. **Deterministic typo lists** — no I/O, catches the overwhelming majority
 *     (`gmial.com`, `.con`). These can suggest a correction, which is the whole
 *     point: "did you mean gmail.com?" fixes the problem in one tap.
 *  2. **MX lookup**, raced against a short timeout, with an A-record fallback
 *     (a domain with no MX but an A record still accepts mail, per RFC 5321).
 *
 * **It fails OPEN on every uncertainty.** A DNS hiccup, a timeout, a resolver
 * that doesn't like us — all of those admit the address. The only rejection is
 * a definitive "this domain does not exist" (ENOTFOUND/ENODATA on *both*
 * lookups) or a typo we can name. Getting this backwards would lock people out
 * of their own accounts because a resolver blinked, which is far worse than
 * sending one mail into the void.
 *
 * Deliberately NOT an account-existence oracle: everything here is about the
 * domain, never about whether we know the address.
 */
import dns from "node:dns/promises";

export type DeliverabilityVerdict =
  | { ok: true }
  | { ok: false; reason: "typo" | "no_such_domain"; suggestion?: string };

/** Mistyped TLDs. Each maps to what was almost certainly meant. */
const TLD_TYPOS: Record<string, string> = {
  con: "com",
  comm: "com",
  cmo: "com",
  ocm: "com",
  vom: "com",
  xom: "com",
  cim: "com",
  "co,": "com",
  nte: "net",
  ner: "net",
  orgg: "org",
};

/**
 * Mistyped popular domains. Only entries that cannot be a real domain someone
 * actually uses — when in doubt, leave it out and let DNS decide.
 */
const DOMAIN_TYPOS: Record<string, string> = {
  "gmial.com": "gmail.com",
  "gmai.com": "gmail.com",
  "gmali.com": "gmail.com",
  "gamil.com": "gmail.com",
  "gnail.com": "gmail.com",
  "gmail.co": "gmail.com",
  "gmaill.com": "gmail.com",
  "hotmial.com": "hotmail.com",
  "hotmai.com": "hotmail.com",
  "hotmal.com": "hotmail.com",
  "outlok.com": "outlook.com",
  "outloo.com": "outlook.com",
  "yahooo.com": "yahoo.com",
  "yaho.com": "yahoo.com",
  "iclod.com": "icloud.com",
  "icloud.co": "icloud.com",
  "qq.co": "qq.com",
  "163.co": "163.com",
  "126.co": "126.com",
};

function domainOf(email: string): string {
  return email.slice(email.lastIndexOf("@") + 1).toLowerCase();
}

/**
 * Typo check only — pure, no I/O. Exported because it's the half worth running
 * anywhere (including a client) and the half that can suggest a fix.
 */
export function findTypo(email: string): { suggestion: string } | null {
  const domain = domainOf(email);
  if (!domain) return null;

  const fixed = DOMAIN_TYPOS[domain];
  if (fixed) return { suggestion: fixed };

  const dot = domain.lastIndexOf(".");
  if (dot > 0) {
    const tld = domain.slice(dot + 1);
    const fixedTld = TLD_TYPOS[tld];
    // Guard: ".co" is a real ccTLD (and ".ne"/".or" exist too), so only the
    // entries above are treated as mistakes — never a bare prefix match.
    if (fixedTld) return { suggestion: `${domain.slice(0, dot)}.${fixedTld}` };
  }
  return null;
}

export interface DeliverabilityOpts {
  /** Milliseconds to wait for DNS before admitting the address. */
  timeoutMs?: number;
  /** Injected for tests. */
  resolveMx?: (host: string) => Promise<unknown[]>;
  resolve4?: (host: string) => Promise<unknown[]>;
}

/** Definitive "no such name" — anything else is a reason to fail open. */
function isNoSuchDomain(e: unknown): boolean {
  const code = (e as { code?: string })?.code;
  return code === "ENOTFOUND" || code === "ENODATA";
}

/**
 * Can mail plausibly reach this address? See the module header for why this
 * fails open on everything except a named typo and a definitively dead domain.
 */
export async function checkDeliverable(
  email: string,
  opts: DeliverabilityOpts = {},
): Promise<DeliverabilityVerdict> {
  const typo = findTypo(email);
  if (typo) return { ok: false, reason: "typo", suggestion: typo.suggestion };

  const domain = domainOf(email);
  if (!domain) return { ok: true }; // shape is validated elsewhere

  const timeoutMs = opts.timeoutMs ?? 3000;
  const resolveMx = opts.resolveMx ?? ((h: string) => dns.resolveMx(h));
  const resolve4 = opts.resolve4 ?? ((h: string) => dns.resolve4(h));

  // A slow resolver must not hold up a sign-in: whoever wins, we move on.
  const admit = Symbol("timeout");
  const timer = new Promise<typeof admit>((r) => setTimeout(() => r(admit), timeoutMs).unref?.());

  try {
    const lookup = (async (): Promise<DeliverabilityVerdict> => {
      try {
        const mx = await resolveMx(domain);
        if (mx.length > 0) return { ok: true };
      } catch (e) {
        if (!isNoSuchDomain(e)) return { ok: true }; // resolver trouble ⇒ admit
      }
      // No MX: RFC 5321 says fall back to the A record before giving up.
      try {
        const a = await resolve4(domain);
        return a.length > 0 ? { ok: true } : { ok: false, reason: "no_such_domain" };
      } catch (e) {
        return isNoSuchDomain(e) ? { ok: false, reason: "no_such_domain" } : { ok: true };
      }
    })();

    const winner = await Promise.race([lookup, timer]);
    return winner === admit ? { ok: true } : (winner as DeliverabilityVerdict);
  } catch {
    return { ok: true }; // never let this path be the reason a sign-in fails
  }
}

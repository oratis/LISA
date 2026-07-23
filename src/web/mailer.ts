/**
 * Outbound mail — account verification and sign-in codes
 * (docs/PLAN_ACCOUNTS_BILLING_v1.0.md B8a; docs/PLAN_AUTH_OTP_GOOGLE_v1.0.md A1).
 *
 * One provider, two messages, both over Resend's REST API (zero deps): the
 * verification link that levels an email account's free window from $1 to $5,
 * and the one-time code that signs a person in without a password.
 * Without RESEND_API_KEY the mailer degrades loudly-but-safely: the link or code
 * is printed to the server log so an operator can forward it by hand (and dev
 * setups keep working offline). **Sign-in by code therefore needs a real key in
 * production** — a code nobody receives is a sign-in nobody completes.
 *
 * Env: RESEND_API_KEY, LISA_MAIL_FROM (default "LISA <no-reply@meetlisa.ai>";
 * the domain must be verified in Resend before real sends succeed).
 */

export interface MailResult {
  sent: boolean;
  /** Provider id or the reason it wasn't sent. */
  detail: string;
}

export interface MailerConfig {
  apiKey: string | null;
  from: string;
}

export function mailerConfig(env: Record<string, string | undefined> = process.env): MailerConfig {
  return {
    apiKey: env.RESEND_API_KEY?.trim() || null,
    from: env.LISA_MAIL_FROM?.trim() || "LISA <no-reply@meetlisa.ai>",
  };
}

/** Compose the verification mail (pure — unit-testable). */
export function verificationEmail(link: string): { subject: string; text: string } {
  return {
    subject: "Verify your LISA account email",
    text:
      `Confirm this email address for your LISA account by opening the link below:\n\n` +
      `${link}\n\n` +
      `Verifying raises your free session allowance to the full amount. The link ` +
      `expires in 24 hours. If you didn't create a LISA account, ignore this mail.`,
  };
}

/** Compose the sign-in code mail (pure — unit-testable). */
export function signInCodeEmail(code: string, ttlMinutes: number): { subject: string; text: string } {
  return {
    subject: `${code} is your LISA sign-in code`,
    text:
      `Your LISA sign-in code is:\n\n` +
      `    ${code}\n\n` +
      `Enter it in the app or on the sign-in page. It expires in ${ttlMinutes} minutes ` +
      `and can be used once.\n\n` +
      `If you didn't try to sign in, ignore this mail — nobody can use the code ` +
      `without reading this inbox.`,
  };
}

/**
 * Mail the one-time sign-in code. Same degradation as the verification link:
 * with no API key the code goes to the server log (dev/offline), which is why
 * a production deployment must have RESEND_API_KEY set.
 */
export async function sendSignInCodeEmail(
  to: string,
  code: string,
  ttlMinutes: number,
  cfg: MailerConfig = mailerConfig(),
  fetchFn: typeof fetch = fetch,
): Promise<MailResult> {
  return deliver(to, signInCodeEmail(code, ttlMinutes), `sign-in code for ${to}: ${code}`, cfg, fetchFn);
}

export async function sendVerificationEmail(
  to: string,
  link: string,
  cfg: MailerConfig = mailerConfig(),
  fetchFn: typeof fetch = fetch,
): Promise<MailResult> {
  return deliver(to, verificationEmail(link), `verification link for ${to}: ${link}`, cfg, fetchFn);
}

async function deliver(
  to: string,
  mail: { subject: string; text: string },
  fallbackLog: string,
  cfg: MailerConfig,
  fetchFn: typeof fetch,
): Promise<MailResult> {
  if (!cfg.apiKey) {
    console.error(`[mail] RESEND_API_KEY unset — ${fallbackLog}`);
    return { sent: false, detail: "no_api_key" };
  }
  try {
    const res = await fetchFn("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        authorization: `Bearer ${cfg.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ from: cfg.from, to: [to], subject: mail.subject, text: mail.text }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.error(`[mail] resend rejected (${res.status}): ${body.slice(0, 200)}`);
      return { sent: false, detail: `http_${res.status}` };
    }
    const parsed = (await res.json().catch(() => ({}))) as { id?: string };
    return { sent: true, detail: parsed.id ?? "sent" };
  } catch (e) {
    console.error(`[mail] send failed: ${(e as Error).message}`);
    return { sent: false, detail: "network_error" };
  }
}

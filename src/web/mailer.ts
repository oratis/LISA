/**
 * Outbound mail — email-ownership verification for LISA accounts
 * (docs/PLAN_ACCOUNTS_BILLING_v1.0.md B7 follow-up, milestone B8a).
 *
 * One provider, one purpose: Resend's REST API (zero deps) sends the
 * verification link that levels an email account's free window from $1 to $5.
 * Without RESEND_API_KEY the mailer degrades loudly-but-safely: the link is
 * printed to the server log so an operator can forward it by hand (and dev
 * setups keep working offline).
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

export async function sendVerificationEmail(
  to: string,
  link: string,
  cfg: MailerConfig = mailerConfig(),
  fetchFn: typeof fetch = fetch,
): Promise<MailResult> {
  const mail = verificationEmail(link);
  if (!cfg.apiKey) {
    console.error(`[mail] RESEND_API_KEY unset — verification link for ${to}: ${link}`);
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

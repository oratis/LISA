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

export interface ComposedMail {
  subject: string;
  text: string;
}

/**
 * Compose the verification mail (pure — unit-testable). With a `code` (S2) the
 * 6-digit code leads and the link stays as the fallback for mail clients where
 * typing a code beats tapping a link that an in-app browser may hijack.
 */
export function verificationEmail(link: string, code?: string): ComposedMail {
  const codePart = code
    ? `Your verification code is: ${code}\n\n` +
      `Enter it in LISA, or open the link below instead:\n\n`
    : `Confirm this email address for your LISA account by opening the link below:\n\n`;
  return {
    subject: code ? `${code} is your LISA verification code` : "Verify your LISA account email",
    text:
      codePart +
      `${link}\n\n` +
      `Verifying raises your free session allowance to the full amount. ` +
      `${code ? "The code expires in 10 minutes; the link" : "The link"} ` +
      `expires in 24 hours. If you didn't create a LISA account, ignore this mail.`,
  };
}

/** Compose a sign-in / password-reset code mail (S2; pure). */
export function otpEmail(code: string, purpose: "login" | "reset"): ComposedMail {
  const what = purpose === "login" ? "sign-in" : "password reset";
  return {
    subject: `${code} is your LISA ${what} code`,
    text:
      `Your LISA ${what} code is: ${code}\n\n` +
      `It expires in 10 minutes. If you didn't request it, ignore this mail — ` +
      `nothing happens without the code.`,
  };
}

/** Send any composed mail through Resend; degrades to a loud server log without a key. */
export async function sendMail(
  to: string,
  mail: ComposedMail,
  cfg: MailerConfig = mailerConfig(),
  fetchFn: typeof fetch = fetch,
): Promise<MailResult> {
  if (!cfg.apiKey) {
    // The operator can hand-forward the secret; flatten so one log line has it.
    console.error(`[mail] RESEND_API_KEY unset — for ${to}: ${mail.text.replace(/\n+/g, " | ").slice(0, 300)}`);
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

/** Back-compat wrapper: verification mail without a code. */
export async function sendVerificationEmail(
  to: string,
  link: string,
  cfg: MailerConfig = mailerConfig(),
  fetchFn: typeof fetch = fetch,
): Promise<MailResult> {
  return sendMail(to, verificationEmail(link), cfg, fetchFn);
}

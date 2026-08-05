/**
 * Outbound mail — account verification and sign-in codes
 * (docs/PLAN_ACCOUNTS_BILLING_v1.0.md B8a; docs/PLAN_AUTH_OTP_GOOGLE_v1.0.md A1/A6).
 *
 * One provider (Resend's REST API, zero deps), one choke point, two messages:
 * the verification link that levels an email account's free window from $1 to
 * $5, and the one-time code that signs a person in without a password.
 *
 * ## Sending identity
 *
 * The domain is the **`mail.` subdomain, not the apex**, and that is deliberate:
 * the apex carries the domain's human mail and its reputation, so signing bulk
 * transactional mail from a dedicated subdomain keeps a bounce storm here from
 * poisoning delivery there. Resend must show `mail.meetlisa.ai` as Verified (its
 * SPF/DKIM records in DNS) before real sends succeed — a `from` outside a
 * verified domain is refused by the provider, not by us.
 *
 * Everything we send today is security mail (a code, a confirmation link), so it
 * all comes from one no-reply sender with **no `replyTo`** — there is no useful
 * human on the other end of a sign-in code. When a mail arrives that a person
 * might sensibly answer, give it its own sender constant and a `replyTo`, rather
 * than overloading this one; and keep the code default and the deployed env
 * pointing at the *same* domain, or you get a split-brain where the docs
 * describe one sending identity and production uses another.
 *
 * ## Observability
 *
 * Every send goes through `deliver()`, which emits exactly one structured line
 * with a fixed `outcome` vocabulary — `success` / `skipped_no_key` /
 * `send_failed`. Recipients are redacted to `ab***@domain.tld`: logs are not a
 * PII-safe store, but the **domain is kept in full on purpose**, because
 * delivery problems cluster by provider and that's the first thing you need.
 *
 * Without RESEND_API_KEY the mailer degrades loudly-but-safely: the link or code
 * is printed to the server log so an operator can forward it by hand, and dev
 * setups keep working offline. **Sign-in by code therefore needs a real key in
 * production** — a code nobody receives is a sign-in nobody completes.
 *
 * Env: RESEND_API_KEY, LISA_MAIL_FROM (default "LISA <no-reply@mail.meetlisa.ai>").
 */

export interface MailResult {
  sent: boolean;
  /** Provider id on success, or the reason it wasn't sent. */
  detail: string;
}

export interface MailerConfig {
  apiKey: string | null;
  from: string;
}

/** A composed message. `text` mirrors `html` — see `deliver()`. */
export interface Mail {
  subject: string;
  text: string;
  html: string;
}

export function mailerConfig(env: Record<string, string | undefined> = process.env): MailerConfig {
  return {
    apiKey: env.RESEND_API_KEY?.trim() || null,
    from: env.LISA_MAIL_FROM?.trim() || "LISA <no-reply@mail.meetlisa.ai>",
  };
}

// ── log hygiene ─────────────────────────────────────────────────────────────

/**
 * `alice.smith@example.com` → `al***@example.com`. The local part is the
 * identifying half, so it goes; the domain stays whole because that's what you
 * group by when delivery breaks.
 */
export function redactEmail(addr: string): string {
  const at = addr.lastIndexOf("@");
  if (at <= 0 || at === addr.length - 1) return "***";
  return `${addr.slice(0, Math.min(2, at))}***@${addr.slice(at + 1)}`;
}

// ── HTML templating (hand-rolled: no MJML, no react-email, no deps) ─────────
// Email HTML is 1998 HTML — tables, inline styles, no flexbox, no <style> that
// survives Gmail. Everything below emits that shape on purpose.

const BG = "#0b0e13";
const CARD = "#12161e";
const BORDER = "#232a36";
const TEXT = "#e6e9ef";
const MUTED = "#8a93a5";
const ACCENT = "#5b8cff";

/** Escape before inlining ANY value that didn't come from this file. */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export interface TemplateOpts {
  /** The grey line clients show after the subject in the inbox list. */
  preheader?: string;
}

/**
 * The shell every mail shares: dark card, wordmark, footer. `content` is
 * trusted HTML built from the partials below — callers escape their own values.
 */
function baseTemplate(content: string, opts: TemplateOpts = {}): string {
  const preheader = opts.preheader
    ? `<div style="display:none;max-height:0;overflow:hidden;opacity:0">${escapeHtml(opts.preheader)}</div>`
    : "";
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark light">
</head>
<body style="margin:0;padding:0;background:${BG};">
${preheader}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${BG};padding:32px 12px;">
  <tr><td align="center">
    <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;">
      <tr><td style="padding-bottom:20px;font:600 20px -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:${TEXT};">
        LISA
      </td></tr>
      <tr><td style="background:${CARD};border:1px solid ${BORDER};border-radius:16px;padding:32px 28px;font:16px/1.6 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:${TEXT};">
${content}
      </td></tr>
      <tr><td style="padding-top:18px;font:12px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:${MUTED};">
        You received this because someone entered this address at
        <a href="https://meetlisa.ai" style="color:${MUTED};">meetlisa.ai</a>.
        If that wasn't you, no action is needed.
      </td></tr>
    </table>
  </td></tr>
</table>
</body>
</html>`;
}

function heading(text: string): string {
  return `<h1 style="margin:0 0 12px;font-size:20px;font-weight:600;color:${TEXT};">${escapeHtml(text)}</h1>`;
}

function para(text: string): string {
  return `<p style="margin:0 0 14px;color:${TEXT};">${escapeHtml(text)}</p>`;
}

function muted(text: string): string {
  return `<p style="margin:0;font-size:13px;color:${MUTED};">${escapeHtml(text)}</p>`;
}

/** The six digits, big enough to read once and type. */
function codeBlock(code: string): string {
  return `<p style="margin:20px 0;padding:16px;background:${BG};border:1px solid ${BORDER};border-radius:12px;
    font:600 30px/1.2 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.28em;
    text-align:center;color:${TEXT};">${escapeHtml(code)}</p>`;
}

function cta(text: string, href: string): string {
  const safe = escapeHtml(href);
  return `<p style="margin:22px 0;"><a href="${safe}"
    style="display:inline-block;padding:12px 22px;background:${ACCENT};color:#fff;
    text-decoration:none;border-radius:10px;font-weight:600;">${escapeHtml(text)}</a></p>
<p style="margin:0 0 14px;font-size:13px;color:${MUTED};word-break:break-all;">${safe}</p>`;
}

// ── the messages (pure — unit-testable, no I/O) ─────────────────────────────
// Each returns BOTH parts. multipart/alternative is a deliverability signal, and
// a text part that says something different from the HTML is itself a spam
// signal — so the two must carry the same words and the same links.

export function signInCodeEmail(code: string, ttlMinutes: number): Mail {
  return {
    subject: `${code} is your LISA sign-in code`,
    text:
      `Your LISA sign-in code is:\n\n` +
      `    ${code}\n\n` +
      `Enter it in the app or on the sign-in page. It expires in ${ttlMinutes} minutes ` +
      `and can be used once.\n\n` +
      `If you didn't try to sign in, ignore this mail — nobody can use the code ` +
      `without reading this inbox.`,
    html: baseTemplate(
      heading("Your sign-in code") +
        para("Enter this code in the app or on the sign-in page:") +
        codeBlock(code) +
        para(`It expires in ${ttlMinutes} minutes and can be used once.`) +
        muted(
          "If you didn't try to sign in, ignore this mail — nobody can use the code without reading this inbox.",
        ),
      { preheader: `${code} — expires in ${ttlMinutes} minutes` },
    ),
  };
}

export function verificationEmail(link: string): Mail {
  return {
    subject: "Verify your LISA account email",
    text:
      `Confirm this email address for your LISA account by opening the link below:\n\n` +
      `${link}\n\n` +
      `Verifying raises your free session allowance to the full amount. The link ` +
      `expires in 24 hours. If you didn't create a LISA account, ignore this mail.`,
    html: baseTemplate(
      heading("Confirm your email") +
        para("Confirm this address for your LISA account:") +
        cta("Verify this address", link) +
        para("Verifying raises your free session allowance to the full amount. The link expires in 24 hours.") +
        muted("If you didn't create a LISA account, ignore this mail."),
      { preheader: "Confirm your address to unlock the full free allowance" },
    ),
  };
}

// ── transport ───────────────────────────────────────────────────────────────

export async function sendSignInCodeEmail(
  to: string,
  code: string,
  ttlMinutes: number,
  cfg: MailerConfig = mailerConfig(),
  fetchFn: typeof fetch = fetch,
): Promise<MailResult> {
  return deliver("signin_code", to, signInCodeEmail(code, ttlMinutes), `code ${code}`, cfg, fetchFn);
}

export async function sendVerificationEmail(
  to: string,
  link: string,
  cfg: MailerConfig = mailerConfig(),
  fetchFn: typeof fetch = fetch,
): Promise<MailResult> {
  return deliver("verify_link", to, verificationEmail(link), link, cfg, fetchFn);
}

/**
 * The single exit. Every send logs exactly one line, tagged `[mail]` with a
 * fixed `outcome`, so "did it go out?" is one grep and never a guess.
 *
 * `fallback` is the credential (code or link) printed ONLY when there's no API
 * key — that's the offline/dev path, where the operator is the transport.
 */
async function deliver(
  kind: string,
  to: string,
  mail: Mail,
  fallback: string,
  cfg: MailerConfig,
  fetchFn: typeof fetch,
): Promise<MailResult> {
  const who = redactEmail(to);
  if (!cfg.apiKey) {
    // The one place a live credential is logged: no key means no delivery, so
    // the alternative is a sign-in nobody can complete.
    console.error(`[mail] outcome=skipped_no_key kind=${kind} to=${who} — ${fallback}`);
    return { sent: false, detail: "no_api_key" };
  }
  try {
    const res = await fetchFn("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        authorization: `Bearer ${cfg.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        from: cfg.from,
        to: [to],
        subject: mail.subject,
        text: mail.text,
        html: mail.html,
      }),
    });
    if (!res.ok) {
      // A 4xx here is a *logical* failure (bad domain, unverified sender, rate
      // limit) that returns a perfectly well-formed response — it must be
      // logged as loudly as a thrown network error, or it vanishes.
      const body = await res.text().catch(() => "");
      console.error(
        `[mail] outcome=send_failed kind=${kind} to=${who} status=${res.status} — ${body.slice(0, 200)}`,
      );
      return { sent: false, detail: `http_${res.status}` };
    }
    const parsed = (await res.json().catch(() => ({}))) as { id?: string };
    const id = parsed.id ?? "sent";
    console.error(`[mail] outcome=success kind=${kind} to=${who} id=${id}`);
    return { sent: true, detail: id };
  } catch (e) {
    console.error(`[mail] outcome=send_failed kind=${kind} to=${who} — ${(e as Error).message}`);
    return { sent: false, detail: "network_error" };
  }
}

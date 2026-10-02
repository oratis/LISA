/**
 * Warden inbound hygiene (plan W2b, "入站卫生").
 *
 * Untrusted inbound text — mail first — is passed through `stripSensitiveTokens`
 * before it can enter a model context. It removes the three things in a message
 * that are credentials in their own right:
 *
 *  - one-time codes (OTP / 2FA / 验证码);
 *  - sign-in, magic and e-mail-verification links;
 *  - password-reset links.
 *
 * A model that never sees them cannot be talked into relaying them, and they do
 * not end up in transcripts, digests or logs. Only counts are reported.
 */

export const REDACTED_OTP = "[redacted: one-time code]";
export const REDACTED_SIGN_IN_LINK = "[redacted: sign-in link]";
export const REDACTED_RESET_LINK = "[redacted: password-reset link]";

export interface HygieneCounts {
  otp: number;
  signInLinks: number;
  resetLinks: number;
}

export interface HygieneResult {
  text: string;
  /** How many of each kind were removed. Counts only — never the values. */
  removed: HygieneCounts;
}

export interface HygieneOptions {
  /**
   * BCP-47 hint for the text's language. Reserved: every keyword set (EN, ZH,
   * JA, KO, ES, FR, DE) is always applied, because mail is routinely mixed-language
   * and narrowing by locale could only add false negatives.
   */
  locale?: string;
}

export function emptyHygieneCounts(): HygieneCounts {
  return { otp: 0, signInLinks: 0, resetLinks: 0 };
}

/** Skeleton: returns the text unchanged. The detectors land in the next commits. */
export function stripSensitiveTokens(text: string, _opts: HygieneOptions = {}): HygieneResult {
  return { text, removed: emptyHygieneCounts() };
}

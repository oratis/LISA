/**
 * Mail module — shared types.
 *
 * v1 is READ-ONLY: connect mailboxes, read, classify, grade, digest, alert. No
 * send / archive / delete.
 *
 * PRIVACY: classification runs on METADATA + a BOUNDED SNIPPET only — never full
 * bodies. Full bodies are not persisted and not sent to the model. Secrets
 * (IMAP password / OAuth refresh token) live in a separate 0600 file, never in
 * the accounts list. Everything is gated on the `mail` consent signal.
 */

export type MailProvider = "imap" | "gmail";

/** A connected mailbox. NO secrets here (see MailSecret + the 0600 secrets file). */
export interface MailAccount {
  /** Stable slug, e.g. "qq-3f9a1c". */
  id: string;
  provider: MailProvider;
  /** The address, e.g. "me@qq.com". */
  email: string;
  /** User-facing label; defaults to the address. */
  label?: string;
  /** IMAP host (imap provider only), e.g. "imap.qq.com". */
  host?: string;
  /** IMAP port; default 993 (implicit TLS). */
  port?: number;
  addedAt: number;
  lastSweepAt?: number;
  enabled: boolean;
}

/** Per-account secret, stored only in ~/.lisa/mail/secrets.json (mode 0600). */
export interface MailSecret {
  /** IMAP app-password / authorization code. */
  password?: string;
  /** OAuth (gmail). */
  refreshToken?: string;
  accessToken?: string;
  /** Access-token expiry, epoch ms. */
  expiry?: number;
  clientId?: string;
  clientSecret?: string;
}

/**
 * Raw, minimally-fetched message: METADATA + a bounded snippet. Never the full
 * body. This is the most that ever leaves the mailbox into LISA.
 */
export interface RawMail {
  /** Account-scoped UID (stable per mailbox). */
  uid: string;
  accountId: string;
  /** Display form, e.g. "Jane Doe <jane@x.com>". */
  from: string;
  fromAddress: string;
  to?: string;
  subject: string;
  /** Epoch ms. */
  date: number;
  /** First ~N chars of the text body, bounded + whitespace-collapsed. */
  snippet: string;
  /** IMAP flags, e.g. ["\\Seen"]. */
  flags?: string[];
  mailbox: string;
}

export type MailCategory =
  | "urgent"
  | "personal"
  | "work"
  | "finance"
  | "calendar"
  | "security"
  | "newsletter"
  | "promotion"
  | "social"
  | "notification"
  | "spam"
  | "other";

export const MAIL_CATEGORIES: MailCategory[] = [
  "urgent",
  "personal",
  "work",
  "finance",
  "calendar",
  "security",
  "newsletter",
  "promotion",
  "social",
  "notification",
  "spam",
  "other",
];

/** 0 ignore · 1 fyi · 2 should-read · 3 needs-you-now. */
export type MailImportance = 0 | 1 | 2 | 3;

/** A classified message — the unit the digest + alerts operate on. */
export interface MailItem {
  uid: string;
  accountId: string;
  from: string;
  fromAddress: string;
  subject: string;
  date: number;
  snippet: string;
  category: MailCategory;
  importance: MailImportance;
  /** One-line model-written reason / summary. */
  reason: string;
  /** Heuristic signals that informed the grade (transparency). */
  signals: string[];
  classifiedAt: number;
}

export interface DigestBucket {
  category: MailCategory;
  count: number;
  /** A few representative items (capped). */
  items: MailItem[];
}

export interface DailyDigest {
  /** Local YYYY-MM-DD the digest covers. */
  date: string;
  generatedAt: number;
  accountIds: string[];
  total: number;
  unread: number;
  /** importance >= 2, newest first. */
  needsYou: MailItem[];
  buckets: DigestBucket[];
  /** Short narrative (templated, or model-written by the service). */
  summary: string;
}

/** Fetches raw mail for one account. Injectable so the service is unit-testable. */
export interface MailConnector {
  /** Messages received since `sinceMs` (capped at `limit`), metadata + snippet
   *  only, newest first. */
  listSince(opts: { sinceMs: number; limit: number }): Promise<RawMail[]>;
  /** Close any open connection. Idempotent. */
  close(): Promise<void>;
}

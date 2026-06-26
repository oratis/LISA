/**
 * Gmail connector — Gmail REST API (read-only) over the OAuth access token,
 * refreshing it when expired. format=metadata fetches headers + Gmail's native
 * `snippet` only (never the full body) — same privacy contract as IMAP.
 */
import { tokenExpired, refreshAccessToken, type FetchLike, type GoogleTokens } from "../google-oauth.js";
import type { MailAccount, MailConnector, MailSecret, RawMail } from "../types.js";

const GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me";

/** Minimal fetch (optional body so GETs omit it). */
export type HttpFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

interface GmailMessage {
  id?: string;
  snippet?: string;
  internalDate?: string;
  payload?: { headers?: { name?: string; value?: string }[] };
}

function header(msg: GmailMessage, name: string): string {
  const h = msg.payload?.headers?.find((x) => (x.name ?? "").toLowerCase() === name.toLowerCase());
  return h?.value ?? "";
}

/** Map a Gmail API message resource → RawMail. Pure. */
export function gmailMessageToRaw(msg: GmailMessage, accountId: string): RawMail {
  const fromRaw = header(msg, "From");
  const m = fromRaw.match(/<([^>]+)>/);
  const address = (m?.[1] ?? fromRaw).trim();
  return {
    uid: msg.id ?? "",
    accountId,
    from: fromRaw || address,
    fromAddress: address,
    subject: header(msg, "Subject"),
    date: msg.internalDate ? Number(msg.internalDate) : Date.now(),
    snippet: (msg.snippet ?? "").replace(/\s+/g, " ").trim().slice(0, 400),
    flags: [],
    mailbox: "INBOX",
  };
}

export interface GmailDeps {
  fetchImpl?: HttpFetch;
  /** Persist refreshed tokens (the service wires this to setSecret). */
  onTokenRefresh?: (t: GoogleTokens) => void;
  now?: () => number;
}

export class GmailConnector implements MailConnector {
  private readonly account: MailAccount;
  private secret: MailSecret;
  private readonly http: HttpFetch;
  private readonly onTokenRefresh?: (t: GoogleTokens) => void;
  private readonly now: () => number;

  constructor(account: MailAccount, secret: MailSecret, deps: GmailDeps = {}) {
    this.account = account;
    this.secret = secret;
    this.http = deps.fetchImpl ?? (fetch as unknown as HttpFetch);
    this.onTokenRefresh = deps.onTokenRefresh;
    this.now = deps.now ?? Date.now;
  }

  private async accessToken(): Promise<string> {
    const { refreshToken, clientId, clientSecret, accessToken, expiry } = this.secret;
    if (!refreshToken || !clientId || !clientSecret) {
      throw new Error(`gmail account ${this.account.id} is not authorized (no OAuth tokens)`);
    }
    if (accessToken && expiry && !tokenExpired(expiry, this.now())) return accessToken;
    const t = await refreshAccessToken(
      { refreshToken, clientId, clientSecret },
      this.http as unknown as FetchLike,
      this.now(),
    );
    this.secret = { ...this.secret, accessToken: t.accessToken, expiry: t.expiry, refreshToken: t.refreshToken };
    this.onTokenRefresh?.(t);
    return t.accessToken;
  }

  private async api<T>(url: string, token: string): Promise<T> {
    const res = await this.http(url, { method: "GET", headers: { authorization: `Bearer ${token}` } });
    const text = await res.text();
    if (!res.ok) throw new Error(`gmail api ${res.status}: ${text.slice(0, 200)}`);
    return JSON.parse(text) as T;
  }

  async listSince(opts: { sinceMs: number; limit: number }): Promise<RawMail[]> {
    const token = await this.accessToken();
    const d = new Date(opts.sinceMs);
    const q = `after:${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} in:inbox`;
    const list = await this.api<{ messages?: { id?: string }[] }>(
      `${GMAIL_API}/messages?maxResults=${opts.limit}&q=${encodeURIComponent(q)}`,
      token,
    );
    const ids = (list.messages ?? []).map((m) => m.id).filter((x): x is string => !!x);
    const out: RawMail[] = [];
    for (const id of ids) {
      const msg = await this.api<GmailMessage>(
        `${GMAIL_API}/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`,
        token,
      );
      out.push(gmailMessageToRaw(msg, this.account.id));
    }
    out.sort((a, b) => b.date - a.date);
    return out;
  }

  async close(): Promise<void> {
    /* stateless (HTTP) */
  }
}

/** Fetch the authorized account's email address (users/me/profile). */
export async function gmailProfileEmail(token: string, fetchImpl: HttpFetch = fetch as unknown as HttpFetch): Promise<string> {
  const res = await fetchImpl(`${GMAIL_API}/profile`, { method: "GET", headers: { authorization: `Bearer ${token}` } });
  const text = await res.text();
  if (!res.ok) throw new Error(`gmail profile ${res.status}`);
  return String((JSON.parse(text) as { emailAddress?: string }).emailAddress ?? "");
}

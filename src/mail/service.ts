/**
 * Mail sweep service — the once-a-day (or on-demand) pipeline:
 *   consent gate → per account: connect → list (metadata+snippet) → classify →
 *   dedup vs seen → build digest → persist.
 *
 * Connector + classify provider are injectable so the whole pipeline is
 * unit-testable without a real mailbox or a live model.
 */
import { isGranted } from "../consent/store.js";
import { loadAccounts, getSecret, markSwept, setSecret } from "./accounts.js";
import { classifyMail } from "./classify.js";
import { buildDigest } from "./digest.js";
import { saveDigest, loadSeen, markSeen } from "./store.js";
import { ImapConnector } from "./connectors/imap.js";
import { GmailConnector } from "./connectors/gmail.js";
import type { Provider } from "../providers/types.js";
import type { DailyDigest, MailAccount, MailConnector, MailItem, MailSecret } from "./types.js";

export type ConnectorFactory = (account: MailAccount, secret: MailSecret) => MailConnector;

function defaultConnector(account: MailAccount, secret: MailSecret): MailConnector {
  if (account.provider === "imap") return new ImapConnector(account, secret);
  if (account.provider === "gmail") {
    // Persist refreshed access tokens back to the 0600 secrets file.
    return new GmailConnector(account, secret, { onTokenRefresh: (t) => setSecret(account.id, t) });
  }
  throw new Error(`unknown mail provider: ${account.provider}`);
}

/** Local YYYY-MM-DD for a timestamp. */
export function localDate(ms: number): string {
  const d = new Date(ms);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}

export interface SweepOpts {
  /** Window start; default 24h before now. */
  sinceMs?: number;
  /** Per-account cap; default 200. */
  limit?: number;
  connectorFactory?: ConnectorFactory;
  provider?: Provider;
  model?: string;
  now?: () => number;
  signal?: AbortSignal;
}

export interface SweepResult {
  items: MailItem[];
  digest: DailyDigest;
  /** Items not previously seen (for alerts). */
  newItems: MailItem[];
  /** True when the consent gate blocked the sweep. */
  blocked?: boolean;
}

export async function sweepAll(opts: SweepOpts = {}): Promise<SweepResult> {
  const now = opts.now ?? Date.now;
  const sinceMs = opts.sinceMs ?? now() - 24 * 60 * 60 * 1000;
  const limit = opts.limit ?? 200;
  const factory = opts.connectorFactory ?? defaultConnector;

  if (!isGranted("mail")) {
    return {
      items: [],
      digest: buildDigest([], { date: localDate(now()), accountIds: [], now }),
      newItems: [],
      blocked: true,
    };
  }

  const accounts = loadAccounts().filter((a) => a.enabled);
  const allItems: MailItem[] = [];
  const allNew: MailItem[] = [];
  let unread = 0;

  for (const account of accounts) {
    const secret = getSecret(account.id);
    if (!secret) continue;
    let connector: MailConnector | null = null;
    try {
      connector = factory(account, secret);
      const raws = (await connector.listSince({ sinceMs, limit })).map((r) => ({ ...r, accountId: account.id }));
      if (raws.length === 0) {
        markSwept(account.id, now());
        continue;
      }
      const seen = loadSeen(account.id);
      const freshUids = new Set(raws.filter((r) => !seen.has(r.uid)).map((r) => r.uid));
      unread += raws.filter((r) => !(r.flags ?? []).includes("\\Seen")).length;

      const items = await classifyMail(raws, {
        provider: opts.provider,
        model: opts.model,
        now,
        signal: opts.signal,
      });
      allItems.push(...items);
      allNew.push(...items.filter((i) => freshUids.has(i.uid)));

      markSeen(account.id, raws.map((r) => r.uid));
      markSwept(account.id, now());
    } catch {
      // one bad account (auth error, network) must not sink the whole sweep
    } finally {
      if (connector) await connector.close().catch(() => {});
    }
  }

  const digest = buildDigest(allItems, {
    date: localDate(now()),
    accountIds: accounts.map((a) => a.id),
    unread,
    now,
  });
  saveDigest(digest);
  return { items: allItems, digest, newItems: allNew };
}

/**
 * Lightweight intraday poll: fetch, classify ONLY the unseen messages, mark seen.
 * Returns just the freshly-classified items (for important-mail alerts). Does NOT
 * rebuild/save the digest — that stays a daily artifact (or a manual sweep).
 */
export async function pollNewMail(opts: SweepOpts = {}): Promise<MailItem[]> {
  const now = opts.now ?? Date.now;
  const sinceMs = opts.sinceMs ?? now() - 24 * 60 * 60 * 1000;
  const limit = opts.limit ?? 200;
  const factory = opts.connectorFactory ?? defaultConnector;
  if (!isGranted("mail")) return [];

  const out: MailItem[] = [];
  for (const account of loadAccounts().filter((a) => a.enabled)) {
    const secret = getSecret(account.id);
    if (!secret) continue;
    let connector: MailConnector | null = null;
    try {
      connector = factory(account, secret);
      const raws = (await connector.listSince({ sinceMs, limit })).map((r) => ({ ...r, accountId: account.id }));
      const seen = loadSeen(account.id);
      const fresh = raws.filter((r) => !seen.has(r.uid));
      if (fresh.length) {
        out.push(
          ...(await classifyMail(fresh, { provider: opts.provider, model: opts.model, now, signal: opts.signal })),
        );
      }
      markSeen(account.id, raws.map((r) => r.uid));
      markSwept(account.id, now());
    } catch {
      // skip a failing account
    } finally {
      if (connector) await connector.close().catch(() => {});
    }
  }
  return out;
}

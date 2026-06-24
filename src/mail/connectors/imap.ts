/**
 * IMAP connector (imapflow) — app-password / authorization-code auth.
 *
 * Fetches ENVELOPE + flags + a BOUNDED text snippet only (≤ ~4 KB downloaded,
 * truncated further), never whole bodies — the privacy contract. Read-only:
 * opens the mailbox read-only and never sets flags / moves / deletes.
 */
import { ImapFlow } from "imapflow";
import type { MailAccount, MailConnector, MailSecret, RawMail } from "../types.js";

const SNIPPET_FETCH_BYTES = 4096;
const SNIPPET_CHARS = 400;

interface BodyNode {
  type?: string;
  part?: string;
  childNodes?: BodyNode[];
}

/** First text/plain (preferred) else text/html leaf part id, or null. Pure-ish. */
function findTextPart(node: BodyNode | undefined): { part: string; html: boolean } | null {
  if (!node) return null;
  const stack: BodyNode[] = [node];
  let htmlFallback: { part: string; html: boolean } | null = null;
  while (stack.length) {
    const n = stack.shift()!;
    const type = (n.type ?? "").toLowerCase();
    if (n.part && type === "text/plain") return { part: n.part, html: false };
    if (n.part && type === "text/html" && !htmlFallback) htmlFallback = { part: n.part, html: true };
    if (n.childNodes) stack.push(...n.childNodes);
  }
  return htmlFallback;
}

function stripHtml(s: string): string {
  return s
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

async function streamToString(stream: NodeJS.ReadableStream, maxBytes: number): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    chunks.push(buf);
    total += buf.length;
    if (total >= maxBytes) break;
  }
  return Buffer.concat(chunks).toString("utf8");
}

export class ImapConnector implements MailConnector {
  private client: ImapFlow;
  private connected = false;

  constructor(account: MailAccount, secret: MailSecret) {
    if (!account.host) throw new Error(`imap account ${account.id} has no host`);
    if (!secret.password) throw new Error(`imap account ${account.id} has no password`);
    const port = account.port ?? 993;
    this.client = new ImapFlow({
      host: account.host,
      port,
      secure: port === 993,
      auth: { user: account.email, pass: secret.password },
      logger: false,
    });
  }

  async listSince(opts: { sinceMs: number; limit: number }): Promise<RawMail[]> {
    if (!this.connected) {
      await this.client.connect();
      this.connected = true;
    }
    const lock = await this.client.getMailboxLock("INBOX", { readOnly: true } as never);
    const out: RawMail[] = [];
    try {
      const found = await this.client.search({ since: new Date(opts.sinceMs) }, { uid: true });
      const uids = (Array.isArray(found) ? found : []).slice(-opts.limit);
      if (uids.length === 0) return [];
      for await (const msg of this.client.fetch(
        uids,
        { uid: true, envelope: true, flags: true, bodyStructure: true },
        { uid: true },
      )) {
        out.push(await this.toRaw(msg, opts));
      }
    } finally {
      lock.release();
    }
    out.sort((a, b) => b.date - a.date);
    return out;
  }

  private async toRaw(
    msg: {
      uid: number;
      envelope?: { from?: { name?: string; address?: string }[]; subject?: string; date?: Date };
      flags?: Set<string>;
      bodyStructure?: BodyNode;
    },
    _opts: { sinceMs: number; limit: number },
  ): Promise<RawMail> {
    const env = msg.envelope ?? {};
    const f = env.from?.[0] ?? {};
    const address = f.address ?? "";
    const from = f.name ? `${f.name} <${address}>` : address;
    let snippet = "";
    const part = findTextPart(msg.bodyStructure);
    if (part) {
      try {
        const dl = await this.client.download(String(msg.uid), part.part, {
          uid: true,
          maxBytes: SNIPPET_FETCH_BYTES,
        } as never);
        let text = await streamToString(dl.content, SNIPPET_FETCH_BYTES);
        if (part.html) text = stripHtml(text);
        snippet = text.replace(/\s+/g, " ").trim().slice(0, SNIPPET_CHARS);
      } catch {
        snippet = "";
      }
    }
    return {
      uid: String(msg.uid),
      accountId: "", // filled by the caller (service) — connector is account-agnostic
      from,
      fromAddress: address,
      subject: env.subject ?? "",
      date: env.date ? new Date(env.date).getTime() : Date.now(),
      snippet,
      flags: msg.flags ? [...msg.flags] : [],
      mailbox: "INBOX",
    };
  }

  async close(): Promise<void> {
    if (!this.connected) return;
    try {
      await this.client.logout();
    } catch {
      /* already closed */
    }
    this.connected = false;
  }
}

/**
 * Apple In-App Purchase — StoreKit 2 JWS verification + crediting
 * (docs/PLAN_ACCOUNTS_BILLING_v1.0.md §6.4, milestone B5).
 *
 * The iOS app purchases a consumable credit pack and POSTs the transaction's
 * JWS representation to `/api/billing/iap`. We verify it here — signature
 * (ES256) by the leaf of the embedded x5c chain, chain rooted in Apple's
 * Root CA G3 — then validate bundle/product, dedupe by transactionId in a
 * GLOBAL index (one Apple transaction can never credit two accounts), and
 * credit the signed-in account's balance. The client calls
 * `Transaction.finish()` only after we answer OK, so a crash between purchase
 * and credit is re-delivered by StoreKit, and the dedup makes that safe.
 *
 * App Store Server Notifications V2 (`/api/billing/asn`) reuses the same JWS
 * verification; REFUND/REVOKE claws the credit back from whichever account
 * the global index says received it.
 *
 * No external dependencies: node:crypto's X509Certificate walks the chain and
 * verifies ES256 (ieee-p1363). The Apple root is fetched once from
 * apple.com/certificateauthority over TLS and cached under the global home
 * (override with LISA_APPLE_ROOT_PATH for air-gapped deploys).
 */
import fs from "node:fs";
import path from "node:path";
import crypto, { X509Certificate } from "node:crypto";
import { lisaGlobalHome, homeScope, homeForUid } from "../paths.js";
import { withFileLock } from "../soul/lock.js";
import { creditPurchase, clawbackPurchase } from "./quota.js";

export class IapError extends Error {
  constructor(
    public code:
      | "malformed_jws"
      | "bad_chain"
      | "bad_signature"
      | "wrong_bundle"
      | "unknown_product"
      | "duplicate_transaction"
      | "root_unavailable"
      | "unknown_transaction",
  ) {
    super(code);
    this.name = "IapError";
  }
}

/** Consumable credit packs: ASC product id → credited face value (micro-USD). */
export const PRODUCTS: Record<string, number> = {
  "ai.meetlisa.main.credits.5": 5_000_000,
  "ai.meetlisa.main.credits.10": 10_500_000, // +5% bonus
  "ai.meetlisa.main.credits.20": 22_000_000, // +10% bonus
};

export const EXPECTED_BUNDLE = "ai.meetlisa.main";

const APPLE_ROOT_URL = "https://www.apple.com/certificateauthority/AppleRootCA-G3.cer";

function rootCachePath(): string {
  return process.env.LISA_APPLE_ROOT_PATH ?? path.join(lisaGlobalHome(), "apple-root-g3.cer");
}

let rootCert: X509Certificate | null = null;

/** Load (fetch-once + cache) Apple's Root CA G3. */
export async function appleRootCert(): Promise<X509Certificate> {
  if (rootCert) return rootCert;
  const file = rootCachePath();
  try {
    rootCert = new X509Certificate(fs.readFileSync(file));
    return rootCert;
  } catch {
    /* fall through to fetch */
  }
  const res = await fetch(APPLE_ROOT_URL);
  if (!res.ok) throw new IapError("root_unavailable");
  const der = Buffer.from(await res.arrayBuffer());
  const cert = new X509Certificate(der);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, der);
  rootCert = cert;
  return cert;
}

/** Test seam. */
export function _setAppleRootForTests(cert: X509Certificate | null): void {
  rootCert = cert;
}

function b64urlJson(segment: string): Record<string, unknown> {
  try {
    return JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
  } catch {
    throw new IapError("malformed_jws");
  }
}

/** The fields of a decoded StoreKit 2 transaction we act on. */
export interface AppleTransaction {
  transactionId: string;
  productId: string;
  bundleId: string;
  /** "Production" | "Sandbox" (Xcode/TestFlight). */
  environment?: string;
  purchaseDate?: number;
}

/**
 * Verify a StoreKit 2 JWS (transaction or ASN payload) and return its decoded
 * payload. Checks: x5c chain (leaf←intermediate←root, root pinned to Apple
 * Root CA G3), validity windows, and the ES256 signature by the leaf.
 */
export async function verifyAppleJWS(
  jws: string,
  opts: { root?: X509Certificate; now?: number } = {},
): Promise<Record<string, unknown>> {
  const parts = jws.split(".");
  if (parts.length !== 3) throw new IapError("malformed_jws");
  const [headerB64, payloadB64, sigB64] = parts as [string, string, string];
  const header = b64urlJson(headerB64);
  if (header.alg !== "ES256" || !Array.isArray(header.x5c) || header.x5c.length < 2) {
    throw new IapError("malformed_jws");
  }
  const chain = (header.x5c as string[]).map((c) => {
    try {
      return new X509Certificate(Buffer.from(c, "base64"));
    } catch {
      throw new IapError("malformed_jws");
    }
  });
  const root = opts.root ?? (await appleRootCert());
  const now = opts.now ?? Date.now();
  // Each cert must be inside its validity window and signed by the next one;
  // the last must be signed by (or BE) the pinned root.
  for (let i = 0; i < chain.length; i++) {
    const cert = chain[i]!;
    if (now < Date.parse(cert.validFrom) || now > Date.parse(cert.validTo)) {
      throw new IapError("bad_chain");
    }
    const issuer = i + 1 < chain.length ? chain[i + 1]! : root;
    if (!cert.verify(issuer.publicKey)) throw new IapError("bad_chain");
  }
  const last = chain[chain.length - 1]!;
  if (last.fingerprint256 !== root.fingerprint256 && !last.verify(root.publicKey)) {
    throw new IapError("bad_chain");
  }
  // ES256 over "header.payload" with the LEAF key, ieee-p1363 (r||s) encoding.
  const ok = crypto.verify(
    "sha256",
    Buffer.from(`${headerB64}.${payloadB64}`, "utf8"),
    { key: chain[0]!.publicKey, dsaEncoding: "ieee-p1363" },
    Buffer.from(sigB64, "base64url"),
  );
  if (!ok) throw new IapError("bad_signature");
  return b64urlJson(payloadB64);
}

/** Validate the decoded transaction payload against bundle + product table. */
export function validateTransaction(payload: Record<string, unknown>): AppleTransaction {
  const tx: AppleTransaction = {
    transactionId: String(payload.transactionId ?? ""),
    productId: String(payload.productId ?? ""),
    bundleId: String(payload.bundleId ?? ""),
    environment: typeof payload.environment === "string" ? payload.environment : undefined,
    purchaseDate: typeof payload.purchaseDate === "number" ? payload.purchaseDate : undefined,
  };
  if (!tx.transactionId) throw new IapError("malformed_jws");
  if (tx.bundleId !== EXPECTED_BUNDLE) throw new IapError("wrong_bundle");
  if (!(tx.productId in PRODUCTS)) throw new IapError("unknown_product");
  return tx;
}

// ── Global transaction index (one credit per Apple transaction, ever) ───────
interface TxIndexEntry {
  transactionId: string;
  uid: string;
  productId: string;
  microUSD: number;
  at: number;
}

function txIndexPath(): string {
  return path.join(lisaGlobalHome(), "iap-transactions.json");
}
function txIndexLock(): string {
  return path.join(lisaGlobalHome(), "iap-transactions.lock");
}

function readTxIndex(): TxIndexEntry[] {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(txIndexPath(), "utf8"));
    return Array.isArray(parsed) ? (parsed as TxIndexEntry[]) : [];
  } catch {
    return [];
  }
}

function writeTxIndex(list: TxIndexEntry[]): void {
  const file = txIndexPath();
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(list, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/**
 * Credit ANY external payment (Apple IAP, Stripe, operator grant) to `uid`
 * exactly once: global transactionId dedup, then the uid's balance inside its
 * home scope. Shared by the IAP and Stripe paths so cross-channel replay is
 * impossible by construction. Returns the credited face value.
 */
export async function creditExternalTransaction(
  uid: string,
  transactionId: string,
  productId: string,
  microUSD: number,
  now: number = Date.now(),
): Promise<number> {
  await withFileLock(txIndexLock(), async () => {
    const index = readTxIndex();
    if (index.some((e) => e.transactionId === transactionId)) {
      throw new IapError("duplicate_transaction");
    }
    index.push({ transactionId, uid, productId, microUSD, at: now });
    writeTxIndex(index);
  });
  await homeScope.run(homeForUid(uid), () =>
    creditPurchase({ at: now, microUSD, transactionId }, now),
  );
  return microUSD;
}

/** Credit a VERIFIED Apple transaction to `uid` (IAP flavor of the above). */
export async function creditTransaction(uid: string, tx: AppleTransaction, now: number = Date.now()): Promise<number> {
  return creditExternalTransaction(uid, tx.transactionId, tx.productId, PRODUCTS[tx.productId]!, now);
}

/**
 * Reverse a refunded transaction (ASN V2 REFUND/REVOKE): find the owning uid
 * in the global index and claw the credit back from that account's balance.
 */
export async function refundTransaction(transactionId: string): Promise<{ uid: string; microUSD: number } | null> {
  let entry: TxIndexEntry | undefined;
  await withFileLock(txIndexLock(), async () => {
    const index = readTxIndex();
    entry = index.find((e) => e.transactionId === transactionId);
    // Keep the index entry (marked) so a replayed credit stays deduped.
  });
  if (!entry) return null;
  const uid = entry.uid;
  await homeScope.run(homeForUid(uid), () => clawbackPurchase(transactionId));
  return { uid, microUSD: entry.microUSD };
}

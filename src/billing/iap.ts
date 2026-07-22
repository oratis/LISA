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
import { firestoreEnabled, getDoc, setDoc, FirestoreError } from "../cloud/firestore.js";

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

/**
 * Apple Root CA G3, pinned by SHA-256 (#265). Without this the "pinned" root
 * was whatever apple.com served over TLS and then whatever sat in the cache
 * file — so a TLS compromise or a writable cache dir substituted the trust
 * anchor and every downstream chain check became theatre. Node's
 * `fingerprint256` format: uppercase hex, colon-separated.
 */
const APPLE_ROOT_G3_SHA256 =
  "63:34:3A:BF:B8:9A:6A:03:EB:B5:7E:9B:3F:5F:A7:BE:7C:4F:5C:75:6F:30:17:B3:A8:C4:88:C3:65:3E:91:79";

/**
 * Apple's certificate marker extensions. Presence is asserted on the DER, which
 * is enough to keep an unrelated (even Apple-issued) cert from standing in for
 * a receipt-signing one — Node's X509Certificate exposes no extension getter,
 * and its `keyUsage` reads back undefined on these certs.
 */
const OID_LEAF_RECEIPT_SIGNING = "1.2.840.113635.100.6.11.1";
const OID_INTERMEDIATE_WWDR = "1.2.840.113635.100.6.2.1";

/** Whether the root came from an explicit operator override (not fingerprint-pinned). */
function rootPathOverridden(): boolean {
  return !!process.env.LISA_APPLE_ROOT_PATH;
}

function rootCachePath(): string {
  return process.env.LISA_APPLE_ROOT_PATH ?? path.join(lisaGlobalHome(), "apple-root-g3.cer");
}

let rootCert: X509Certificate | null = null;

/**
 * Load (fetch-once + cache) Apple's Root CA G3, pinned to `APPLE_ROOT_G3_SHA256`.
 *
 * A cache file that doesn't match the pin is treated as absent (poisoned or
 * stale ⇒ re-fetch), and a fetch that doesn't match is a hard failure — so the
 * anchor is the real G3 no matter which path it arrived by. An EXISTING file at
 * `LISA_APPLE_ROOT_PATH` skips the pin: that's the documented air-gapped/test
 * escape hatch, where the operator has chosen the anchor themselves.
 */
export async function appleRootCert(): Promise<X509Certificate> {
  if (rootCert) return rootCert;
  const file = rootCachePath();
  const overridden = rootPathOverridden();
  try {
    const cached = new X509Certificate(fs.readFileSync(file));
    if (overridden || cached.fingerprint256 === APPLE_ROOT_G3_SHA256) {
      rootCert = cached;
      return rootCert;
    }
    console.error(`[iap] cached Apple root at ${file} failed the G3 pin — refetching`);
  } catch {
    /* fall through to fetch */
  }
  const res = await fetch(APPLE_ROOT_URL);
  if (!res.ok) throw new IapError("root_unavailable");
  const der = Buffer.from(await res.arrayBuffer());
  const cert = new X509Certificate(der);
  if (cert.fingerprint256 !== APPLE_ROOT_G3_SHA256) throw new IapError("root_unavailable");
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, der);
  rootCert = cert;
  return cert;
}

/**
 * Encode a dotted OID as its DER TLV (tag 0x06). Pure + deterministic — e.g.
 * `1.2.840.113635.100.6.11.1` → `060a2a864886f76364060b01`.
 */
export function oidToDer(oid: string): Buffer {
  const arcs = oid.split(".").map(Number);
  if (arcs.length < 2 || arcs.some((n) => !Number.isInteger(n) || n < 0)) {
    throw new IapError("bad_chain");
  }
  const content: number[] = [arcs[0]! * 40 + arcs[1]!];
  for (const arc of arcs.slice(2)) {
    // base-128, most-significant group first, continuation bit on all but last
    const groups = [arc & 0x7f];
    for (let v = arc >>> 7; v > 0; v >>>= 7) groups.unshift((v & 0x7f) | 0x80);
    content.push(...groups);
  }
  return Buffer.from([0x06, content.length, ...content]);
}

/** Does this cert carry `oid` anywhere in its DER (i.e. as an extension id)? */
export function certHasOid(cert: X509Certificate, oid: string): boolean {
  return cert.raw.includes(oidToDer(oid));
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
  // Role checks (#265). A signature chain alone doesn't say what each cert is
  // FOR: without these, any leaf Apple ever issued — or any leaf presented as
  // its own issuer — could sign transactions. `.ca` is basicConstraints CA
  // (reliable here; `.keyUsage` reads back undefined on Apple certs), and the
  // marker OIDs identify the receipt-signing leaf and the WWDR intermediate.
  if (chain[0]!.ca) throw new IapError("bad_chain"); // a CA must not sign receipts
  if (!certHasOid(chain[0]!, OID_LEAF_RECEIPT_SIGNING)) throw new IapError("bad_chain");
  if (!certHasOid(chain[1]!, OID_INTERMEDIATE_WWDR)) throw new IapError("bad_chain");
  for (let i = 1; i < chain.length; i++) {
    if (!chain[i]!.ca) throw new IapError("bad_chain"); // non-CA can't issue
  }
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
  if (firestoreEnabled()) {
    // B9: one doc per transaction, create-only precondition — the dedup is a
    // property of the datastore itself, valid across every instance.
    try {
      await setDoc(
        `lisa-txindex/${encodeURIComponent(transactionId)}`,
        { transactionId, uid, productId, microUSD, at: now },
        { exists: false },
      );
    } catch (e) {
      if (e instanceof FirestoreError && (e.status === 409 || e.status === 412)) {
        throw new IapError("duplicate_transaction");
      }
      throw e;
    }
  } else {
    await withFileLock(txIndexLock(), async () => {
      const index = readTxIndex();
      if (index.some((e) => e.transactionId === transactionId)) {
        throw new IapError("duplicate_transaction");
      }
      index.push({ transactionId, uid, productId, microUSD, at: now });
      writeTxIndex(index);
    });
  }
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
  if (firestoreEnabled()) {
    const doc = await getDoc(`lisa-txindex/${encodeURIComponent(transactionId)}`);
    if (doc && typeof doc.data.uid === "string") {
      entry = doc.data as unknown as TxIndexEntry;
    }
    // The doc stays (never deleted) so a replayed credit remains deduped.
  } else {
    await withFileLock(txIndexLock(), async () => {
      const index = readTxIndex();
      entry = index.find((e) => e.transactionId === transactionId);
      // Keep the index entry (marked) so a replayed credit stays deduped.
    });
  }
  if (!entry) return null;
  const uid = entry.uid;
  await homeScope.run(homeForUid(uid), () => clawbackPurchase(transactionId));
  return { uid, microUSD: entry.microUSD };
}

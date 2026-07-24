/**
 * B9 cutover: import file-backed account state into Firestore (S6).
 *
 * The Firestore layer (src/cloud/firestore.ts) starts EMPTY — flipping
 * LISA_FIRESTORE=1 without this import would orphan every existing account.
 * This script reads a LISA home directory (the GCS-mounted /data, or a local
 * copy of it) and writes the three stores the runtime reads:
 *
 *   accounts.json                          → lisa-global/accounts   {list}
 *   users/<uid>/billing/balance.json       → lisa-balances/<uid>
 *   iap-transactions.json                  → lisa-txindex/<txId>    (create-only)
 *
 * Idempotent: tx docs are create-only (409s are counted as already-present),
 * accounts/balances refuse to overwrite an existing doc unless --force.
 *
 * Usage (run while the service still has MAX_INSTANCES=1, then flip the env):
 *   LISA_FIRESTORE=1 \
 *   LISA_FIRESTORE_PROJECT=<project> \
 *   LISA_FIRESTORE_TOKEN="$(gcloud auth print-access-token)" \
 *   npx tsx scripts/import-accounts-firestore.ts /path/to/lisa-home [--dry-run] [--force]
 */
import fs from "node:fs";
import path from "node:path";
import { getDoc, setDoc } from "../src/cloud/firestore.js";
import { FirestoreError } from "../src/cloud/firestore.js";

const args = process.argv.slice(2);
const home = args.find((a) => !a.startsWith("--"));
const dryRun = args.includes("--dry-run");
const force = args.includes("--force");

if (!home || !fs.existsSync(home)) {
  console.error("usage: import-accounts-firestore.ts <lisa-home-dir> [--dry-run] [--force]");
  process.exit(1);
}
if (!process.env.LISA_FIRESTORE) {
  console.error("✗ set LISA_FIRESTORE=1 (plus LISA_FIRESTORE_PROJECT and LISA_FIRESTORE_TOKEN)");
  process.exit(1);
}

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
}

interface TxEntry {
  transactionId: string;
  uid: string;
  productId: string;
  microUSD: number;
  at: number;
}

async function main(): Promise<void> {
  let wrote = 0;
  let skipped = 0;

  // 1. accounts.json → lisa-global/accounts
  const accounts = readJson<unknown[]>(path.join(home!, "accounts.json")) ?? [];
  console.log(`accounts.json: ${accounts.length} records`);
  const existing = await getDoc("lisa-global/accounts");
  const existingCount = Array.isArray(existing?.data.list) ? (existing!.data.list as unknown[]).length : 0;
  if (existing && existingCount > 0 && !force) {
    console.log(`  ↷ lisa-global/accounts already holds ${existingCount} records — skipping (use --force to overwrite)`);
    skipped++;
  } else if (dryRun) {
    console.log(`  (dry-run) would write lisa-global/accounts with ${accounts.length} records`);
  } else {
    await setDoc("lisa-global/accounts", { list: accounts as Record<string, unknown>[] });
    console.log(`  ✓ wrote lisa-global/accounts`);
    wrote++;
  }

  // 2. users/<uid>/billing/balance.json → lisa-balances/<uid>
  const usersDir = path.join(home!, "users");
  const uids = fs.existsSync(usersDir)
    ? fs.readdirSync(usersDir).filter((d) => fs.statSync(path.join(usersDir, d)).isDirectory())
    : [];
  console.log(`users/: ${uids.length} homes`);
  for (const uid of uids) {
    const balance = readJson<Record<string, unknown>>(path.join(usersDir, uid, "billing", "balance.json"));
    if (!balance) continue;
    const doc = `lisa-balances/${uid}`;
    if (!force && (await getDoc(doc))) {
      console.log(`  ↷ ${doc} exists — skipping`);
      skipped++;
      continue;
    }
    if (dryRun) {
      console.log(`  (dry-run) would write ${doc} (paid=${balance.paidMicroUSD})`);
      continue;
    }
    await setDoc(doc, balance);
    console.log(`  ✓ ${doc}`);
    wrote++;
  }

  // 3. iap-transactions.json → lisa-txindex/<txId> (create-only, replay-safe)
  const txs = readJson<TxEntry[]>(path.join(home!, "iap-transactions.json")) ?? [];
  console.log(`iap-transactions.json: ${txs.length} entries`);
  for (const tx of txs) {
    if (!tx?.transactionId) continue;
    const doc = `lisa-txindex/${encodeURIComponent(tx.transactionId)}`;
    if (dryRun) {
      console.log(`  (dry-run) would create ${doc}`);
      continue;
    }
    try {
      await setDoc(doc, { ...tx } as unknown as Record<string, unknown>, { exists: false });
      wrote++;
    } catch (e) {
      if (e instanceof FirestoreError && (e.status === 409 || e.status === 412)) {
        skipped++; // already imported — the create-only precondition held
        continue;
      }
      throw e;
    }
  }

  console.log(`\ndone: ${wrote} written, ${skipped} skipped${dryRun ? " (dry-run — nothing written)" : ""}`);
}

main().catch((e) => {
  console.error(`✗ import failed: ${(e as Error).message}`);
  process.exit(1);
});

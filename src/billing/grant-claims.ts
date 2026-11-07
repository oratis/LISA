/**
 * One welcome grant per sign-in identity (#447 review).
 *
 * The welcome grant is recorded on the balance, and account deletion erases
 * the balance. A uid is minted fresh on every account creation, so without a
 * record outside the account, deleting it and signing in again with the same
 * Apple ID, Google account or inbox would issue the grant again, as often as
 * anyone cared to repeat it.
 *
 * So the grant is claimed here, under each identity the account signs in with
 * (Apple subject, Google subject, verified email). A claim is a one-way hash
 * and a timestamp: no uid, no address, nothing that names the person. It is
 * kept when the account is deleted, which the privacy policy says. An account
 * gets the grant only when none of its identities has claimed one before.
 *
 * Storage follows the balance: Firestore `lisa-grant-claims/{hash}` when it is
 * on, else `<global home>/welcome-grants.json` under a file lock.
 */
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { lisaGlobalHome } from "../paths.js";
import { atomicWrite, ensureDir } from "../fs-utils.js";
import { withFileLock } from "../soul/lock.js";
import { casUpdate, firestoreEnabled, getDoc } from "../cloud/firestore.js";
import type { AccountRecord } from "../web/accounts.js";

/** The hashed identities a welcome grant is claimed under. */
export function grantIdentityKeys(acct: AccountRecord): string[] {
  const identities = new Set<string>();
  if (acct.appleSub) identities.add(`apple:${acct.appleSub}`);
  else if (acct.kind === "apple" && acct.uid.startsWith("apple-"))
    identities.add(`apple:${acct.uid.slice("apple-".length)}`); // legacy uid encodes the sub
  if (acct.googleSub) identities.add(`google:${acct.googleSub}`);
  if (acct.email) identities.add(`email:${acct.email.trim().toLowerCase()}`);
  if (identities.size === 0) identities.add(`uid:${acct.uid}`);
  return [...identities].map((id) =>
    crypto.createHash("sha256").update(`lisa-welcome-grant:${id}`).digest("hex"),
  );
}

function claimsFile(): string {
  return path.join(lisaGlobalHome(), "welcome-grants.json");
}
function claimsLock(): string {
  return path.join(lisaGlobalHome(), "welcome-grants.lock");
}

async function readClaims(): Promise<Record<string, number>> {
  try {
    const parsed = JSON.parse(await fs.readFile(claimsFile(), "utf8")) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, number>;
    }
    throw new Error("welcome-grant claims are not an object");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw err;
  }
}

/** Has any of this account's identities claimed a welcome grant? Read-only. */
export async function welcomeGrantClaimed(acct: AccountRecord): Promise<boolean> {
  const keys = grantIdentityKeys(acct);
  if (firestoreEnabled()) {
    for (const key of keys) {
      if (await getDoc(`lisa-grant-claims/${key}`)) return true;
    }
    return false;
  }
  const claims = await readClaims();
  return keys.some((key) => claims[key] !== undefined);
}

/**
 * Claim the welcome grant for this account's identities. True when none of
 * them had claimed one, so the grant may be issued; false otherwise. Every
 * identity is marked either way, so an identity linked later cannot reopen it.
 */
export async function claimWelcomeGrant(
  acct: AccountRecord,
  now: number = Date.now(),
): Promise<boolean> {
  const keys = grantIdentityKeys(acct);
  if (firestoreEnabled()) {
    let fresh = true;
    for (const key of keys) {
      const created = await casUpdate(`lisa-grant-claims/${key}`, (current) =>
        current ? { next: null, result: false } : { next: { at: now }, result: true },
      );
      if (!created) fresh = false;
    }
    return fresh;
  }
  await ensureDir(lisaGlobalHome());
  return withFileLock(claimsLock(), async () => {
    const claims = await readClaims();
    const fresh = keys.every((key) => claims[key] === undefined);
    for (const key of keys) claims[key] ??= now;
    await atomicWrite(claimsFile(), JSON.stringify(claims));
    return fresh;
  });
}

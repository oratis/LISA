/**
 * Remove an account's billing state from Firestore when the account is deleted
 * (App Store 5.1.1(v): in-app deletion removes the account's data).
 *
 * In file mode everything lives under the per-uid home, which account deletion
 * already removes, so this is a no-op there. With Firestore on, the balance,
 * the usage outbox (its index document and every event in the subcollection,
 * which Firestore does not delete with the parent) and the anomaly-alert
 * claims are deleted here.
 *
 * Kept on purpose:
 *  - `lisa-txindex/*` — purchase transaction records. A refund notification can
 *    arrive after deletion and must still find the purchase; they are also
 *    financial records. The privacy policy says so.
 *  - `lisa-grant-claims/*` — one-way hashes of sign-in identities that have had
 *    the welcome grant (grant-claims.ts), so deleting the account and signing in
 *    again cannot claim it twice. They name no uid and no address.
 *  - the uid inside the outbox tenant registry — it holds no usage, and
 *    removing it could hide a re-created account (Apple-derived uids repeat)
 *    from the reconciler for the lifetime of an instance.
 */
import { deleteDoc, firestoreEnabled, listDocIds } from "../cloud/firestore.js";

export async function eraseAccountBilling(
  uid: string,
  fetchFn: typeof fetch = fetch,
): Promise<void> {
  if (!firestoreEnabled()) return;
  for (const id of await listDocIds(`lisa-outbox/${uid}/events`, fetchFn)) {
    await deleteDoc(`lisa-outbox/${uid}/events/${id}`, fetchFn);
  }
  await deleteDoc(`lisa-outbox/${uid}`, fetchFn);
  await deleteDoc(`lisa-balances/${uid}`, fetchFn);
  for (const id of await listDocIds("lisa-anomaly-alerts", fetchFn)) {
    if (id.startsWith(`${uid}_`)) await deleteDoc(`lisa-anomaly-alerts/${id}`, fetchFn);
  }
}

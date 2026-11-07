/**
 * Mail accounts + secrets store.
 *
 *   ~/.lisa/mail/accounts.json   — the connected mailboxes (no secrets)
 *   ~/.lisa/mail/secrets.json    — secret references; old values migrate into SecretStore on access
 *
 * lisaHome() is resolved lazily so tests can point it at a tmp dir. Absence of
 * either file means "no accounts" — exactly the pre-feature behavior.
 */
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { withFileLock } from "../soul/lock.js";
import { openSecretStore } from "../warden/secrets-open.js";
import type { SecretStore } from "../warden/secrets.js";
import { lisaHome } from "../paths.js";
import path from "node:path";
import type { MailAccount, MailSecret, MailProvider } from "./types.js";

export function mailDir(): string {
  return path.join(lisaHome(), "mail");
}
function accountsPath(): string {
  return path.join(mailDir(), "accounts.json");
}
function secretsPath(): string {
  return path.join(mailDir(), "secrets.json");
}

function ensureDir(): void {
  fs.mkdirSync(mailDir(), { recursive: true });
}

function readJson<T>(p: string, fallback: T): T {
  try {
    if (fs.statSync(p).size > 2_000_000) throw new Error("mail_store_corrupt");
    return JSON.parse(fs.readFileSync(p, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    // JSON parse errors may quote credential bytes; do not retain their cause.
    // eslint-disable-next-line preserve-caught-error
    throw new Error("mail_store_corrupt");
  }
}

// ── accounts ──

export function loadAccounts(): MailAccount[] {
  const list = readJson<MailAccount[]>(accountsPath(), []);
  if (
    !Array.isArray(list) ||
    list.some(
      (a) =>
        !a ||
        typeof a !== "object" ||
        !validId(a.id) ||
        !["imap", "gmail"].includes(a.provider) ||
        typeof a.email !== "string",
    )
  )
    throw new Error("mail_store_corrupt");
  return list;
}

export function saveAccounts(accounts: MailAccount[]): void {
  ensureDir();
  fs.writeFileSync(accountsPath(), JSON.stringify(accounts, null, 2), { mode: 0o600 });
}

export function getAccount(id: string): MailAccount | undefined {
  return loadAccounts().find((a) => a.id === id);
}

let counter = 0;
function slug(provider: MailProvider, email: string): string {
  const base = (email.split("@")[1] ?? provider).split(".")[0] || provider;
  const rand = (Date.now() + ++counter).toString(36).slice(-6);
  return `${base}-${rand}`;
}

export interface AddAccountInput {
  provider: MailProvider;
  email: string;
  label?: string;
  host?: string;
  port?: number;
}

/** Add an account (+ store its secret). Returns the created account. */
export async function addAccount(
  input: AddAccountInput,
  secret: MailSecret,
  now: () => number = Date.now,
): Promise<MailAccount> {
  const account: MailAccount = {
    id: slug(input.provider, input.email),
    provider: input.provider,
    email: input.email,
    label: input.label ?? input.email,
    host: input.host,
    port: input.port ?? (input.provider === "imap" ? 993 : undefined),
    addedAt: now(),
    enabled: true,
  };
  await setSecret(account.id, secret);
  const accounts = loadAccounts();
  accounts.push(account);
  saveAccounts(accounts);
  return account;
}

export async function removeAccount(id: string): Promise<boolean> {
  const accounts = loadAccounts();
  const next = accounts.filter((a) => a.id !== id);
  if (next.length === accounts.length) return false;
  await withSecrets(async (secrets, store) => {
    const entry = secrets[id];
    if (entry && "secretRef" in entry) await store.remove(entry.secretRef);
    delete secrets[id];
    writeSecrets(secrets);
  });
  saveAccounts(next);
  return true;
}

export function setAccountEnabled(id: string, enabled: boolean): boolean {
  const accounts = loadAccounts();
  const a = accounts.find((x) => x.id === id);
  if (!a) return false;
  a.enabled = enabled;
  saveAccounts(accounts);
  return true;
}

export function markSwept(id: string, when: number = Date.now()): void {
  const accounts = loadAccounts();
  const a = accounts.find((x) => x.id === id);
  if (!a) return;
  a.lastSweepAt = when;
  saveAccounts(accounts);
}

// Old credential values are migrated on access. The legacy file then holds references only.
type SecretEntry = MailSecret | { secretRef: string };
const validId = (id: unknown): id is string =>
  typeof id === "string" &&
  /^[a-zA-Z0-9_-]{1,100}$/.test(id) &&
  !["__proto__", "constructor", "prototype"].includes(id);
function writeSecrets(secrets: Record<string, SecretEntry>): void {
  ensureDir();
  const temporary = `${secretsPath()}.${randomUUID()}.tmp`;
  try {
    const fd = fs.openSync(temporary, "wx", 0o600);
    try {
      fs.writeFileSync(fd, JSON.stringify(secrets, null, 2));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(temporary, secretsPath());
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}
function validSecret(value: unknown): value is MailSecret {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.entries(value).every(([key, val]) =>
    key === "expiry"
      ? typeof val === "number" && Number.isFinite(val)
      : ["password", "refreshToken", "accessToken", "clientId", "clientSecret"].includes(key) &&
        typeof val === "string" &&
        val.length <= 16_000,
  );
}
async function withSecrets<T>(
  work: (entries: Record<string, SecretEntry>, store: SecretStore) => Promise<T>,
): Promise<T> {
  ensureDir();
  return withFileLock(path.join(mailDir(), "secrets.lock"), async () => {
    const entries = readJson<Record<string, SecretEntry>>(secretsPath(), {});
    if (
      !entries ||
      typeof entries !== "object" ||
      Array.isArray(entries) ||
      Object.entries(entries).some(
        ([id, value]) =>
          !validId(id) ||
          (!validSecret(value) &&
            !(
              value &&
              typeof value === "object" &&
              "secretRef" in value &&
              value.secretRef === `mail/${id}` &&
              Object.keys(value).length === 1
            )),
      )
    )
      throw new Error("mail_store_corrupt");
    return work(entries, openSecretStore({ home: lisaHome() }));
  });
}
async function resolveEntry(
  id: string,
  entries: Record<string, SecretEntry>,
  store: SecretStore,
): Promise<MailSecret | undefined> {
  const entry = Object.hasOwn(entries, id) ? entries[id] : undefined;
  if (!entry) return undefined;
  if ("secretRef" in entry) {
    const value = await store.get(entry.secretRef);
    if (!value) throw new Error("mail_secret_unavailable");
    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch {
      throw new Error("mail_store_corrupt");
    }
    if (!validSecret(parsed)) throw new Error("mail_store_corrupt");
    return parsed;
  }
  const ref = `mail/${id}`,
    value = JSON.stringify(entry);
  await store.set(ref, value);
  if ((await store.get(ref)) !== value) throw new Error("mail_secret_migration_failed");
  entries[id] = { secretRef: ref };
  writeSecrets(entries);
  return entry;
}
export async function getSecret(id: string): Promise<MailSecret | undefined> {
  if (!validId(id)) throw new Error("invalid_mail_secret");
  return withSecrets((entries, store) => resolveEntry(id, entries, store));
}
export async function setSecret(id: string, secret: MailSecret): Promise<void> {
  if (!validId(id) || !validSecret(secret)) throw new Error("invalid_mail_secret");
  await withSecrets(async (entries, store) => {
    const value = JSON.stringify({ ...(await resolveEntry(id, entries, store)), ...secret });
    const ref = `mail/${id}`;
    await store.set(ref, value);
    if ((await store.get(ref)) !== value) throw new Error("mail_secret_migration_failed");
    entries[id] = { secretRef: ref };
    writeSecrets(entries);
  });
}

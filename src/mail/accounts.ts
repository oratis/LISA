/**
 * Mail accounts + secrets store.
 *
 *   ~/.lisa/mail/accounts.json   — the connected mailboxes (no secrets)
 *   ~/.lisa/mail/secrets.json    — per-account secrets, mode 0600
 *
 * lisaHome() is resolved lazily so tests can point it at a tmp dir. Absence of
 * either file means "no accounts" — exactly the pre-feature behavior.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { MailAccount, MailSecret, MailProvider } from "./types.js";

function lisaHome(): string {
  return process.env.LISA_HOME ?? path.join(os.homedir(), ".lisa");
}
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
    return JSON.parse(fs.readFileSync(p, "utf8")) as T;
  } catch {
    return fallback;
  }
}

// ── accounts ──

export function loadAccounts(): MailAccount[] {
  const list = readJson<MailAccount[]>(accountsPath(), []);
  return Array.isArray(list) ? list : [];
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
export function addAccount(input: AddAccountInput, secret: MailSecret, now: () => number = Date.now): MailAccount {
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
  const accounts = loadAccounts();
  accounts.push(account);
  saveAccounts(accounts);
  setSecret(account.id, secret);
  return account;
}

export function removeAccount(id: string): boolean {
  const accounts = loadAccounts();
  const next = accounts.filter((a) => a.id !== id);
  if (next.length === accounts.length) return false;
  saveAccounts(next);
  const secrets = readJson<Record<string, MailSecret>>(secretsPath(), {});
  delete secrets[id];
  writeSecrets(secrets);
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

// ── secrets (0600) ──

function writeSecrets(secrets: Record<string, MailSecret>): void {
  ensureDir();
  fs.writeFileSync(secretsPath(), JSON.stringify(secrets, null, 2), { mode: 0o600 });
}

export function getSecret(id: string): MailSecret | undefined {
  return readJson<Record<string, MailSecret>>(secretsPath(), {})[id];
}

export function setSecret(id: string, secret: MailSecret): void {
  const secrets = readJson<Record<string, MailSecret>>(secretsPath(), {});
  secrets[id] = { ...secrets[id], ...secret };
  writeSecrets(secrets);
}

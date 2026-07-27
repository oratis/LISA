import fs from "node:fs/promises";
import path from "node:path";
import { lisaHome } from "../../../paths.js";

export interface BlueskyAccount {
  platform: "bluesky";
  id: string;
  handle: string;
  displayName: string;
  service: string;
  accessJwt: string;
  refreshJwt: string;
}

export interface MastodonAccount {
  platform: "mastodon";
  id: string;
  handle: string;
  displayName: string;
  instance: string;
  accessToken: string;
}

export type OpenSocialAccount = BlueskyAccount | MastodonAccount;

interface AccountStore {
  version: 1;
  accounts: OpenSocialAccount[];
}

function filePath(): string {
  return path.join(lisaHome(), "sense", "social", "connector-accounts.json");
}

async function readStore(): Promise<AccountStore> {
  try {
    const parsed = JSON.parse(await fs.readFile(filePath(), "utf8")) as AccountStore;
    if (parsed.version !== 1 || !Array.isArray(parsed.accounts)) {
      throw new Error("unsupported connector account store");
    }
    return parsed;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { version: 1, accounts: [] };
    }
    throw err;
  }
}

async function writeStore(store: AccountStore): Promise<void> {
  const file = filePath();
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    await fs.writeFile(tmp, JSON.stringify(store, null, 2), {
      encoding: "utf8",
      mode: 0o600,
    });
    await fs.rename(tmp, file);
    await fs.chmod(file, 0o600);
  } finally {
    await fs.rm(tmp, { force: true }).catch(() => {});
  }
}

export async function listOpenSocialAccounts(
  platform?: OpenSocialAccount["platform"],
): Promise<OpenSocialAccount[]> {
  const accounts = (await readStore()).accounts;
  return structuredClone(
    platform ? accounts.filter((account) => account.platform === platform) : accounts,
  );
}

export async function getOpenSocialAccount(
  platform: OpenSocialAccount["platform"],
  id: string,
): Promise<OpenSocialAccount | null> {
  const account = (await readStore()).accounts.find(
    (candidate) => candidate.platform === platform && candidate.id === id,
  );
  return account ? structuredClone(account) : null;
}

export async function saveOpenSocialAccount(
  account: OpenSocialAccount,
): Promise<void> {
  const store = await readStore();
  const index = store.accounts.findIndex(
    (candidate) =>
      candidate.platform === account.platform && candidate.id === account.id,
  );
  if (index >= 0) store.accounts[index] = structuredClone(account);
  else store.accounts.push(structuredClone(account));
  await writeStore(store);
}

export async function deleteOpenSocialAccount(
  platform: OpenSocialAccount["platform"],
  id: string,
): Promise<boolean> {
  const store = await readStore();
  const before = store.accounts.length;
  store.accounts = store.accounts.filter(
    (candidate) => !(candidate.platform === platform && candidate.id === id),
  );
  if (store.accounts.length === before) return false;
  await writeStore(store);
  return true;
}

/** Redacted shape safe for the model and browser. */
export function publicAccount(account: OpenSocialAccount): Record<string, unknown> {
  return {
    id: account.id,
    platform: account.platform,
    handle: account.handle,
    displayName: account.displayName,
    ...(account.platform === "mastodon" ? { instance: account.instance } : {}),
  };
}

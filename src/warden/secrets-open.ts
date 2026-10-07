/**
 * `openSecretStore()` — pick the `SecretStore` backend for this process.
 *
 *  - cloud edition → per-tenant encrypted file under the tenant home, key
 *    derived from the server session secret + uid. `LISA_SECRETS_BACKEND` is
 *    ignored there, and a call outside a signed-in request scope is refused:
 *    the cloud edition has no operator-wide secret store.
 *  - macOS, default home → Keychain.
 *  - everything else (Linux, Windows, or a `LISA_HOME` override) → encrypted
 *    file in that home. An overridden home gets the file backend even on macOS
 *    because the Keychain is per-USER, not per-home: two homes would otherwise
 *    share one namespace, and a test or scratch home would write into the
 *    user's real login keychain.
 *
 * `LISA_SECRETS_BACKEND=file|keychain` forces the local choice.
 */
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { isCloud } from "../edition.js";
import { homeForUid, lisaHome, scopedUid } from "../paths.js";
import { loadOrCreateSessionSecret } from "../web/sessions-auth.js";
import { SecretStoreError, type SecretStore } from "./secrets.js";
import { EncryptedFileSecretStore, localKeyFile, tenantKey } from "./secrets-file.js";
import { KEYCHAIN_SERVICE, KeychainSecretStore, type SecurityRunner } from "./secrets-keychain.js";

export type SecretBackend = "keychain" | "file" | "cloud";

export interface OpenSecretStoreOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  /** Local home to use; defaults to `lisaHome()`. */
  home?: string;
  /** Cloud edition: the tenant. Defaults to the active request scope's uid. */
  uid?: string | null;
  /** Cloud edition: where the server session secret comes from. */
  sessionSecret?: () => string;
  /** Keychain backend: the `/usr/bin/security` seam (tests inject a fake). */
  runner?: SecurityRunner;
  now?: () => number;
}

/** Server-minted uids look like `em-<hex>` / `apple-<hex>` / `g-<hex>`. */
const UID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

function isDefaultHome(home: string): boolean {
  return path.resolve(home) === path.resolve(os.homedir(), ".lisa");
}

/** Which backend `openSecretStore` would use, without opening anything. */
export function selectSecretBackend(opts: OpenSecretStoreOptions = {}): SecretBackend {
  const env = opts.env ?? process.env;
  if (isCloud(env)) return "cloud";
  const platform = opts.platform ?? process.platform;
  const forced = env.LISA_SECRETS_BACKEND?.trim().toLowerCase();
  if (forced === "file") return "file";
  if (forced === "keychain") {
    if (platform !== "darwin") {
      throw new SecretStoreError("unavailable", "the Keychain backend exists only on macOS");
    }
    return "keychain";
  }
  if (forced) {
    throw new SecretStoreError("unavailable", "LISA_SECRETS_BACKEND must be 'file' or 'keychain'");
  }
  return platform === "darwin" && isDefaultHome(opts.home ?? lisaHome()) ? "keychain" : "file";
}

export function openSecretStore(opts: OpenSecretStoreOptions = {}): SecretStore {
  const backend = selectSecretBackend(opts);

  if (backend === "cloud") {
    const scoped = scopedUid();
    const uid = opts.uid ?? scoped;
    // Tenant access is decided by the authenticated scope (.codex/INVARIANTS):
    // inside a request, an explicit uid may only ever restate that scope's own.
    if (!uid || !UID_RE.test(uid) || (scoped !== null && scoped !== uid)) {
      throw new SecretStoreError(
        "unavailable",
        "the cloud secret store needs a signed-in tenant scope",
      );
    }
    return new EncryptedFileSecretStore({
      backend: "cloud",
      file: path.join(homeForUid(uid), "warden", "secrets.enc.json"),
      keys: tenantKey(opts.sessionSecret ?? loadOrCreateSessionSecret, uid),
      scope: `uid:${uid}`,
      now: opts.now,
    });
  }

  const home = opts.home ?? lisaHome();
  const dir = path.join(home, "warden");

  if (backend === "keychain") {
    // The default home owns the plain service name; any other home that was
    // forced onto the Keychain gets its own namespace so the two cannot collide.
    const service = isDefaultHome(home)
      ? KEYCHAIN_SERVICE
      : `${KEYCHAIN_SERVICE}.${crypto
          .createHash("sha256")
          .update(path.resolve(home))
          .digest("hex")
          .slice(0, 12)}`;
    return new KeychainSecretStore({
      indexFile: path.join(dir, "secrets.index.json"),
      runner: opts.runner,
      now: opts.now,
      service,
    });
  }

  return new EncryptedFileSecretStore({
    backend: "file",
    file: path.join(dir, "secrets.enc.json"),
    keys: localKeyFile(path.join(dir, "secret.key")),
    scope: "local",
    now: opts.now,
  });
}

/**
 * Per-device pairing tokens — a revocable credential per phone/tablet, layered
 * on top of the global LISA_WEB_TOKEN.
 *
 * The global token is what binds the server to a non-loopback host and what the
 * owner uses; a device token is minted per device (QR pairing) so each can be
 * revoked individually without rotating the global secret. Only the SHA-256 hash
 * of each device token is stored (`~/.lisa/devices.json`) — the raw token is
 * returned exactly once, at mint time, for the QR.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

export interface DeviceRecord {
  id: string;
  name: string;
  platform: string;
  /** SHA-256 hex of the device token — never the token itself. */
  tokenHash: string;
  createdAt: number;
  lastSeenAt: number;
}

/** Device info safe to expose over the API (no hash). */
export type PublicDevice = Omit<DeviceRecord, "tokenHash">;

function lisaHome(): string {
  return process.env.LISA_HOME ?? path.join(os.homedir(), ".lisa");
}
function devicesPath(): string {
  return path.join(lisaHome(), "devices.json");
}

function sha256hex(s: string): string {
  return crypto.createHash("sha256").update(s).digest("hex");
}

export function loadDevices(): DeviceRecord[] {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(devicesPath(), "utf8"));
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (d): d is DeviceRecord =>
        !!d && typeof (d as DeviceRecord).id === "string" && typeof (d as DeviceRecord).tokenHash === "string",
    );
  } catch {
    return [];
  }
}

function saveDevices(list: DeviceRecord[]): void {
  const file = devicesPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(list, null, 2));
}

export function toPublicDevice(d: DeviceRecord): PublicDevice {
  return { id: d.id, name: d.name, platform: d.platform, createdAt: d.createdAt, lastSeenAt: d.lastSeenAt };
}

/** Mint a device token + record. Returns the raw token ONCE (for the QR). */
export function mintDevice(
  name: string,
  platform: string,
  now: number = Date.now(),
): { id: string; token: string; device: PublicDevice } {
  const token = crypto.randomBytes(24).toString("hex");
  const id = crypto.randomBytes(6).toString("hex");
  const rec: DeviceRecord = {
    id,
    name: name.slice(0, 80) || "device",
    platform: platform.slice(0, 32) || "unknown",
    tokenHash: sha256hex(token),
    createdAt: now,
    lastSeenAt: now,
  };
  const list = loadDevices();
  list.push(rec);
  saveDevices(list);
  return { id, token, device: toPublicDevice(rec) };
}

/** Constant-time compare a presented token against a stored hash. */
function tokenMatchesHash(presented: string, hash: string): boolean {
  const a = crypto.createHash("sha256").update(presented).digest();
  let b: Buffer;
  try {
    b = Buffer.from(hash, "hex");
  } catch {
    return false;
  }
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Return the device whose token matches `presented`, or null. Does not mutate. */
export function verifyDeviceToken(presented: string): DeviceRecord | null {
  if (!presented) return null;
  for (const d of loadDevices()) {
    if (tokenMatchesHash(presented, d.tokenHash)) return d;
  }
  return null;
}

/** Update a device's lastSeenAt (best-effort). */
export function touchDevice(id: string, now: number = Date.now()): void {
  const list = loadDevices();
  const d = list.find((x) => x.id === id);
  if (!d) return;
  d.lastSeenAt = now;
  saveDevices(list);
}

export function listDevices(): PublicDevice[] {
  return loadDevices().map(toPublicDevice);
}

/** Remove a device by id. Returns true if one was removed. */
export function revokeDevice(id: string): boolean {
  const list = loadDevices();
  const next = list.filter((d) => d.id !== id);
  if (next.length === list.length) return false;
  saveDevices(next);
  return true;
}

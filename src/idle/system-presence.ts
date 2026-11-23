import { execFile } from "node:child_process";
import { promisify } from "node:util";

const pexec = promisify(execFile);
const PROBE_TIMEOUT_MS = 2_000;
const PROBE_MAX_BUFFER = 256 * 1024;

export interface SystemPresence {
  /** False off-macOS, when disabled, or if system probes failed/unavailable. */
  available: boolean;
  /** Milliseconds since the last hardware HID event (keyboard/mouse/trackpad). */
  idleMs?: number;
  /** True when the macOS console / login screen is locked. */
  locked?: boolean;
}

export type SystemPresenceProbe = () => Promise<SystemPresence>;

/**
 * Parse `HIDIdleTime` from `ioreg -c IOHIDSystem -r -d1` output.
 * macOS reports nanoseconds as decimal or hex (`0x...`). Returns whole ms.
 */
export function parseHidIdleMs(stdout: string): number | undefined {
  const m = stdout.match(/"HIDIdleTime"\s*=\s*(0x[0-9a-fA-F]+|\d+)/);
  if (!m?.[1]) return undefined;
  try {
    const ns = BigInt(m[1]);
    if (ns < 0n) return undefined;
    const ms = Number(ns / 1_000_000n);
    return Number.isSafeInteger(ms) ? ms : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Parse console/screen lock state from `ioreg -n Root -d1 -k IOConsoleLocked`
 * output. Supports both `IOConsoleLocked` and `CGSSessionScreenIsLocked`.
 */
export function parseConsoleLocked(stdout: string): boolean | undefined {
  for (const key of ["IOConsoleLocked", "CGSSessionScreenIsLocked"]) {
    const m = stdout.match(new RegExp(`"?${key}"?\\s*=\\s*(Yes|No|true|false|1|0)`, "i"));
    if (m?.[1]) {
      const val = m[1].toLowerCase();
      return val === "yes" || val === "true" || val === "1";
    }
  }
  return undefined;
}

/**
 * Default macOS system presence probe (Sense S2 / PLAN_SENSE §3). Reads hardware
 * HID idle time and console lock state without touching user content or files.
 * Returns `{ available: false }` off-darwin, when disabled, or on any failure.
 */
export const defaultSystemPresenceProbe: SystemPresenceProbe = async () => {
  if (process.platform !== "darwin" || process.env.LISA_DISABLE_SYSTEM_PRESENCE === "1") {
    return { available: false };
  }
  try {
    const [hidRes, lockRes] = await Promise.all([
      pexec("ioreg", ["-c", "IOHIDSystem", "-r", "-d1"], {
        timeout: PROBE_TIMEOUT_MS,
        maxBuffer: PROBE_MAX_BUFFER,
      }),
      pexec("ioreg", ["-n", "Root", "-d1", "-k", "IOConsoleLocked"], {
        timeout: PROBE_TIMEOUT_MS,
        maxBuffer: PROBE_MAX_BUFFER,
      }).catch(() => ({ stdout: "" })),
    ]);

    const idleMs = parseHidIdleMs(hidRes.stdout);
    const locked = parseConsoleLocked(lockRes.stdout);
    if (idleMs === undefined && locked === undefined) {
      return { available: false };
    }
    return {
      available: true,
      ...(idleMs !== undefined ? { idleMs } : {}),
      ...(locked !== undefined ? { locked } : {}),
    };
  } catch {
    return { available: false };
  }
};

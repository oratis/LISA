/**
 * Sandbox modes (H2 — docs/PLAN_HARNESS_ALIGNMENT_v1.0.md §3).
 *
 * Three modes, named after dsh's rather than inventing a vocabulary. They are a
 * property of the *execution world*, so both the filesystem and the shell
 * provider read the same one — the old arrangement, where `bash` was confined
 * to cwd while `write` could reach the whole disk, is exactly what a single
 * shared mode makes impossible to express.
 *
 * Enforcement is split by what each layer can actually guarantee:
 *
 *  - filesystem — enforced in-process at `resolvePath`, so it works on every
 *    platform with no external dependency;
 *  - shell — enforced by the OS (Seatbelt on macOS, bubblewrap on Linux). When
 *    no mechanism is available the request FAILS rather than silently running
 *    unconfined. "Thinking the sandbox is on when it is off" is worse than
 *    knowing there is none.
 */

export type SandboxMode = "read-only" | "workspace-write" | "danger-full-access";

export const SANDBOX_MODES: readonly SandboxMode[] = [
  "read-only",
  "workspace-write",
  "danger-full-access",
];

export function isSandboxMode(v: unknown): v is SandboxMode {
  return typeof v === "string" && (SANDBOX_MODES as readonly string[]).includes(v);
}

/**
 * Thrown when a mode asks for confinement the host cannot enforce. Carries a
 * stable `code` so callers can distinguish "refused on purpose" from a random
 * spawn failure.
 */
export class SandboxUnavailableError extends Error {
  readonly code = "SANDBOX_UNAVAILABLE";
  constructor(message: string) {
    super(message);
    this.name = "SandboxUnavailableError";
  }
}

/**
 * Resolve the mode for a new execution world.
 *
 * Precedence: explicit argument > `LISA_SANDBOX_MODE` > legacy `LISA_SANDBOX=1`
 * > `danger-full-access`.
 *
 * The default is deliberately unchanged from before H2: an attended local REPL
 * is the same trust posture as typing into a shell, and silently confining
 * everyone's existing setup is not this change's job. What H2 fixes is that
 * turning the sandbox ON now actually bounds file writes too. Tightening the
 * default for *unattended* surfaces (dispatch, idle, channels) is a separate,
 * behaviour-changing step — see the plan's §3 table.
 */
export function resolveSandboxMode(explicit?: SandboxMode): SandboxMode {
  if (explicit) return explicit;
  const named = process.env.LISA_SANDBOX_MODE;
  if (named) {
    if (!isSandboxMode(named)) {
      throw new Error(
        `bad LISA_SANDBOX_MODE "${named}" — expected one of ${SANDBOX_MODES.join(" | ")}`,
      );
    }
    return named;
  }
  const legacy = process.env.LISA_SANDBOX;
  if (legacy === "1" || legacy === "true") return "workspace-write";
  return "danger-full-access";
}

/** Does this mode allow writing at all? */
export function modeAllowsWrites(mode: SandboxMode): boolean {
  return mode !== "read-only";
}

/** Does this mode bound where reads and writes may land? */
export function modeIsBounded(mode: SandboxMode): boolean {
  return mode !== "danger-full-access";
}

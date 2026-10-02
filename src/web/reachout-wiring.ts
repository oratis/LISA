/**
 * How the web server talks to the reach-out gate. Kept out of server.ts so the
 * wiring — which channel is available to whom — is unit-testable without
 * booting a server (see reachout-wiring.test.ts, which proves each pre-gate
 * sender still delivers under default settings).
 */
import { scopedUid } from "../paths.js";
import { hasReachOutImHook } from "../reachout/deliver.js";
import type { DeferQueue } from "../reachout/defer.js";
import { reachOut } from "../reachout/gate.js";
import type { ReachOutNotice, ReachOutResult, ReachOutTransports } from "../reachout/types.js";
import type { ReachOutApiOptions } from "./reachout-api.js";

export {
  advisorNotice,
  idleNoteNotice,
  kbBriefNotice,
  mailAlertNotice,
  mailDigestNotice,
} from "../reachout/senders.js";

/** The slice of PushBridge the wiring needs. */
export interface PushPresence {
  hasSubscribers(): boolean;
}

export type ServerReachOut = (
  notice: ReachOutNotice,
  transports: Pick<ReachOutTransports, "inapp" | "push">,
  available?: { inapp?: boolean },
) => Promise<ReachOutResult>;

/**
 * Build the server's `reachOut` wrapper.
 *
 *  - The notice is pinned to the home scope it was raised in (`scopedUid()`),
 *    so a notice raised inside a signed-in cloud request is decided against
 *    that account's settings and never another's.
 *  - Push is machine-level (one PushBridge for whoever owns the host): it is
 *    only available to the operator scope, and only when a device is actually
 *    subscribed — so the ledger never records a push nobody could receive and
 *    no budget is spent on one.
 *  - `available.inapp: false` is for senders whose result is already on the
 *    user's screen (a manual "sweep now"), exactly as before the gate.
 */
export function makeServerReachOut(opts: {
  pushBridge: PushPresence;
  log?: (message: string) => void;
  now?: () => Date;
  deferQueue?: DeferQueue;
}): ServerReachOut {
  return (notice, transports, available = {}) => {
    const uid = scopedUid();
    return reachOut(
      { ...notice, uid },
      {
        transports,
        available: {
          inapp: available.inapp !== false,
          push: uid === null && opts.pushBridge.hasSubscribers(),
          im: false,
        },
        log: opts.log,
        now: opts.now,
        deferQueue: opts.deferQueue,
      },
    );
  };
}

/** Options for `/api/reachout/*`: what this caller can physically receive. */
export function reachOutApiOptions(cloud: boolean): ReachOutApiOptions {
  return {
    // A cloud tenant never owns the machine-level push channel.
    pushAvailable: !cloud && scopedUid() === null,
    imAvailable: hasReachOutImHook(),
  };
}

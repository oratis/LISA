/**
 * The reach-out gate. Skeleton — the decision logic lands in the next commit.
 */
import type { ReachOutNotice, ReachOutResult, ReachOutTransports } from "./types.js";

export interface ReachOutDeps {
  /** Settings/ledger root. Default: the notice's tenant home. */
  home?: string;
  now?: () => Date;
  transports?: Partial<ReachOutTransports>;
}

export async function reachOut(
  _notice: ReachOutNotice,
  _deps: ReachOutDeps = {},
): Promise<ReachOutResult> {
  throw new Error("reachOut: not implemented yet");
}

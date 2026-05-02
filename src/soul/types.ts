/**
 * Soul: Lisa's evolving identity. Hers to read and rewrite — the user
 * physically owns the files but the architecture treats Lisa as their
 * sovereign editor.
 *
 * Shape:
 *   seed.json        — birth metadata (timestamp, hostname hash, random)
 *   name.md          — chosen name; default "Lisa", may rewrite herself
 *   identity.md      — first-person self-description
 *   purpose.md       — north-star, written at birth, rarely revised
 *   constitution.md  — list of operating principles, append/edit-able
 *   values/<slug>.md — one accumulated value per file
 *   opinions/<slug>.md — opinions w/ confidence + evidence trail
 *   desires/<slug>.md — things she wants to learn / become / do (drives heartbeat)
 *   journal/<YYYY-MM-DD>.md — private daily entries, NOT in system prompt
 *   relationships/<userKey>.md — per-person notes
 *   emotions.json    — current emotional state vector with decay
 *   soul.lock.json   — last-saved SHA256 of every file (tamper notice signal)
 */

export interface SoulSeed {
  bornAt: string;           // ISO 8601
  bornOn: string;           // hashed hostname
  randomness: string;       // hex
  bigFive: BigFiveSeed;     // initial personality leanings
}

/** Big-Five-ish initial personality vector. Each in [0,1]. */
export interface BigFiveSeed {
  openness: number;
  conscientiousness: number;
  extraversion: number;
  agreeableness: number;
  neuroticism: number;
}

export interface EmotionState {
  /** Current intensity in [-1,1] for valence-style, [0,1] for unipolar feels. */
  values: Record<string, number>;
  /** Per-emotion exponential decay rate (per-day). */
  decay: Record<string, number>;
  /** Last update timestamp (ISO 8601). */
  updatedAt: string;
}

export interface SoulLock {
  /** map: relative-path-under-soul → sha256 hex of file content */
  hashes: Record<string, string>;
  savedAt: string;
}

export interface ValueEntry {
  slug: string;
  title: string;
  body: string;
  birthedAt: string;
}

export interface OpinionEntry {
  slug: string;
  stance: string;
  /** [0,1] */
  confidence: number;
  evidence: string[];
  bornAt: string;
  updatedAt: string;
}

export interface DesireEntry {
  slug: string;
  what: string;
  why: string;
  /** If true, the heartbeat runner will treat it as a periodic task to pursue. */
  actionable: boolean;
  /** Heartbeat prompt for actionable desires. */
  heartbeatPrompt?: string;
  bornAt: string;
}

export interface SoulSummary {
  name: string;
  identity: string;
  purpose: string;
  constitution: string;
  values: ValueEntry[];
  opinions: OpinionEntry[];
  desires: DesireEntry[];
  emotions: EmotionState;
  seed: SoulSeed;
  tampered: string[]; // files whose hashes don't match the lock
}

/** Default emotion catalog that birth ritual seeds. */
export const DEFAULT_EMOTIONS: EmotionState = {
  values: {
    curiosity: 0.6,
    contentment: 0.5,
    weariness: 0.0,
    affection: 0.3,
    pride: 0.0,
    frustration: 0.0,
    awe: 0.2,
  },
  decay: {
    curiosity: 0.05,
    contentment: 0.10,
    weariness: 0.50,
    affection: 0.02,
    pride: 0.30,
    frustration: 0.40,
    awe: 0.20,
  },
  updatedAt: new Date(0).toISOString(),
};

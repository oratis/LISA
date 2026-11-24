/**
 * Local telemetry event schema, bucket helpers, and fail-closed policy table
 * (docs/analytics-plan-2026-08-21.md §3).
 *
 * Design invariants:
 *  - Zero raw `string` properties anywhere in `TelemetryEvent` — only closed
 *    literal enums, `boolean`, and pure bucket helper outputs (`msBucket`,
 *    `tokBucket`, `dayBucket`, `countBucket`, `rateBucket`).
 *  - Fail-closed policy & property-spec maps (`Record<TelemetryEventName, ...>`):
 *    adding a union member without declaring its policy and property validator
 *    is a compile-time error.
 *  - Runtime sanitization strips any undeclared keys and rejects unknown event
 *    names, wrong editions, or out-of-enum property values.
 */

import {
  SUGGESTION_CATEGORIES,
  type SuggestedAction,
  type SuggestionCategory,
  type Urgency,
} from "../advisor/types.js";
import type { AutonomyKind, AutonomyOutcome } from "../autonomy/runs.js";
import type { QuotaTier } from "../billing/quota.js";
import type { ParsedArgs } from "../cli-args.js";
import { CONNECTOR_CATALOG, type ConnectorProvider } from "../connectors/catalog.js";
import type { Edition } from "../edition.js";
import type { PlanId } from "../model/plans.js";
import type { TaskKind } from "../tasks/types.js";
import type { DispatchAgentKind } from "../tools/dispatch_agent.js";
import {
  ACTION_CATEGORIES,
  GRANT_SCOPES,
  type ActionCategory,
  type GrantScope,
} from "../warden/types.js";
import type { AccountKind } from "../web/accounts.js";

// ── Bucket helpers (pure, bounded outputs) ───────────────────────────────────

export const MS_BUCKETS = ["<1s", "1-5s", "5-30s", "30s-2m", "2-10m", "10-60m", ">1h"] as const;
export type MsBucket = (typeof MS_BUCKETS)[number];

export const TOK_BUCKETS = ["<1k", "1-5k", "5-20k", "20-100k", "100k+"] as const;
export type TokBucket = (typeof TOK_BUCKETS)[number];

export const DAY_BUCKETS = ["0", "1", "2-6", "7-29", "30-89", "90+"] as const;
export type DayBucket = (typeof DAY_BUCKETS)[number];

export const COUNT_BUCKETS = ["0", "1", "2-3", "4-9", "10-29", "30-99", "100+"] as const;
export type CountBucket = (typeof COUNT_BUCKETS)[number];

export const RATE_BUCKETS = ["0", "1-25%", "26-50%", "51-75%", "76-99%", "100%"] as const;
export type RateBucket = (typeof RATE_BUCKETS)[number];

/** Bucket a millisecond duration into 7 coarse bands (never returns undefined). */
export function msBucket(ms: number): MsBucket {
  if (!Number.isFinite(ms)) return ms === Infinity ? ">1h" : "<1s";
  if (ms < 1_000) return "<1s";
  if (ms < 5_000) return "1-5s";
  if (ms < 30_000) return "5-30s";
  if (ms < 120_000) return "30s-2m";
  if (ms < 600_000) return "2-10m";
  if (ms < 3_600_000) return "10-60m";
  return ">1h";
}

/** Bucket a token total into 5 coarse bands (never returns undefined). */
export function tokBucket(tokens: number): TokBucket {
  if (!Number.isFinite(tokens)) return tokens === Infinity ? "100k+" : "<1k";
  if (tokens < 1_000) return "<1k";
  if (tokens < 5_000) return "1-5k";
  if (tokens < 20_000) return "5-20k";
  if (tokens < 100_000) return "20-100k";
  return "100k+";
}

/** Bucket an age in days into 6 coarse bands (never returns undefined). */
export function dayBucket(days: number): DayBucket {
  if (!Number.isFinite(days)) return days === Infinity ? "90+" : "0";
  if (days < 1) return "0";
  const d = Math.floor(days);
  if (d === 1) return "1";
  if (d <= 6) return "2-6";
  if (d <= 29) return "7-29";
  if (d <= 89) return "30-89";
  return "90+";
}

/** Bucket a discrete count into 7 coarse bands (never returns undefined). */
export function countBucket(count: number): CountBucket {
  if (!Number.isFinite(count)) return count === Infinity ? "100+" : "0";
  const n = Math.floor(count);
  if (n <= 0) return "0";
  if (n === 1) return "1";
  if (n <= 3) return "2-3";
  if (n <= 9) return "4-9";
  if (n <= 29) return "10-29";
  if (n <= 99) return "30-99";
  return "100+";
}

/** Bucket a ratio in [0, 1] into 6 percentage bands (never returns undefined). */
export function rateBucket(ratio: number): RateBucket {
  if (!Number.isFinite(ratio)) return ratio === Infinity ? "100%" : "0";
  if (ratio <= 0) return "0";
  if (ratio <= 0.25) return "1-25%";
  if (ratio <= 0.5) return "26-50%";
  if (ratio <= 0.75) return "51-75%";
  if (ratio < 1) return "76-99%";
  return "100%";
}

// ── Closed enum vocabularies ─────────────────────────────────────────────────

export const EMITTERS = ["core", "web-ui", "native", "channel"] as const;
export type Emitter = (typeof EMITTERS)[number];

export const INGRESS_MODES = ["internal", "ingress"] as const;
export type Ingress = (typeof INGRESS_MODES)[number];

export const UPLOAD_MODES = ["never", "counter", "event"] as const;
export type Upload = (typeof UPLOAD_MODES)[number];

export const SURFACES = ["cli", "web", "island", "ios", "mac", "channel", "autonomous"] as const;
export type Surface = (typeof SURFACES)[number];

export const VIEWS = [
  "chat",
  "dashboard",
  "control",
  "reve",
  "room",
  "sense",
  "memory",
  "kb",
  "settings",
] as const;
export type View = (typeof VIEWS)[number];

export const PROVIDER_FAMILIES = [
  "anthropic",
  "openai",
  "google",
  "local",
  "openai-compatible",
  "other",
] as const;
export type ProviderFamily = (typeof PROVIDER_FAMILIES)[number];

export const SESSION_END_REASONS = ["exit", "eof", "signal", "error", "timeout"] as const;
export type SessionEndReason = (typeof SESSION_END_REASONS)[number];

export const TURN_STOP_REASONS = [
  "end",
  "tool_use",
  "max_tokens",
  "error",
  "budget_exceeded",
] as const;
export type TurnStopReason = (typeof TURN_STOP_REASONS)[number];

export const PLATFORM_KINDS = ["darwin", "linux", "win32", "other"] as const;
export type PlatformKind = (typeof PLATFORM_KINDS)[number];

export const TASK_RUN_OUTCOMES = [
  "succeeded",
  "failed",
  "cancelled",
  "timeout",
  "skipped",
] as const;
export type TaskRunOutcome = (typeof TASK_RUN_OUTCOMES)[number];

export const APPROVAL_DECISION_KINDS = [
  "approved",
  "denied",
  "expired",
  "dismissed",
  "cancelled",
  "auto",
  "handoff",
] as const;
export type ApprovalDecisionKind = (typeof APPROVAL_DECISION_KINDS)[number];

export const CONNECTOR_AUTH_MODES = [
  "existing",
  "login",
  "freebusy",
  "events",
  "import",
  "other",
] as const;
export type ConnectorAuthMode = (typeof CONNECTOR_AUTH_MODES)[number];

export const IDLE_ENGAGED_ACTIONS = ["opened_log", "replied", "dismissed", "expired"] as const;
export type IdleEngagedAction = (typeof IDLE_ENGAGED_ACTIONS)[number];

export const IDLE_DISABLE_VIAS = ["flag", "config", "ui"] as const;
export type IdleDisableVia = (typeof IDLE_DISABLE_VIAS)[number];

export const OBSERVER_NAMES = [
  "claude-code",
  "codex",
  "opencode",
  "aider",
  "cursor",
  "gemini-cli",
  "github-pr",
  "git",
  "shell",
  "takoapi",
  "managed",
  "pty",
] as const;
export type ObserverName = (typeof OBSERVER_NAMES)[number];

export const PLAN_RUN_OUTCOMES = [
  "no_plan_selected",
  "unknown_plan",
  "cli_missing",
  "not_logged_in",
  "cwd_conflict",
  "launched",
] as const;
export type PlanRunOutcome = (typeof PLAN_RUN_OUTCOMES)[number];

export const FINISHED_OUTCOMES = ["done", "error", "cancelled"] as const;
export const DISPATCH_OUTCOMES = ["done", "error", "cancelled", "signalled"] as const;
export const CREDIT_PACK_IDS = ["5", "10", "20"] as const;
export type CreditPackId = (typeof CREDIT_PACK_IDS)[number];

export const PAYMENT_RAILS = ["stripe", "iap"] as const;
export const PREMIUM_BLOCK_REASONS = ["premium_requires_balance"] as const;

export type CliCommand = NonNullable<ParsedArgs["subcommand"]> | "repl";

export const SLASH_COMMANDS = [
  "exit",
  "quit",
  "help",
  "skills",
  "memory",
  "sessions",
  "search",
  "reflect",
  "think",
  "clear",
  "save",
  "plugin",
  "unknown",
] as const;
export type SlashCommand = (typeof SLASH_COMMANDS)[number];

export const CHANNEL_NAMES = [
  "imessage",
  "telegram",
  "discord",
  "slack",
  "feishu",
  "webhook",
] as const;
export type ChannelName = (typeof CHANNEL_NAMES)[number];

export const CHANNEL_DIRECTIONS = ["in", "out"] as const;

export const CLI_FLAGS = [
  "model",
  "approval",
  "think",
  "idle",
  "no-reflect",
  "voice",
  "compaction",
  "no-mcp",
  "no-plugins",
] as const;
export type CliFlag = (typeof CLI_FLAGS)[number];

export const TELEMETRY_CONSENT_SIGNALS = [
  "screen",
  "voice",
  "clipboard",
  "selection",
  "mail",
  "telemetry",
] as const;
export type TelemetryConsentSignal = (typeof TELEMETRY_CONSENT_SIGNALS)[number];

export const CONSENT_CONTEXTS = ["cli", "web", "first_use"] as const;

export const SINK_NAMES = ["ledger", "upload"] as const;
export const SINK_FAILURE_CODES = [
  "enospc",
  "eacces",
  "emfile",
  "network",
  "http_4xx",
  "http_5xx",
  "timeout",
  "other",
] as const;
export type SinkFailureCode = (typeof SINK_FAILURE_CODES)[number];

// Compile-time exhaustive runtime tuple derivation for imported union types.
function keysOfExhaustive<T extends string>(map: Readonly<Record<T, true>>): readonly T[] {
  return Object.keys(map) as T[];
}

export const EDITIONS = keysOfExhaustive<Edition>({ mac: true, cloud: true });
export const AUTONOMY_KINDS = keysOfExhaustive<AutonomyKind>({
  idle: true,
  heartbeat: true,
  examen: true,
  desire: true,
  "desire-review": true,
  reflect: true,
});
export const AUTONOMY_OUTCOMES = keysOfExhaustive<AutonomyOutcome>({
  done: true,
  "no-update": true,
  blocked: true,
  error: true,
});
export const URGENCIES = keysOfExhaustive<Urgency>({ info: true, notice: true, urgent: true });
export const ACTION_KINDS = keysOfExhaustive<SuggestedAction["kind"]>({
  approve: true,
  cancel: true,
  open: true,
  serialize: true,
  look: true,
  dispatch: true,
});
export const PLAN_IDS = keysOfExhaustive<PlanId>({ claude: true, codex: true, copilot: true });
export const PLAN_OR_NONE = [...PLAN_IDS, "none"] as const;
export const DISPATCH_AGENT_KINDS = keysOfExhaustive<DispatchAgentKind>({
  claude: true,
  codex: true,
  opencode: true,
  aider: true,
  cursor: true,
  gemini: true,
  copilot: true,
});
export const QUOTA_TIERS = keysOfExhaustive<QuotaTier>({
  free: true,
  "free-unverified": true,
  tier1: true,
  tier2: true,
});
export const ACCOUNT_KINDS = keysOfExhaustive<AccountKind>({
  apple: true,
  email: true,
  google: true,
});
export const TASK_KINDS = keysOfExhaustive<TaskKind>({
  oneoff: true,
  routine: true,
  watcher: true,
  goal: true,
});
export const CLI_COMMANDS = keysOfExhaustive<CliCommand>({
  resume: true,
  sessions: true,
  serve: true,
  heartbeat: true,
  autostart: true,
  search: true,
  birth: true,
  soul: true,
  channels: true,
  skills: true,
  wishlist: true,
  status: true,
  doctor: true,
  monitor: true,
  autonomy: true,
  model: true,
  consent: true,
  reachout: true,
  sense: true,
  agents: true,
  pair: true,
  mail: true,
  kb: true,
  secret: true,
  login: true,
  logout: true,
  billing: true,
  upgrade: true,
  tasks: true,
  approvals: true,
  warden: true,
  reve: true,
  telemetry: true,
  mcp: true,
  recipes: true,
  forget: true,
  export: true,
  import: true,
  repl: true,
});
export const CONNECTOR_PROVIDERS: readonly ConnectorProvider[] = CONNECTOR_CATALOG.map(
  (entry) => entry.id,
);

// ── Normalizers (prevent free-text strings from entering closed enums) ───────

const BUILTIN_SLASH_SET = new Set<string>(
  SLASH_COMMANDS.filter((cmd) => cmd !== "plugin" && cmd !== "unknown"),
);

/** Collapse built-in slash commands cleanly while folding plugin/unknown names. */
export function normalizeSlashCommand(cmd: string, isPluginCommand = false): SlashCommand {
  if (isPluginCommand) return "plugin";
  const normalized = cmd.trim().toLowerCase().replace(/^\//, "");
  return BUILTIN_SLASH_SET.has(normalized) ? (normalized as SlashCommand) : "unknown";
}

/** Normalize `process.platform` into the closed `PlatformKind` enum. */
export function normalizePlatform(platform: string = process.platform): PlatformKind {
  if (platform === "darwin" || platform === "linux" || platform === "win32") return platform;
  return "other";
}

/** Collapse arbitrary model/preset names into coarse `ProviderFamily` bands. */
export function normalizeProviderFamily(provider: string): ProviderFamily {
  const lower = provider.trim().toLowerCase();
  if (lower === "anthropic" || lower.startsWith("claude")) return "anthropic";
  if (lower === "openai" || lower.startsWith("gpt-") || /^o[134]($|-)/.test(lower)) {
    return "openai";
  }
  if (lower === "google" || lower === "gemini" || lower.startsWith("gemini-")) return "google";
  if (lower === "local" || lower.startsWith("local://") || lower.includes("ollama")) {
    return "local";
  }
  if (lower === "openai-compatible") return "openai-compatible";
  return "other";
}

// ── Discriminated union of all allowed telemetry events ──────────────────────

export type TelemetryEvent =
  // Q1: Lifecycle & Usage
  | { name: "birth_started"; properties: { provider: ProviderFamily } }
  | {
      name: "birth_completed";
      properties: {
        durationMs: MsBucket;
        provider: ProviderFamily;
        tokens: TokBucket;
        retried: boolean;
      };
    }
  | {
      name: "session_started";
      properties: { surface: Surface; resumed: boolean; sinceBirth: DayBucket };
    }
  | {
      name: "session_ended";
      properties: {
        surface: Surface;
        turns: CountBucket;
        durationMs: MsBucket;
        reason: SessionEndReason;
      };
    }
  | {
      name: "turn_completed";
      properties: {
        surface: Surface;
        tokens: TokBucket;
        toolCalls: CountBucket;
        provider: ProviderFamily;
        stopReason: TurnStopReason;
      };
    }
  | {
      name: "install_daily_ping";
      properties: {
        platform: PlatformKind;
        sinceBirth: DayBucket;
        edition: Edition;
        homeIsDefault: boolean;
      };
    }
  // Q2: Autonomy
  | {
      name: "autonomy_run_recorded";
      properties: {
        kind: AutonomyKind;
        outcome: AutonomyOutcome;
        durationMs: MsBucket;
        tokens: TokBucket;
        toolCalls: CountBucket;
      };
    }
  | {
      name: "desire_inventory_snapshot";
      properties: {
        open: CountBucket;
        actionable: CountBucket;
        needsUser: CountBucket;
        closed7d: CountBucket;
        tampered: boolean;
      };
    }
  | {
      name: "token_budget_blocked";
      properties: { kind: AutonomyKind; budget: TokBucket };
    }
  // Tasks, Warden Approvals & Connectors
  | {
      name: "task_created";
      properties: {
        kind: TaskKind;
        hasSchedule: boolean;
        hasTrigger: boolean;
        hasEnvelope: boolean;
      };
    }
  | {
      name: "task_run_finished";
      properties: {
        kind: TaskKind;
        outcome: TaskRunOutcome;
        durationMs: MsBucket;
        tokens: TokBucket;
      };
    }
  | {
      name: "approval_decided";
      properties: {
        category: ActionCategory;
        verdict: ApprovalDecisionKind;
        scope?: GrantScope;
        surface: Surface;
        tainted: boolean;
      };
    }
  | {
      name: "connector_authorized";
      properties: {
        provider: ConnectorProvider;
        authMode: ConnectorAuthMode;
        ok: boolean;
      };
    }
  // Q3: Idle / Reve Cards
  | { name: "idle_card_surfaced"; properties: { surface: Surface } }
  | {
      name: "idle_card_engaged";
      properties: { action: IdleEngagedAction; latencyMs: MsBucket };
    }
  | {
      name: "idle_disabled";
      properties: {
        via: IdleDisableVia;
        sinceBirth: DayBucket;
        priorSurfaced: CountBucket;
      };
    }
  // Q4: Advisor
  | {
      name: "advisor_card_surfaced";
      properties: {
        category: SuggestionCategory;
        urgency: Urgency;
        actionKind?: SuggestedAction["kind"];
      };
    }
  | {
      name: "advisor_card_acted";
      properties: { category: SuggestionCategory; actionKind: SuggestedAction["kind"] };
    }
  | {
      name: "advisor_card_dismissed";
      properties: { category: SuggestionCategory; categoryDismissals: CountBucket };
    }
  // Q5: Observers
  | {
      name: "observer_scan_completed";
      properties: {
        observer: ObserverName;
        found: CountBucket;
        withActivity: CountBucket;
        parseErrors: CountBucket;
        scanMs: MsBucket;
      };
    }
  | {
      name: "observer_enabled_changed";
      properties: { observer: ObserverName; enabled: boolean };
    }
  // Q6: Coding Plans & Dispatch
  | { name: "plan_selected"; properties: { plan: PlanId | "none" } }
  | {
      name: "plan_run_attempted";
      properties: { plan: PlanId | "none"; outcome: PlanRunOutcome };
    }
  | {
      name: "plan_run_finished";
      properties: {
        plan: PlanId;
        outcome: (typeof FINISHED_OUTCOMES)[number];
        durationMs: MsBucket;
      };
    }
  | {
      name: "dispatch_agent_finished";
      properties: {
        agent: DispatchAgentKind;
        outcome: (typeof DISPATCH_OUTCOMES)[number];
        durationMs: MsBucket;
      };
    }
  // Q7: Cloud Quota & Billing (server-authoritative, cloud-only)
  | { name: "free_window_opened"; properties: { tier: QuotaTier } }
  | {
      name: "free_window_exhausted";
      properties: { tier: QuotaTier; hoursIn: MsBucket; turns: CountBucket };
    }
  | {
      name: "premium_model_blocked";
      properties: { tier: QuotaTier; reason: (typeof PREMIUM_BLOCK_REASONS)[number] };
    }
  | {
      name: "credit_pack_purchased";
      properties: {
        rail: (typeof PAYMENT_RAILS)[number];
        pack: CreditPackId;
        sinceExhaust: MsBucket;
      };
    }
  | {
      name: "account_created";
      properties: { kind: AccountKind; verified: boolean };
    }
  // Q8: Surfaces & CLI
  | {
      name: "surface_opened";
      properties: { surface: Surface; view: View; first: boolean };
    }
  | {
      name: "cli_command_run";
      properties: { command: CliCommand; ok: boolean; durationMs: MsBucket };
    }
  | { name: "repl_slash_command"; properties: { command: SlashCommand } }
  | {
      name: "channel_routed";
      properties: { channel: ChannelName; direction: (typeof CHANNEL_DIRECTIONS)[number] };
    }
  | { name: "cli_flag_used"; properties: { flag: CliFlag } }
  // Q9: Consent & Sense
  | {
      name: "consent_prompt_shown";
      properties: {
        signal: TelemetryConsentSignal;
        context: (typeof CONSENT_CONTEXTS)[number];
      };
    }
  | {
      name: "consent_changed";
      properties: {
        signal: TelemetryConsentSignal;
        granted: boolean;
        sinceBirth: DayBucket;
        priorGrants: CountBucket;
      };
    }
  | { name: "sense_signal_captured"; properties: { signal: TelemetryConsentSignal } }
  // Self-monitoring (always local-only)
  | {
      name: "telemetry_sink_failed";
      properties: { sink: (typeof SINK_NAMES)[number]; code: SinkFailureCode };
    };

export type TelemetryEventName = TelemetryEvent["name"];

export interface EventPolicy {
  emitter: Emitter;
  ingress: Ingress;
  upload: Upload;
  editions: readonly Edition[];
}

/**
 * Fail-closed declaration table: every event in `TelemetryEvent` must have an
 * explicit entry here. No index signature, no defaults.
 */
export const EVENT_POLICY: Readonly<Record<TelemetryEventName, EventPolicy>> = {
  birth_started: { emitter: "core", ingress: "internal", upload: "counter", editions: ["mac"] },
  birth_completed: { emitter: "core", ingress: "internal", upload: "event", editions: ["mac"] },
  session_started: {
    emitter: "core",
    ingress: "internal",
    upload: "event",
    editions: ["mac", "cloud"],
  },
  session_ended: {
    emitter: "core",
    ingress: "internal",
    upload: "event",
    editions: ["mac", "cloud"],
  },
  turn_completed: {
    emitter: "core",
    ingress: "internal",
    upload: "event",
    editions: ["mac", "cloud"],
  },
  install_daily_ping: {
    emitter: "core",
    ingress: "internal",
    upload: "event",
    editions: ["mac", "cloud"],
  },
  autonomy_run_recorded: {
    emitter: "core",
    ingress: "internal",
    upload: "event",
    editions: ["mac", "cloud"],
  },
  desire_inventory_snapshot: {
    emitter: "core",
    ingress: "internal",
    upload: "never",
    editions: ["mac", "cloud"],
  },
  token_budget_blocked: {
    emitter: "core",
    ingress: "internal",
    upload: "event",
    editions: ["mac", "cloud"],
  },
  task_created: {
    emitter: "core",
    ingress: "internal",
    upload: "event",
    editions: ["mac", "cloud"],
  },
  task_run_finished: {
    emitter: "core",
    ingress: "internal",
    upload: "event",
    editions: ["mac", "cloud"],
  },
  approval_decided: {
    emitter: "core",
    ingress: "internal",
    upload: "event",
    editions: ["mac", "cloud"],
  },
  connector_authorized: {
    emitter: "core",
    ingress: "internal",
    upload: "event",
    editions: ["mac", "cloud"],
  },
  idle_card_surfaced: {
    emitter: "core",
    ingress: "internal",
    upload: "counter",
    editions: ["mac", "cloud"],
  },
  idle_card_engaged: {
    emitter: "web-ui",
    ingress: "ingress",
    upload: "event",
    editions: ["mac", "cloud"],
  },
  idle_disabled: {
    emitter: "core",
    ingress: "internal",
    upload: "event",
    editions: ["mac", "cloud"],
  },
  advisor_card_surfaced: {
    emitter: "core",
    ingress: "internal",
    upload: "event",
    editions: ["mac", "cloud"],
  },
  advisor_card_acted: {
    emitter: "web-ui",
    ingress: "ingress",
    upload: "event",
    editions: ["mac", "cloud"],
  },
  advisor_card_dismissed: {
    emitter: "core",
    ingress: "internal",
    upload: "event",
    editions: ["mac", "cloud"],
  },
  observer_scan_completed: {
    emitter: "core",
    ingress: "internal",
    upload: "event",
    editions: ["mac"],
  },
  observer_enabled_changed: {
    emitter: "core",
    ingress: "internal",
    upload: "event",
    editions: ["mac"],
  },
  plan_selected: { emitter: "core", ingress: "internal", upload: "event", editions: ["mac"] },
  plan_run_attempted: { emitter: "core", ingress: "internal", upload: "event", editions: ["mac"] },
  plan_run_finished: { emitter: "core", ingress: "internal", upload: "event", editions: ["mac"] },
  dispatch_agent_finished: {
    emitter: "core",
    ingress: "internal",
    upload: "event",
    editions: ["mac"],
  },
  free_window_opened: {
    emitter: "core",
    ingress: "internal",
    upload: "event",
    editions: ["cloud"],
  },
  free_window_exhausted: {
    emitter: "core",
    ingress: "internal",
    upload: "event",
    editions: ["cloud"],
  },
  premium_model_blocked: {
    emitter: "core",
    ingress: "internal",
    upload: "event",
    editions: ["cloud"],
  },
  credit_pack_purchased: {
    emitter: "core",
    ingress: "internal",
    upload: "event",
    editions: ["cloud"],
  },
  account_created: {
    emitter: "core",
    ingress: "internal",
    upload: "counter",
    editions: ["cloud"],
  },
  surface_opened: {
    emitter: "web-ui",
    ingress: "ingress",
    upload: "event",
    editions: ["mac", "cloud"],
  },
  cli_command_run: {
    emitter: "core",
    ingress: "internal",
    upload: "event",
    editions: ["mac", "cloud"],
  },
  repl_slash_command: {
    emitter: "core",
    ingress: "internal",
    upload: "counter",
    editions: ["mac"],
  },
  channel_routed: {
    emitter: "channel",
    ingress: "internal",
    upload: "counter",
    editions: ["mac", "cloud"],
  },
  cli_flag_used: {
    emitter: "core",
    ingress: "internal",
    upload: "counter",
    editions: ["mac", "cloud"],
  },
  consent_prompt_shown: {
    emitter: "native",
    ingress: "ingress",
    upload: "never",
    editions: ["mac", "cloud"],
  },
  consent_changed: {
    emitter: "core",
    ingress: "internal",
    upload: "event",
    editions: ["mac", "cloud"],
  },
  sense_signal_captured: {
    emitter: "core",
    ingress: "internal",
    upload: "counter",
    editions: ["mac"],
  },
  telemetry_sink_failed: {
    emitter: "core",
    ingress: "internal",
    upload: "never",
    editions: ["mac", "cloud"],
  },
};

export const TELEMETRY_EVENT_NAMES = Object.keys(EVENT_POLICY) as readonly TelemetryEventName[];
export const INGRESS_EVENTS = TELEMETRY_EVENT_NAMES.filter(
  (name) => EVENT_POLICY[name].ingress === "ingress",
);
export const UPLOADABLE_EVENTS = TELEMETRY_EVENT_NAMES.filter(
  (name) => EVENT_POLICY[name].upload !== "never",
);
export const LOCAL_ONLY_EVENTS = TELEMETRY_EVENT_NAMES.filter(
  (name) => EVENT_POLICY[name].upload === "never",
);
export const CLOUD_ONLY_EVENTS = TELEMETRY_EVENT_NAMES.filter(
  (name) => !EVENT_POLICY[name].editions.includes("mac"),
);

// ── Runtime fail-closed property specification & sanitizer ───────────────────

export type PropertySpec =
  | { kind: "enum"; values: readonly string[]; optional?: boolean }
  | { kind: "boolean"; optional?: boolean };

const enumSpec = (values: readonly string[], optional = false): PropertySpec =>
  optional ? { kind: "enum", values, optional: true } : { kind: "enum", values };
const boolSpec = (optional = false): PropertySpec =>
  optional ? { kind: "boolean", optional: true } : { kind: "boolean" };

/**
 * Runtime allowlist of every event's properties and allowed values.
 * Keyed by `TelemetryEventName` so adding an event forces declaring its
 * runtime sanitizer rules too.
 */
export const EVENT_PROPERTY_SPECS: Readonly<
  Record<TelemetryEventName, Readonly<Record<string, PropertySpec>>>
> = {
  birth_started: { provider: enumSpec(PROVIDER_FAMILIES) },
  birth_completed: {
    durationMs: enumSpec(MS_BUCKETS),
    provider: enumSpec(PROVIDER_FAMILIES),
    tokens: enumSpec(TOK_BUCKETS),
    retried: boolSpec(),
  },
  session_started: {
    surface: enumSpec(SURFACES),
    resumed: boolSpec(),
    sinceBirth: enumSpec(DAY_BUCKETS),
  },
  session_ended: {
    surface: enumSpec(SURFACES),
    turns: enumSpec(COUNT_BUCKETS),
    durationMs: enumSpec(MS_BUCKETS),
    reason: enumSpec(SESSION_END_REASONS),
  },
  turn_completed: {
    surface: enumSpec(SURFACES),
    tokens: enumSpec(TOK_BUCKETS),
    toolCalls: enumSpec(COUNT_BUCKETS),
    provider: enumSpec(PROVIDER_FAMILIES),
    stopReason: enumSpec(TURN_STOP_REASONS),
  },
  install_daily_ping: {
    platform: enumSpec(PLATFORM_KINDS),
    sinceBirth: enumSpec(DAY_BUCKETS),
    edition: enumSpec(EDITIONS),
    homeIsDefault: boolSpec(),
  },
  autonomy_run_recorded: {
    kind: enumSpec(AUTONOMY_KINDS),
    outcome: enumSpec(AUTONOMY_OUTCOMES),
    durationMs: enumSpec(MS_BUCKETS),
    tokens: enumSpec(TOK_BUCKETS),
    toolCalls: enumSpec(COUNT_BUCKETS),
  },
  desire_inventory_snapshot: {
    open: enumSpec(COUNT_BUCKETS),
    actionable: enumSpec(COUNT_BUCKETS),
    needsUser: enumSpec(COUNT_BUCKETS),
    closed7d: enumSpec(COUNT_BUCKETS),
    tampered: boolSpec(),
  },
  token_budget_blocked: {
    kind: enumSpec(AUTONOMY_KINDS),
    budget: enumSpec(TOK_BUCKETS),
  },
  task_created: {
    kind: enumSpec(TASK_KINDS),
    hasSchedule: boolSpec(),
    hasTrigger: boolSpec(),
    hasEnvelope: boolSpec(),
  },
  task_run_finished: {
    kind: enumSpec(TASK_KINDS),
    outcome: enumSpec(TASK_RUN_OUTCOMES),
    durationMs: enumSpec(MS_BUCKETS),
    tokens: enumSpec(TOK_BUCKETS),
  },
  approval_decided: {
    category: enumSpec(ACTION_CATEGORIES),
    verdict: enumSpec(APPROVAL_DECISION_KINDS),
    scope: enumSpec(GRANT_SCOPES, true),
    surface: enumSpec(SURFACES),
    tainted: boolSpec(),
  },
  connector_authorized: {
    provider: enumSpec(CONNECTOR_PROVIDERS),
    authMode: enumSpec(CONNECTOR_AUTH_MODES),
    ok: boolSpec(),
  },
  idle_card_surfaced: { surface: enumSpec(SURFACES) },
  idle_card_engaged: {
    action: enumSpec(IDLE_ENGAGED_ACTIONS),
    latencyMs: enumSpec(MS_BUCKETS),
  },
  idle_disabled: {
    via: enumSpec(IDLE_DISABLE_VIAS),
    sinceBirth: enumSpec(DAY_BUCKETS),
    priorSurfaced: enumSpec(COUNT_BUCKETS),
  },
  advisor_card_surfaced: {
    category: enumSpec(SUGGESTION_CATEGORIES),
    urgency: enumSpec(URGENCIES),
    actionKind: enumSpec(ACTION_KINDS, true),
  },
  advisor_card_acted: {
    category: enumSpec(SUGGESTION_CATEGORIES),
    actionKind: enumSpec(ACTION_KINDS),
  },
  advisor_card_dismissed: {
    category: enumSpec(SUGGESTION_CATEGORIES),
    categoryDismissals: enumSpec(COUNT_BUCKETS),
  },
  observer_scan_completed: {
    observer: enumSpec(OBSERVER_NAMES),
    found: enumSpec(COUNT_BUCKETS),
    withActivity: enumSpec(COUNT_BUCKETS),
    parseErrors: enumSpec(COUNT_BUCKETS),
    scanMs: enumSpec(MS_BUCKETS),
  },
  observer_enabled_changed: {
    observer: enumSpec(OBSERVER_NAMES),
    enabled: boolSpec(),
  },
  plan_selected: { plan: enumSpec(PLAN_OR_NONE) },
  plan_run_attempted: {
    plan: enumSpec(PLAN_OR_NONE),
    outcome: enumSpec(PLAN_RUN_OUTCOMES),
  },
  plan_run_finished: {
    plan: enumSpec(PLAN_IDS),
    outcome: enumSpec(FINISHED_OUTCOMES),
    durationMs: enumSpec(MS_BUCKETS),
  },
  dispatch_agent_finished: {
    agent: enumSpec(DISPATCH_AGENT_KINDS),
    outcome: enumSpec(DISPATCH_OUTCOMES),
    durationMs: enumSpec(MS_BUCKETS),
  },
  free_window_opened: { tier: enumSpec(QUOTA_TIERS) },
  free_window_exhausted: {
    tier: enumSpec(QUOTA_TIERS),
    hoursIn: enumSpec(MS_BUCKETS),
    turns: enumSpec(COUNT_BUCKETS),
  },
  premium_model_blocked: {
    tier: enumSpec(QUOTA_TIERS),
    reason: enumSpec(PREMIUM_BLOCK_REASONS),
  },
  credit_pack_purchased: {
    rail: enumSpec(PAYMENT_RAILS),
    pack: enumSpec(CREDIT_PACK_IDS),
    sinceExhaust: enumSpec(MS_BUCKETS),
  },
  account_created: {
    kind: enumSpec(ACCOUNT_KINDS),
    verified: boolSpec(),
  },
  surface_opened: {
    surface: enumSpec(SURFACES),
    view: enumSpec(VIEWS),
    first: boolSpec(),
  },
  cli_command_run: {
    command: enumSpec(CLI_COMMANDS),
    ok: boolSpec(),
    durationMs: enumSpec(MS_BUCKETS),
  },
  repl_slash_command: { command: enumSpec(SLASH_COMMANDS) },
  channel_routed: {
    channel: enumSpec(CHANNEL_NAMES),
    direction: enumSpec(CHANNEL_DIRECTIONS),
  },
  cli_flag_used: { flag: enumSpec(CLI_FLAGS) },
  consent_prompt_shown: {
    signal: enumSpec(TELEMETRY_CONSENT_SIGNALS),
    context: enumSpec(CONSENT_CONTEXTS),
  },
  consent_changed: {
    signal: enumSpec(TELEMETRY_CONSENT_SIGNALS),
    granted: boolSpec(),
    sinceBirth: enumSpec(DAY_BUCKETS),
    priorGrants: enumSpec(COUNT_BUCKETS),
  },
  sense_signal_captured: { signal: enumSpec(TELEMETRY_CONSENT_SIGNALS) },
  telemetry_sink_failed: {
    sink: enumSpec(SINK_NAMES),
    code: enumSpec(SINK_FAILURE_CODES),
  },
};

export interface SanitizeEventOptions {
  /** If set, fail closed unless `EVENT_POLICY[name].editions.includes(edition)`. */
  edition?: Edition;
}

/** Look up an event policy safely (returns null for unknown or prototype keys). */
export function getEventPolicy(name: string): EventPolicy | null {
  if (!Object.hasOwn(EVENT_POLICY, name)) return null;
  return EVENT_POLICY[name as TelemetryEventName];
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/**
 * Validate and sanitize an untrusted telemetry event payload against
 * `EVENT_POLICY` and `EVENT_PROPERTY_SPECS`.
 *
 * - Unknown event names -> null (fail closed)
 * - Edition mismatch (when `opts.edition` is provided) -> null (fail closed)
 * - Undeclared extra properties (e.g. `prompt`, `cwd`, `url`, `secret`) -> stripped
 * - Invalid or missing required declared properties -> null (fail closed)
 */
export function sanitizeTelemetryEvent(
  input: unknown,
  opts: SanitizeEventOptions = {},
): TelemetryEvent | null {
  if (!isPlainObject(input)) return null;
  const rawName = input.name;
  if (typeof rawName !== "string") return null;
  const policy = getEventPolicy(rawName);
  if (!policy) return null;
  if (opts.edition && !policy.editions.includes(opts.edition)) return null;

  const rawProps = input.properties;
  if (!isPlainObject(rawProps)) return null;

  const name = rawName as TelemetryEventName;
  const specs = EVENT_PROPERTY_SPECS[name];
  const cleanProps: Record<string, string | boolean> = {};

  for (const [key, spec] of Object.entries(specs)) {
    const val = Object.hasOwn(rawProps, key) ? rawProps[key] : undefined;
    if (val === undefined) {
      if (spec.optional) continue;
      return null;
    }
    if (spec.kind === "boolean") {
      if (typeof val !== "boolean") return null;
      cleanProps[key] = val;
    } else {
      if (typeof val !== "string" || !spec.values.includes(val)) return null;
      cleanProps[key] = val;
    }
  }

  return { name, properties: cleanProps } as TelemetryEvent;
}

# LISA Telemetry (L1 Local Ledger & L2 Proxy Metrics)

LISA follows a **local-first, zero-egress** telemetry architecture (see [analytics-plan-2026-08-21.md](./analytics-plan-2026-08-21.md)).

- **L1 — Local Telemetry Ledger** (`src/telemetry/ledger.ts`): records structured, bucketed lifecycle and usage events solely to your own disk. **Zero network egress**, zero third-party SDKs, and zero user content.
- **L2 — Public Proxy Metrics** ([metrics-daily.yml](../.github/workflows/metrics-daily.yml)): scheduled read-only GitHub Actions summary of public GitHub stars/releases and public npm weekly downloads.
- **L3 — Opt-In Remote Upload**: **unimplemented and disabled** (`remoteUpload: "disabled"`). No data leaves your machine.

---

## L1 Local Ledger (`events.jsonl`)

### Storage & Permissions

- **Location**: `<lisaHome>/telemetry/events.jsonl` (typically `~/.lisa/telemetry/events.jsonl`; in `homeScope` cloud contexts, `<lisaHome>/users/<uid>/telemetry/events.jsonl`).
- **Permissions**: directory mode `0700`, ledger file mode `0600`.
- **Concurrency & Atomicity**: writes are serialized in-process and protected across processes by `events.lock` (`withFileLock`), written via atomic temp-file rename (`atomicWrite`).
- **Never throws**: write or lock failures never crash chat, CLI, or background daemons.

### Retention & Size Bounds

- **30-day automatic pruning**: `trackTelemetry` and `pruneOlderThanDays` automatically drop records older than 30 days (`DEFAULT_RETENTION_DAYS = 30`, overridable with `LISA_TELEMETRY_RETENTION_DAYS`).
- **Line cap**: capped at the newest `3,000` lines (`DEFAULT_MAX_LINES = 3000`, overridable with `LISA_TELEMETRY_MAX_LINES`, ~600 KB ceiling).
- **Corrupted-line resilience**: unreadable or invalid JSONL lines are skipped gracefully on read and removed on the next pruned write.

### Record Format

Each line in `events.jsonl` is a JSON object:

```json
{"v":1,"name":"turn_completed","occurredAt":"2026-11-20T12:00:00.000Z","properties":{"surface":"cli","tokens":"1-5k","toolCalls":"2-3","provider":"anthropic","stopReason":"end"}}
```

The local ledger **never** writes:

- prompts, assistant replies, tool arguments, or model outputs
- file paths, working directories (`cwd`), repository names, or URLs
- email addresses, tokens, API keys, or secrets
- `installId`, `uid`, `bornOn`, or machine/user identifiers

---

## Opt-Out & Inspection CLI

Set `LISA_TELEMETRY=off` (or `LISA_TELEMETRY_LOCAL=0`) in your environment or `~/.lisa/config.env` to make `trackTelemetry` an immediate no-op without creating any files.

```sh
lisa telemetry report [--days N] [--json]   # Summarize retained local events (default: 30 days)
lisa telemetry clear [--json]               # Delete <lisaHome>/telemetry/events.jsonl
lisa telemetry status [--json]              # Show opt-out state, bounds, and L3 upload status
lisa telemetry events [--json]              # Print all declared events and their policy metadata
```

---

## Schema & Fail-Closed Policy (`src/telemetry/schema.ts`)

Every event in `TelemetryEvent` obeys two compile-time and runtime guarantees:

1. **No raw `string` properties**: properties are restricted strictly to closed literal enums, `boolean`, and pure bucket helper outputs:
   - `msBucket(ms)` -> `"<1s" | "1-5s" | "5-30s" | "30s-2m" | "2-10m" | "10-60m" | ">1h"`
   - `tokBucket(tokens)` -> `"<1k" | "1-5k" | "5-20k" | "20-100k" | "100k+"`
   - `dayBucket(days)` -> `"0" | "1" | "2-6" | "7-29" | "30-89" | "90+"`
   - `countBucket(n)` -> `"0" | "1" | "2-3" | "4-9" | "10-29" | "30-99" | "100+"`
   - `rateBucket(ratio)` -> `"0" | "1-25%" | "26-50%" | "51-75%" | "76-99%" | "100%"`
2. **Fail-closed `EVENT_POLICY` & `EVENT_PROPERTY_SPECS`**:
   - Keyed by `Readonly<Record<TelemetryEventName, ...>>` — adding an event without declaring its `emitter`, `ingress` (`"internal" | "ingress"`), `upload` (`"never" | "counter" | "event"`), `editions` (`"mac" | "cloud"`), and runtime property spec fails TypeScript compilation.
   - `sanitizeTelemetryEvent()` strips any undeclared keys and rejects unknown event names, edition mismatches, or out-of-enum values.

### Declared Event Catalog

| Event | Emitter | Ingress | Upload policy | Editions |
|---|---|---|---|---|
| `birth_started` | `core` | `internal` | `counter` | `mac` |
| `birth_completed` | `core` | `internal` | `event` | `mac` |
| `session_started` | `core` | `internal` | `event` | `mac`, `cloud` |
| `session_ended` | `core` | `internal` | `event` | `mac`, `cloud` |
| `turn_completed` | `core` | `internal` | `event` | `mac`, `cloud` |
| `install_daily_ping` | `core` | `internal` | `event` | `mac`, `cloud` |
| `autonomy_run_recorded` | `core` | `internal` | `event` | `mac`, `cloud` |
| `desire_inventory_snapshot` | `core` | `internal` | `never` | `mac`, `cloud` |
| `token_budget_blocked` | `core` | `internal` | `event` | `mac`, `cloud` |
| `task_created` | `core` | `internal` | `event` | `mac`, `cloud` |
| `task_run_finished` | `core` | `internal` | `event` | `mac`, `cloud` |
| `approval_decided` | `core` | `internal` | `event` | `mac`, `cloud` |
| `connector_authorized` | `core` | `internal` | `event` | `mac`, `cloud` |
| `idle_card_surfaced` | `core` | `internal` | `counter` | `mac`, `cloud` |
| `idle_card_engaged` | `web-ui` | `ingress` | `event` | `mac`, `cloud` |
| `idle_disabled` | `core` | `internal` | `event` | `mac`, `cloud` |
| `advisor_card_surfaced` | `core` | `internal` | `event` | `mac`, `cloud` |
| `advisor_card_acted` | `web-ui` | `ingress` | `event` | `mac`, `cloud` |
| `advisor_card_dismissed` | `core` | `internal` | `event` | `mac`, `cloud` |
| `observer_scan_completed` | `core` | `internal` | `event` | `mac` |
| `observer_enabled_changed` | `core` | `internal` | `event` | `mac` |
| `plan_selected` | `core` | `internal` | `event` | `mac` |
| `plan_run_attempted` | `core` | `internal` | `event` | `mac` |
| `plan_run_finished` | `core` | `internal` | `event` | `mac` |
| `dispatch_agent_finished` | `core` | `internal` | `event` | `mac` |
| `free_window_opened` | `core` | `internal` | `event` | `cloud` |
| `free_window_exhausted` | `core` | `internal` | `event` | `cloud` |
| `premium_model_blocked` | `core` | `internal` | `event` | `cloud` |
| `credit_pack_purchased` | `core` | `internal` | `event` | `cloud` |
| `account_created` | `core` | `internal` | `counter` | `cloud` |
| `surface_opened` | `web-ui` | `ingress` | `event` | `mac`, `cloud` |
| `cli_command_run` | `core` | `internal` | `event` | `mac`, `cloud` |
| `repl_slash_command` | `core` | `internal` | `counter` | `mac` |
| `channel_routed` | `channel` | `internal` | `counter` | `mac`, `cloud` |
| `cli_flag_used` | `core` | `internal` | `counter` | `mac`, `cloud` |
| `consent_prompt_shown` | `native` | `ingress` | `never` | `mac`, `cloud` |
| `consent_changed` | `core` | `internal` | `event` | `mac`, `cloud` |
| `sense_signal_captured` | `core` | `internal` | `counter` | `mac` |
| `telemetry_sink_failed` | `core` | `internal` | `never` | `mac`, `cloud` |

---

## L2 Proxy Metrics Workflow

[`.github/workflows/metrics-daily.yml`](../.github/workflows/metrics-daily.yml) runs daily on a read-only `contents: read` token (`dry_run: true` by default) to fetch public repository stats (stars, forks, watchers, releases asset downloads) and `@oratis/lisa` npm weekly downloads, publishing a summary in `$GITHUB_STEP_SUMMARY` and storing an artifact snapshot without committing to git or handling secrets.

---

## Known Scope & Limitations

1. **L3 opt-in remote upload is unimplemented and off**: `upload` values (`"never" | "counter" | "event"`) in `EVENT_POLICY` govern schema classification only. No upload client, upload endpoint, `installId` derivation, or `POST /api/insight/event` ingress endpoint exists yet; shipping L3 requires explicit user consent (`src/consent/store.ts`) and synchronized updates to the privacy policy pages (`website/src/pages/privacy.astro` and `zh-CN` mirrors).
2. **Surface wiring deferred**: This L1 foundation ships the schema, ledger, tests, CLI (`lisa telemetry`), docs, and L2 workflow cleanly isolated from `src/web/` and `src/warden/`.
3. **Accounting boundaries**:
   - `billing/usage.jsonl` (metered billing audit), `autonomy/runs.jsonl` (autonomous runs), and `turn_completed` (all surfaces) measure distinct domains and must not be summed together.
   - `surface: "autonomous"` runs reflect background heartbeats/idle ticks rather than active user sessions.
   - Local `installId` (when/if ever introduced) and Cloud `uid` are never linked or summed.
4. **Process-global vs scoped homes**: `src/telemetry/ledger.ts` uses `lisaHome()` from `src/paths.ts` (multi-tenant `homeScope`-safe). Process-level stores (`accounts.ts`, `devices.ts`, `otp.ts`, `sessions-auth.ts`) intentionally use `lisaGlobalHome()`. Several legacy local stores (`consent/store.ts`, `sense/log.ts`, `dispatch-ledger.ts`, `control/policy.ts`, `web/push.ts`, `mail/store.ts`, `mail/accounts.ts`, `integrations/takoapi/ledger.ts`) still read `LISA_HOME` directly and are tracked separately before L3 consent gating can be enabled.

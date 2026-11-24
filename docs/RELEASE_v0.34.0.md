# Lisa 0.34.0 — Always-on Tasks, Hardened Warden, Portable MCP, and Improve LISA

Lisa 0.34.0 lands the full post-0.33 product, security, and platform alignment wave across the Mac app, CLI, self-hosted web shell, and Lisa Pocket (iOS). It adds a dedicated Web and iOS Tasks view with workspace-contained artifact previews, hardens Warden across chat, channels, and autonomous runs with Ed25519 challenge-bound approvals and provenance tracking, introduces the Portable LISA MCP server and Recipe Gallery, launches Improve LISA M0/M1 personal capabilities with safe rollback, expands dispatch to Cursor and Gemini CLI, adds a dedicated Mac Room window and sovereign room decoration, and introduces a zero-egress local telemetry ledger.

## Tasks UI, client capabilities, and contained artifact preview

- Added read-only `GET /api/client-capabilities` describing what the current server and authenticated caller support without granting permissions (#546).
- Added Web Tasks UI (`#viewTasks` / `#tasks`) and native iOS `TasksView` with goal milestones/evidence, live SSE refresh, and conservative fallback when capabilities are unavailable (#546).
- Added `GET /api/tasks/{id}/runs/{runId}/artifacts/{artifactId}` with lexical and `fs.realpath` workspace containment, a 2 MiB size cap, `X-Content-Type-Options: nosniff`, sandbox CSP, and attachment-only handling for HTML/SVG artifacts (#546).

## Hardened Warden, provenance, and composer controls

- Added local-owner composer controls (`ask` / `smart` / `full`, per-turn model override, and reasoning effort) backed by fail-closed local chat permissions (#540).
- Wired Warden enforcement across IM channels, heartbeat, idle, and subagent execution with `resolveChatWorkspaceRoot` confinement (#545).
- Added the `provenance` engine, builtin `provenance` tool, `GET /api/warden/provenance`, monotonic cross-family review gate, pluggable atomic single-consumption `ApprovalInboxStore`, and Ed25519 challenge-bound signed approval verification (#545).

## Portable LISA MCP server and Recipe Gallery

- Added `lisa mcp serve` supporting `stdio` (default) and loopback-only Streamable HTTP (`127.0.0.1`, mandatory 16+ character timing-safe Bearer token, 256 KiB cap, cross-site/Host defense, Warden audit logging, secret redaction, and scope-gated persona/memory/KB/tasks tools with draft-only task creation) (#547).
- Added built-in and local Recipe Gallery (`lisa recipes list|show|install|export` and `GET /api/recipes`) with Ed25519 signature verification, secret/credential rejection, and disabled-draft installation (#547).

## Improve LISA M0/M1 (personal capabilities & safe rollback)

- Added `<lisaHome>/improvements/` personal capability lifecycle with independent `workStatus`, `activationStatus`, and `contributionStatus` tracking, digest-bound + `baseProfileVersion` CAS atomic apply, clean rollback preserving sessions and memory, and de-privatized community PR export (#548).
- Added dedicated `kind: "improvement"` sessions, `/api/improve*` endpoints, and a fixed `Improve LISA` sidebar entry preserving the 3×3 primary navigation grid (#548).

## Multi-agent dispatch, provider compaction, Sense, and Telemetry

- Added Cursor CLI and Gemini CLI dispatch backends and observers, workspace `cwd` locking, capability routing, and completion-evidence patrolling (#542).
- Added M4 provider compaction (`src/providers/compaction.ts` for OpenAI and Gemini), Sense S2 system idle/screen-lock presence (`src/idle/system-presence.ts`), and Sense S4 consent-gated metadata-only clipboard observation (`src/sense/clipboard.ts`) (#543).
- Added zero-egress local L1 telemetry ledger (`src/telemetry/{schema,ledger}.ts`, `lisa telemetry` CLI, opt-out via `LISA_TELEMETRY=off`) and daily metrics workflow (#541).
- Upgraded `@google/genai` to `3.6.1` with `v1beta` pinning (#536) and refreshed npm and website dependencies (#524, #526).

## Mac, Web, Room, Harness, and Console polish

- Implemented Mac & Web design review improvements D-1 through D-20 (#544), added the LISA Cloud workspace alongside My Mac in the native Mac app (#538), isolated Gmail OAuth client file configuration (#539), and refreshed admin console branding and analytics (#537).
- Added Room Phase 3 (`RoomWindow.swift`, `View → Open Room Window ⌘⇧R` with loopback-only navigation and visibility lifecycle reporting) and Room Phase 4 (`<lisaHome>/soul/room.json`, `room_decorate` tool, `GET /api/room/decor`, extracted `src/web/routes/room-routes.ts`) (#549).
- Connected Harness H3 offline session-replay drift metrics (`computeReplayDriftMetrics` and `scripts/replay-session.ts --metrics`), documented the H1/H2 three-tier fail-closed sandbox posture in `docs/FOOTPRINT.md`, and archived 9 completed plans under `docs/archive/plans/` (#549).

## Follow-up verification

Automated CI and local release verification covered TypeScript/client/E2E typechecking, ESLint, API contract checks, unit/integration tests with coverage floors, Playwright web E2E, macOS Swift tests (`-warnings-as-errors`), iOS Simulator (`TasksTests`), Markdown link/drift checks, and website build. Physical iPhone 5G/cellular network-switch acceptance, hardware Keychain / Face ID enrollment, external OAuth app-review flows, and live hosted Cloud Run traffic promotion were not executed in automated CI and remain tracked separately.

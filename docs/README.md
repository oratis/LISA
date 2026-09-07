# LISA docs

Everything in `docs/` — indexed, so you can tell in one screen whether a file is
something to read, something to implement, or something that already happened.

The rule this index enforces: **a plan whose work has shipped moves to
[`archive/plans/`](./archive/plans/)**. What stays in `docs/` is either
documentation you use or work still open. If a plan here is finished, archive it.

- [Start here](#start-here) · [Current plans](#current-plans) · [Completed plans (archive)](#completed-plans-archive)
- [Releases](#releases) · [Reviews](#reviews) · [Runbooks](#runbooks) · [Research](#research) · [Design notes](#design-notes)

---

## Start here

| Doc | What it is |
|---|---|
| [GUIDE.md](./GUIDE.md) · [中文](./GUIDE.zh-CN.md) | The full user guide — install, every surface, soul, knowledge base, mail, channels, heartbeat, tools, config, REPL, layout. The [README](../README.md) is the 60-second version. |
| [PROVIDERS.md](./PROVIDERS.md) | Ready-to-use configs for 20+ LLM providers, including local ones. |
| [CODING_PLANS.md](./CODING_PLANS.md) | Running Lisa's coding work on a Claude Pro/Max, ChatGPT or Copilot subscription instead of a metered key — and why token extraction was refused. |
| [PTY_AGENTS.md](./PTY_AGENTS.md) | Steering a real `claude` / `codex` CLI through a pseudo-terminal, and adopting a session you started yourself. |
| [RELEASING.md](./RELEASING.md) | How to cut a release: version bump, notes, changelog, tags, npm, Homebrew, signing and notarization. |
| [PUBLISH.md](./PUBLISH.md) | The distribution channels themselves and the one-time credentials each needs. |
| [CONTRIBUTING.md](../CONTRIBUTING.md) | Where to help, the norms, the local dev loop. |

## Current plans

Open work. Each plan carries its own status line — trust that over this table.

**The spine**

| Plan | Scope |
|---|---|
| [ROADMAP_v1.0.md](./ROADMAP_v1.0.md) | The 1.0 roadmap: four pillars (Sense · Dispatch · Reve · Model) and what "1.0" means. Never archived — it is the map. |
| [AUTONOMY_ROADMAP.md](./AUTONOMY_ROADMAP.md) | The autonomy arc (idle, heartbeat, examen, soul evolution) behind the Reve pillar. |

**Four pillars**

| Plan | Scope |
|---|---|
| [PLAN_SENSE_v1.0.md](./PLAN_SENSE_v1.0.md) | Resident ambient perception, consent-gated. |
| [PLAN_SENSE_S2_v1.0.md](./PLAN_SENSE_S2_v1.0.md) | Ambient vision + voice — the most privacy-sensitive block; gated on the consent framework. |
| [PLAN_SENSE_SOCIAL_CONNECTORS_v1.0.md](./PLAN_SENSE_SOCIAL_CONNECTORS_v1.0.md) | Conversational social publishing through connected accounts. |
| [PLAN_DISPATCH_v1.0.md](./PLAN_DISPATCH_v1.0.md) | The unified command layer over local CLI agents + TakoAPI. |
| [PLAN_DISPATCH_D2B_v1.0.md](./PLAN_DISPATCH_D2B_v1.0.md) | D2b — an A2A adapter putting remote agents in the hub. |
| [PLAN_DISPATCH_D4_v1.0.md](./PLAN_DISPATCH_D4_v1.0.md) | D4 — the multi-agent monitor and advisor actions. |
| [PLAN_OBSERVER_DEEPENING_v1.0.md](./PLAN_OBSERVER_DEEPENING_v1.0.md) | Tier-2 fidelity for the codex / opencode / aider observers. |
| [PLAN_REVE_v1.0.md](./PLAN_REVE_v1.0.md) | Hardening autonomous reflection: quality gates, budgets, observability. |
| [PLAN_MODEL_v1.0.md](./PLAN_MODEL_v1.0.md) | From "bring your own endpoint" to real local deployment. |
| [PLAN_FOUNDATIONS_v1.0.md](./PLAN_FOUNDATIONS_v1.0.md) | The cross-cutting floor the other three stand on: consent, security, tests. |

**Cloud, accounts, identity**

| Plan | Scope |
|---|---|
| [PLAN_CLOUD_v1.0.md](./PLAN_CLOUD_v1.0.md) | LISA Cloud on GCP. M0 deployed; per-user isolation still open. |
| [PLAN_ACCOUNTS_BILLING_v1.0.md](./PLAN_ACCOUNTS_BILLING_v1.0.md) | Centralized accounts and token billing. |
| [PLAN_IDENTITY_v1.0.md](./PLAN_IDENTITY_v1.0.md) | "One identity, two data planes" — who you are vs. where your Lisa lives. |
| [PLAN_WEB_SIGNUP_v1.0.md](./PLAN_WEB_SIGNUP_v1.0.md) | Signup / login on meetlisa.ai and the signed-in web app. |

**Capabilities**

| Plan | Scope |
|---|---|
| [PLAN_HARNESS_ALIGNMENT_v1.0.md](./PLAN_HARNESS_ALIGNMENT_v1.0.md) | Aligning with the DeepSeek harness: capability seam, sandbox modes, prompt in the session log. |
| [PLAN_KNOWLEDGE_BASE_v2.0.md](./PLAN_KNOWLEDGE_BASE_v2.0.md) | Knowledge base v2: URL ingest, the daily brief, the link graph. |
| [PLAN_DESIRE_EVOLUTION_v1.0.md](./PLAN_DESIRE_EVOLUTION_v1.0.md) | Why her wishes didn't change with a conversation, and how to fix it without breaking sovereignty. |
| [PLAN_MAIL_v1.0.md](./PLAN_MAIL_v1.0.md) | The read-only mailbox and its daily digest. |
| [PLAN_MODEL_TUNING_v1.0.md](./PLAN_MODEL_TUNING_v1.0.md) | Per-model knobs worth keeping for the Anthropic provider. |

**Clients and surfaces**

| Plan | Scope |
|---|---|
| [IOS_COMPANION_PLAN.md](./IOS_COMPANION_PLAN.md) | The Lisa Pocket design. |
| [PLAN_IOS_ONBOARDING_v1.0.md](./PLAN_IOS_ONBOARDING_v1.0.md) | First launch and pairing on iOS. |
| [PLAN_IOS_REACHABILITY_v1.0.md](./PLAN_IOS_REACHABILITY_v1.0.md) | "Always reach Lisa" — R1–R4 landed, R5 waits on cloud accounts. |
| [PLAN_MAC_APP_STORE_v1.0.md](./PLAN_MAC_APP_STORE_v1.0.md) | Whether Lisa.app can ship on the Mac App Store (verdict: only the thin client). |
| [MAC_ISLAND_PLAN.md](./MAC_ISLAND_PLAN.md) | The menu-bar island. |
| [PLAN_ROOM_v1.0.md](./PLAN_ROOM_v1.0.md) | The room she lives in — research and design. Phase 1 landed; v2.0 is archived. |
| [PLAN_GRAMOPHONE_v1.0.md](./PLAN_GRAMOPHONE_v1.0.md) | Opt-in ambient music in the room. |
| [PLAN_WEBSITE_REBUILD_v1.0.md](./PLAN_WEBSITE_REBUILD_v1.0.md) | Rebuilding meetlisa.ai in the Hakko design language. |

**Older plans, kept for their reasoning**

| Plan | Scope |
|---|---|
| [ORCHESTRATOR_PLAN.md](./ORCHESTRATOR_PLAN.md) | The original "LISA as mission control" plan (2026-05). |
| [PRODUCTIZATION_PLAN.md](./PRODUCTIZATION_PLAN.md) | CLI polish / website / providers / Mac app under the sovereign-only, OSS-only constraint. |
| [SPRINT_4_PLAN.md](./SPRINT_4_PLAN.md) | A data-gated candidate list, deliberately never committed to. |

## Completed plans (archive)

Shipped. Kept because the reasoning and the debates are still worth reading —
several are cited by name from source comments.

| Plan | Shipped as |
|---|---|
| [PLAN_AUTH_OTP_GOOGLE_v1.0.md](./archive/plans/PLAN_AUTH_OTP_GOOGLE_v1.0.md) | Email-OTP + Google Sign-In (status: IMPLEMENTED, 2026-07-24). |
| [PLAN_KNOWLEDGE_BASE_v1.0.md](./archive/plans/PLAN_KNOWLEDGE_BASE_v1.0.md) | The 3-layer personal knowledge base (PRs #235–#242). |
| [HANDOFF_KNOWLEDGE_BASE_v2.0.md](./archive/plans/HANDOFF_KNOWLEDGE_BASE_v2.0.md) | The K-series handoff; the work landed in v0.21.0. |
| [PLAN_UI_SESSION_SHELL_v1.0.md](./archive/plans/PLAN_UI_SESSION_SHELL_v1.0.md) | The three-column session shell, phases 1–3 (PRs #343–#345). |
| [PLAN_UI_SESSION_SHELL_v1.1.md](./archive/plans/PLAN_UI_SESSION_SHELL_v1.1.md) | Its follow-up wave F1–F7 (PRs #346–#350). |
| [PLAN_ROOM_v2.0.md](./archive/plans/PLAN_ROOM_v2.0.md) | The room's life system, phases A–E (PRs #221, #222 + 换景). |
| [PLAN_DESIRE_DYNAMICS_v2.0.md](./archive/plans/PLAN_DESIRE_DYNAMICS_v2.0.md) | Desire dynamics v2, PRs A–C including cloud parity. |

## Releases

[RELEASING.md](./RELEASING.md) is the how. [CHANGELOG.md](../CHANGELOG.md) is
generated from the notes below by `npm run changelog` — so the note is the
source, and the changelog is the summary.

[v0.24.0](./RELEASE_v0.24.0.md) ·
[v0.23.0](./RELEASE_v0.23.0.md) ·
[v0.22.0](./RELEASE_v0.22.0.md) ·
[v0.21.0](./RELEASE_v0.21.0.md) ·
[v0.20.0](./RELEASE_v0.20.0.md) ·
[v0.19.0](./RELEASE_v0.19.0.md) ·
[v0.18.1](./RELEASE_v0.18.1.md) ·
[v0.18.0](./RELEASE_v0.18.0.md) ·
[v0.17.0](./RELEASE_v0.17.0.md) ·
[v0.16.0](./RELEASE_v0.16.0.md) ·
[v0.15.0](./RELEASE_v0.15.0.md) ·
[v0.14.0](./RELEASE_v0.14.0.md) ·
[v0.13.0](./RELEASE_v0.13.0.md) ·
[v0.12.0](./RELEASE_v0.12.0.md) ·
[v0.11.1](./RELEASE_v0.11.1.md) ·
[v0.11.0](./RELEASE_v0.11.0.md) ·
[v0.10.0](./RELEASE_v0.10.0.md) ·
[v0.9.1](./RELEASE_v0.9.1.md) ·
[v0.6.0](./RELEASE_v0.6.0.md) ·
[v0.5.0](./RELEASE_v0.5.0.md) ·
[v0.4.0](./RELEASE_v0.4.0.md) ·
[v0.3.1](./RELEASE_v0.3.1.md) ·
[v0.3.0](./RELEASE_v0.3.0.md) ·
[v0.2.0](./RELEASE_v0.2.0.md)

## Reviews

Point-in-time assessments. Each names its baseline commit; read the newest first.

| Review | Baseline |
|---|---|
| [PROJECT_REVIEW_AND_OPTIMIZATION_v0.21.0.md](./PROJECT_REVIEW_AND_OPTIMIZATION_v0.21.0.md) | Whole-project review, 2026-07-26. |
| [REVIEW_IOS_APP_v1.0.md](./REVIEW_IOS_APP_v1.0.md) | Lisa Pocket layout + functionality. |
| [PRODUCT_REVIEW_v0.9.md](./PRODUCT_REVIEW_v0.9.md) | Product capability review at v0.9. |
| [PRODUCT_REVIEW_v0.3.md](./PRODUCT_REVIEW_v0.3.md) | The first capability review + tuning plan. |

The current pair — `PROJECT_REVIEW_UX_v0.24.0.md` and
`PROJECT_REVIEW_TECH_v0.24.0.md` (2026-09-05, baseline `26266a5`) — are the
newest and supersede the v0.21.0 review.

## Runbooks

Operational procedures for things that are live.

| Runbook | For |
|---|---|
| [RUNBOOK_CLOUD_PROD.md](./RUNBOOK_CLOUD_PROD.md) | The production Cloud Run deployment. |
| [RUNBOOK_ACCOUNTS_LAUNCH.md](./RUNBOOK_ACCOUNTS_LAUNCH.md) | Launching accounts / auth: the operational config the code alone doesn't cover. |
| [WEBSITE_OPS.md](./WEBSITE_OPS.md) | meetlisa.ai — deploys, DNS, rollbacks. |
| [FOOTPRINT.md](./FOOTPRINT.md) | What the resident service actually costs in CPU, memory and wakeups. |
| [OBSERVER_FIDELITY.md](./OBSERVER_FIDELITY.md) | Which fields each observer really produces, with the live-verification log. |

## Research

Background reading that shaped a design, kept separate from the plans so a
finding is never mistaken for a commitment.

| Note | Subject |
|---|---|
| [RESEARCH_DEEPSEEK_HARNESS.md](./RESEARCH_DEEPSEEK_HARNESS.md) | The dsh harness, and what LISA should take from it. |
| [RESEARCH_KNOWLEDGE_INTERNALIZATION.md](./RESEARCH_KNOWLEDGE_INTERNALIZATION.md) | How an agent might internalize what it reads. |
| [RESEARCH_LEARNING_IN_REFERENCING.md](./RESEARCH_LEARNING_IN_REFERENCING.md) | Learning-in-referencing — the research track behind Reve. |
| [RESEARCH_OPEN_SOURCE_GAME_MODELS.md](./RESEARCH_OPEN_SOURCE_GAME_MODELS.md) | Open-source game/character models surveyed for the room. |

## Design notes

Smaller, self-contained design write-ups that aren't plans with phases.

| Note | Subject |
|---|---|
| [DESIGN_COMPRESSION_GATE.md](./DESIGN_COMPRESSION_GATE.md) | The compression-gain consolidation gate. |
| [DESIGN_CONCEPT_BENCH.md](./DESIGN_CONCEPT_BENCH.md) | A constructed-language benchmark that turns misunderstanding into a controlled variable. |
| [DESIGN_LEXICAL_ENTRY.md](./DESIGN_LEXICAL_ENTRY.md) | Token-triggered lexical-entry memory. |
| [SHOW_HN_DRAFT.md](./SHOW_HN_DRAFT.md) | The launch post draft. |

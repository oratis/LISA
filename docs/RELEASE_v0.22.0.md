# Lisa v0.22.0

The **bounded autonomy** release — Lisa's desires can now evolve with
conversation, time, and carefully limited web research, while the hosted
runtime gains stricter capability, billing, request, concurrency, and memory
boundaries.

Typecheck green · full test suite green (**1,442 passed, 1 environment-only PTY
skip**) · production build green.

## ✨ Desire dynamics v2

- Desires now carry intensity, horizon, review timing, and bounded source
  provenance, with time-decayed ranking for short sparks, seasonal interests,
  and enduring wants.
- Conversation reflection can revise or close a desire without losing its
  identity or birth time.
- Proactive heartbeat may review one due desire with a narrow tool allow-list
  and a hard budget of one search and two fetches.
- Cloud autonomy now has the same desire-review path, but performs at most one
  inference action per account and sweep.

## 🔒 Cloud capability and HTTP boundaries

- Hosted tenants receive an explicit allow-list instead of the local owner's
  shell, filesystem, process, plugin, MCP, device, and arbitrary-network powers.
- Verification and checkout links are pinned to a configured HTTPS public
  origin; proxy-derived client identity is trusted only through an explicit hop
  count.
- Every buffered request body is bounded: 1 MiB for control-plane JSON and
  20 MiB for approved audio or chat attachments, including webhook listeners.

## 💳 Billing and inference integrity

- Account, balance, purchase, and global-spend stores now fail closed on
  corruption or outages instead of silently behaving like empty state.
- Apple transaction processing is resumable and idempotent across credit,
  refund, retry, and crash windows.
- Chat and managed gateway inference share one admission boundary and one
  exception-safe tenant lease lifecycle, including stream disconnect cleanup.

## ⚙️ Reliable multi-tenant autonomy

- Cloud sweeps use per-tenant serialization, Firestore leases, and atomic
  pending/completed checkpoints to avoid duplicate reflection and model spend.
- Tenant runtimes are created single-flight, pinned while active, and evicted by
  TTL/LRU under a configurable hard target instead of accumulating forever.
- Account deletion invalidates in-flight runtime creation, preventing deleted
  tenant state from being resurrected by a racing request.

## 🧰 Maintenance

- Refreshed compatible transitive dependencies and upgraded `sharp` and
  `tsx`/`esbuild` to remove all known high-severity audit findings.
- Added a durable architecture review, invariants, delivery phases, and
  implementation-linked optimization baseline for future work.

## For existing local users

The local, bring-your-own-key experience remains unchanged. The new hosted
restrictions apply only to Cloud tenant surfaces; desire review remains governed
by the existing Proactive setting and its bounded tool budget.

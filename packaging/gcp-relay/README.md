# anthropic-relay — a transparent Claude relay on Cloud Run

A ~110-line, zero-dependency reverse proxy that forwards the Anthropic API
(`/v1/*`, streaming included) from Cloud Run to `https://api.anthropic.com`.

## Why

The LISA backend on the Mac routes all outbound LLM calls through a local HTTP
proxy (`HTTPS_PROXY=127.0.0.1:7897`). When that proxy flaps, the Claude call fails
and the chat turn comes back empty ("Lisa didn't reply"). GCP's egress to
Anthropic is reliable, so pointing the Mac at this relay removes the flaky hop.

Zero LISA code change: the Anthropic provider already honors `ANTHROPIC_BASE_URL`
(`src/providers/anthropic.ts`).

## How it works (key-swap gate)

```
Mac (ANTHROPIC_BASE_URL=relay, x-api-key=RELAY_TOKEN)
   └─HTTPS─▶ Cloud Run relay  ──(swap x-api-key → real key)──▶ api.anthropic.com
```

- The **real Anthropic key lives only in GCP** (Secret Manager). It never sits on
  the Mac.
- The Mac authenticates with a separate **`RELAY_TOKEN`**, sent in the `x-api-key`
  header (which the Anthropic SDK already sends). The relay verifies it, then
  replaces it with the real key before forwarding. Revoke access by rotating the
  token secret — the Anthropic key is untouched.
- Response is streamed straight back, so SSE (`stream: true`) works unchanged.

### This is NOT an OpenClaw-style billing proxy

Community "Claude relays" (e.g. `John-Rood/claude-proxy`,
`majdyz/openclaw-claude-proxy`) exist to make API calls **bill against a Claude
Code / Max subscription** instead of usage-based API credits — by injecting
`anthropic-beta: claude-code-20250219` + a Claude Code system prompt, or by
spawning the local `claude` CLI and reusing its OAuth session. Anthropic
fingerprints and **rejects** these ("third-party-app rejection"), and it's against
their terms. This relay does none of that: it forwards authenticated requests that
bill normally against the real key. The goal here is **network reachability, not
cheaper billing.**

## Deploy

```bash
ANTHROPIC_API_KEY=sk-ant-... ./deploy.sh
```

Prints the relay URL + `RELAY_TOKEN` and the exact `~/.lisa/config.env` lines.
`MIN_INSTANCES=1 ./deploy.sh` keeps one warm instance (no cold-start latency on the
first message).

## Cost

Cloud Run scales to zero by default (pay per request + egress; pennies at personal
volume). Anthropic usage bills against your real key as normal. `min-instances=1`
adds a small always-on charge (~$5–15/mo) for lower first-message latency.

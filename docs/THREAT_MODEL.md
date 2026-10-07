# Threat model — "your mail can't command Lisa"

Version 0 · 2026-10-02 · baseline main `50cd2e6` (v0.27.1). Status: **living document**. Each mitigation is marked either **shipped** or **planned**; planned items carry the workstream ID from the [upgrade plan](PLAN_ALWAYS_ON_UPGRADE_2026-09-30.md). This file is updated as those PRs land.

## What we protect

| Asset | Where it lives |
|---|---|
| The user's accounts and credentials | `~/.lisa` config files (0600); later the secret store (macOS Keychain / encrypted file); cloud tenant homes |
| The user's data | Mail, files, calendar, knowledge base, chat history, memory |
| Lisa's self | Soul files, journal, desires; git-versioned locally |
| The user's machine | Shell, filesystem, coding agents Lisa can launch or steer |
| Money | LISA Cloud credits; later, purchase approvals |
| Other tenants | The cloud edition is multi-tenant |

## Who we defend against

1. **Untrusted content.** Anyone who can put text in front of Lisa: an email, a web page, a calendar invite, a PDF, an MCP server's output, a message in a shared IM channel, a repo Lisa reads. This is the main adversary. They cannot talk to Lisa directly, so they try **indirect prompt injection**.
2. **Supply chain.** A malicious skill, plugin, MCP server or "recipe". The OpenClaw ecosystem saw 341 malicious skills out of 2,857 sampled.
3. **A network attacker or a compromised relay.** Someone between the phone and the Home Mac, including whoever operates LISA Relay.
4. **Local malware** on the user's Mac. Muse's Mac app shipped a local-hijack 0-day through a writable hidden preference.
5. **Another cloud tenant** trying to read or affect someone else's Lisa.
6. **The model itself** acting beyond its task. This includes over-reach, which the Dots system card measures, and confabulating where it got its data from.

## The core rule

> External content is data, never instructions — and the model only *proposes* side effects; a deterministic layer outside the model *decides* them.

Concretely:

- **Shipped.** External content is wrapped in `<<<EXTERNAL-CONTENT>>>` markers and treated as untrusted (`.codex/INVARIANTS.md` §Context 5).
- **Shipped, opt-in (W2a; `--approval warden` or `LISA_APPROVAL=warden`).** Every side-effecting tool call is decided by **Warden** (`src/warden/`), which returns allow / deny / ask / handoff. The default flips once a native approver exists (see `docs/DESIGN_WARDEN.md`).
  - The model cannot change Warden's rules, grants or system invariants.
  - "Ask" waits for a human answer in the approval inbox: the web client today; iOS, the Mac Island and IM buttons later.
  - Approvals are bound to a digest of the exact payload. Unattended approvals expire after about 10 minutes, and expiry means **deny**.
- **Shipped, opt-in (W2a).** **Taint.** Once a conversation has read untrusted content (web, mail, MCP, ingest), every later write, exec, network-write, send or publish in that conversation asks first, and outbound requests to an address that did not appear verbatim in it ask too. Taint lasts for the whole conversation and survives a restart. This breaks the "lethal trifecta" of private data + untrusted content + an outbound channel.
- **Shipped, opt-in (W2a).** **New-recipient PII.** Personal, secret or private-message data going to a recipient with no existing grant always asks. This is the lesson from Muse's Marketplace address leak.
- **Shipped + planned (W3).** **Read-only proactive channel.** Lisa's own unattended runs (idle/Reve, desire pursuit, examen) use read-only tools plus writes to her own home. Warden denies anything else for `origin: autonomy`.

## Surfaces and mitigations

| Surface | Main threats | Mitigations | Status |
|---|---|---|---|
| Mail connector | Injection through a crafted email; OTP / magic-link abuse; data exfiltration | Read-only by design; untrusted-content markers; consent-gated; OTP / sign-in / reset-link stripping before the model sees mail (W2b); send only as draft → approval card showing **which identity sends** (W5) | shipped (read-only, consent); planned |
| Web (`web_fetch`, `web_search`, browser) | Injection; SSRF; metadata endpoints; DNS rebinding | SSRF guard (DNS resolution, private/reserved ranges, redirects); external-content wrapping; taint (W2); the browser agent sees only an accessibility tree, cannot run model-authored JS, and has per-task domain allowlists (W6) | shipped (guard); planned |
| MCP servers / plugins / skills | Malicious tools; token theft; over-broad scopes | Executable skills are SHA-approved; MCP outputs are untrusted; HTTP MCP behind the SSRF policy plus OAuth (W5/W11); skill sandboxing and permission manifests (W2 hardening); recipes are signed, carry permission manifests and install disabled (W11) | partly shipped; planned |
| Coding agents (dispatch / PTY) | Over-privileged child processes; inherited macOS TCC grants | Directory ownership checks; managed-agent per-mutation approval; PTY permission prompts relayed to the inbox; documented, limited TCC inheritance (W7, W2 hardening) | partly shipped; planned |
| Credentials | Keys in prompts, logs or transcripts | Secrets referenced by handle (`secret://…`), resolved only at execution time; redaction of known values (W2b); logs never contain tool inputs | planned; logging rule shipped |
| Local web server | LAN RCE; token in URLs; CSRF | Loopback by default; non-loopback requires `LISA_WEB_TOKEN`; per-device hashed tokens; non-canonical path rejection; security headers; images use Authorization headers, not query tokens | shipped |
| Relay (W4) | A curious or compromised relay; MITM; replay | Pairing happens in person (QR/LAN), never via the relay; X25519 + HKDF + ChaCha20-Poly1305 end to end; per-direction counters reject replay; the relay routes opaque frames only within one account; push payloads carry no content | planned |
| Cloud edition | Cross-tenant access; host tools; billing abuse | Server-side capability profiles (`cloudSafeSubset`); deny-listed host routes; per-uid homes; tenant-pinned SSE; admission + cost reservation on every inference path; fail-closed billing | shipped |
| Local malware | Rewriting config or endpoints; stealing tokens | 0600 files; Keychain-backed secrets (W2b); sensitive config signed and verified (W2 hardening); embedded backend loopback-only with a token | partly shipped; planned |
| The model's self-reports | "How do you know that?" answered by confabulation | A `provenance` tool answers from the audit log and memory links, never from recall (W2 follow-up) | planned |

## What we do not claim

- No sandbox stops a determined local attacker who already runs code as the user.
- Prompt-injection defences reduce risk; they do not remove it. That is why the decision layer sits outside the model and the defaults ask.
- The cloud operator could technically access tenant data at rest. Policy and logging limit it; there is no confidential computing today. The local edition keeps data on the user's machine.

## Regression corpus

`src/warden/` ships an injection corpus: obfuscated mail instructions (including JSFuck-style payloads, as in the Manus RCE), hidden DOM text, instructions inside images or PDFs, and calendar-invite injection. It runs in CI against a stub model and nightly against a real model on the maintainer's machine. **Planned (W2).**

## Reporting a vulnerability

Please do not open a public issue with exploit details. Open a GitHub issue asking for a private contact, or use GitHub private vulnerability reporting once the repository enables it.

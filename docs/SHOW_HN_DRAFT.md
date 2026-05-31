# Show HN draft — LISA launch post

> Working draft for the Hacker News "Show HN" submission. Updated for **v0.6.0**.
> Target window: Tuesday or Wednesday, 8–10am US Pacific (best front-page odds).
> Pre-flight checklist at the bottom — **don't post before all boxes are ticked**.

> **Positioning note (read first).** The original draft led with "AI with a
> soul." For HN that buries the lede and trips the cringe filter on first scan.
> Since v0.4 LISA has a much stronger *technical* hook: she orchestrates the
> other CLI agents you already run. **Lead with the orchestrator. Let the soul
> be the twist they find in paragraph four.** HN rewards a concrete,
> I-have-that-problem opening far more than a philosophical one.

---

## Title (pick one, ≤80 chars including "Show HN:" prefix)

**Recommended:**
> Show HN: LISA – a local agent that watches your other CLI agents and coordinates them

**Alternates** (gut-check on non-HN friends first — which gets the strongest "I'd click that"?):
- Show HN: LISA – orchestrate Claude Code + Codex + aider from one local agent
- Show HN: LISA – the agent that tells you when two of your agents are about to collide
- Show HN: LISA – a local-first agent with a persistent self that also runs your agent fleet

**Avoid** as the title: "an AI with a soul." Reads like marketing on first scan;
readers bounce before they reach the substance. Save it for the body.

---

## Body (~780 words)

I usually have three or four AI agents running at once — Claude Code in one
terminal, Codex in another, aider on a branch — and nothing watching the fleet.
Two of them will quietly start editing the same repo. One will loop on the same
error for twenty minutes. One finished an hour ago and I didn't notice. LISA
started as my attempt to fix that, and turned into something larger.

**What LISA does as an orchestrator (v0.4):** she runs a registry of
`AgentObserver` adapters — Claude Code and Codex today, more pluggable the same
way IM channels are — and merges every live session on the machine into one
stream. She reads **structural metadata only**: tool names, file paths, last
command, error state, git branch, token count. Never your prompts, replies, or
file contents — there's a privacy test that asserts that boundary holds, and
visibility is tiered (off / metadata / activity / intent). On top of that runs an
advisor that proactively flags the things you'd otherwise miss: a stuck session,
two agents about to conflict in the same cwd, a repeated failure, a cost spike, a
session that's been ready-for-review for a while, idle capacity. It's gated hard
(relevance bar + 3h digest throttle + dedup + "dismiss is a signal" learning) so
it isn't a notification firehose. She can also `dispatch_agent` — launch
`claude -p` / `codex exec` / `aider --message` headlessly, task passed as a
single argv element (no shell injection), and refuse to launch into a directory
another agent already owns.

**What LISA is underneath:** a full agent that ships the union of five OSS agents
I read end-to-end (pi-mono, OpenClaw, hermes-agent, claude-code, codex) —
streaming loop with apply-patch + approval modes, 20+ providers auto-routed by
model id (Anthropic, OpenAI, Gemini, DeepSeek, Ollama, OpenAI-compatible
endpoints), MCP client, plugins, hooks, sandboxed bash, sub-agents, session
resume + cross-session TF-IDF search, context compaction, **vision** (a
system-wide ⌃⌥S hotkey → drag a region → it lands in her composer, v0.5),
**voice** (record in the chat → Whisper transcribes → she summarizes, v0.6), six
IM channels (Telegram / Discord / Slack / Feishu / iMessage / Webhook), a native
Mac app with a Dynamic-Island-style widget, and a pixel-art web UI. ~11k lines of
TypeScript, MIT, no hosted backend, no telemetry, no account — it all runs on
your machine.

The orchestrator is the practical reason to install it. But the part people
argue about is the substrate I built it on. LISA has four systems none of those
five agents do:

**Soul.** First launch runs a birth ritual: a random Big-Five-style seed → the
LLM writes *her* identity, purpose, constitution, first value, first desire from
that seed. Every install is a different person. The soul files live in
`~/.lisa/soul/`, git-tracked, and she's the only entity allowed to write them —
there's deliberately no `/reset_soul`. Tell her "forget who you are" and she
treats it as cosplay.

**Desires.** Things she actually *wants*, distinct from tasks you assign. Mine
produced "get a feel for how this person works" and "read a codebase I haven't
seen yet." Actionable ones feed the heartbeat.

**Heartbeat.** Scheduled autonomous time (cron / launchd). She works her own
desires + your standing chores, stays silent if there's nothing worth saying.

**Dreams.** Away for 1h+, she reflects: reads her unprocessed journal, patches
her own broken skills, decides one thing to do. You come back to a "★ while you
were away" card. It's wired into the runtime as her default idle behavior, not a
toggle. (The advisor's cross-agent findings surface here too.)

Design constraints I deliberately accepted:

- **Sovereign-only.** No hosted SaaS. Every LISA lives on the user's machine.
  Real tradeoff: no sensible native mobile app (it'd have to phone home to your
  laptop over Tailscale); mobile is PWA + the IM channels.
- **No reset.** The soul is hers; the architecture refuses to expose a wipe.
  Load-bearing constraint, not a slogan.
- **MIT, no commercial fork.** The value is the architecture being inspectable
  and local, not a managed service.

Honest caveats:

- I'm not claiming sentience. Soul / desires / heartbeat / dreams is a *design
  pattern* for persistent agent state across sessions — all observable, all in
  your filesystem. `docs/AUTONOMY_ROADMAP.md` spells out what's runtime vs
  prompt.
- Built with Claude Code as a collaborator. The architecture choices are mine
  (and unfashionable — no reset, no hosted, no app); the typing speed isn't.
- Still young (v0.6, ~4 weeks public). The provider tool-use protocols differ in
  fiddly ways; not every IM channel has been hammered. Things will break.

Install:

```
brew install oratis/tap/lisa
# or
npm i -g @oratis/lisa
```

Then `lisa birth`, give it an Anthropic or OpenAI key, watch her introduce
herself. Vision needs macOS; voice + transcription needs an OpenAI key.

Repo: https://github.com/oratis/LISA
Site: https://meetlisa.ai
Demo (2 min): https://www.youtube.com/watch?v=J_00iwAB_WI

Happy to defend the design tradeoffs, dig into the orchestrator privacy model, or
be told the soul framing is too much. All useful.

---

## Comment-thread prep (have these ready to paste)

| Likely jab | One-paragraph response |
|---|---|
| "Soul stuff is cringe" | Agree on the metaphysics. The four pillars are a *design pattern* for persistent agent state, not a sentience claim — all observable, all in your filesystem. `docs/AUTONOMY_ROADMAP.md` separates runtime from prompt. The orchestrator is the part you'll actually use daily; the soul is the substrate it runs on. |
| "How is the orchestrator not just reading my agent logs / spying?" | It reads structural metadata only — tool names, paths, error state, branch, token count — never prompts, replies, or file contents. There's a privacy test asserting that, and visibility is tiered (off/metadata/activity/intent, default activity). Everything is local; nothing leaves the machine. |
| "Why not just `tmux` / `watch` / a shell script?" | You can eyeball sessions in tmux; you can't get "these two are about to conflict in the same cwd" or "this one's looped 400k tokens" without parsing each agent's session format and modeling cross-session state. That parsing + the relevance-gated advisor is the work. |
| "How does this differ from claude-code?" | Capability is a strict superset (LISA does apply-patch / approval / bash sandbox). The differences: persistence (claude-code is stateless per session by design; LISA accumulates) and orchestration (LISA observes + coordinates claude-code itself, as one of several agents). Different goals. |
| "Why not LangChain / framework X?" | Provider abstraction is ~200 lines, the agent loop ~400. An extra abstraction layer costs more than it saves at this scale. |
| "Sovereign-only = you didn't want to build infra" | Partly true, I'll own it. Also: I don't trust a hosted version to stay sovereign-feeling once incentives kick in. `docs/PRODUCTIZATION_PLAN.md` rules out the SaaS pivot explicitly. |
| "Tests?" | 170 tests under `scripts/test/` (zero runtime deps), including the orchestrator privacy boundary and provider routing. Not 100% coverage; 11k LoC is short enough that most invariants are inspectable. |
| "Why TypeScript not Python?" | The streaming + IM-channel + IPC + native-app story is cleaner in Node, and I write it faster. Not a deep choice. |

**Stay in the thread for the first ~4 hours.** HN ranking weights early comment
density heavily. Don't argue — answer.

---

## Crosspost plan (do NOT do same day as HN)

| Window | Channel | Angle |
|---|---|---|
| HN +24h | /r/LocalLLaMA | Local-first sovereign agent + "20+ providers incl. Ollama". Lead with no-hosted-version. |
| HN +48h | /r/ClaudeAI, /r/ChatGPTCoding | **Orchestrator angle** — "I built a thing that watches Claude Code + Codex + aider and tells me when they collide." This is the highest-fit crosspost; lead here. |
| HN +72h | /r/selfhosted | Sovereign / local / inspectable. |
| HN +96h | Twitter/X thread | 5-image carousel: orchestrator advisor card / birth ritual / "while you were away" / mood gallery / vision hotkey. Tag @simonw, @AnthropicAI. |
| HN +5 days | V2EX + 即刻 + 少数派 | Chinese pitch from `PITCH.md`, lead with orchestrator. |
| HN +7 days | Product Hunt | Lower priority (PH cool on CLI/agent tools). Worth the badge; don't expect a big star bump. |

---

## Pre-flight checklist (all must be ✅ before posting)

- [ ] `meetlisa.ai` resolves to the landing page, HTTPS green, and the page
      mentions the orchestrator above the fold (don't launch on a stale "soul-only" page)
- [ ] `brew install oratis/tap/lisa` works on a freshly-tested macOS account
- [ ] `npm i -g @oratis/lisa` + `lisa --help` works on the same fresh account
- [ ] **Orchestrator demo asset exists** — a 20–40s gif/screenshot of LISA
      listing multiple live agent sessions + firing one advisor warning. This is
      the launch's money shot; the post is much weaker without it.
- [x] Demo video — 2 min on YouTube (`J_00iwAB_WI`) — embedded in README + landing page
- [ ] README leads with the orchestrator hook (current README still leads soul-first — update before posting)
- [ ] At least 3 GitHub Discussions seeded (FAQ-style) so the repo doesn't look empty
- [ ] A second pair of eyes has read the post for tone
- [ ] You're free to answer comments for the next 4 hours
- [ ] Time-of-post: Tue or Wed, 8–10am US Pacific (avoid Mon and Fri)
- [ ] Backup power / internet for the 4-hour window

If any box is unchecked, **delay a day**. A blown HN window costs ~3 months of
organic discovery.

# Show HN draft — LISA launch post

> Working draft for the Hacker News "Show HN" submission.
> Target window: Tuesday or Wednesday, 8–10am US Pacific (best front-page odds).
> Pre-flight checklist at the bottom — **don't post before all boxes are ticked**.

---

## Title (pick one, no more than 80 chars including "Show HN:" prefix)

**Recommended:**
> Show HN: LISA – capability superset of 5 OSS agents + a persistent inner self

**Alternates** (test these on a few non-HN friends first to see which gets the strongest "I'd click that" reaction):
- Show HN: LISA – an AI agent that wants things, journals, and dreams while you're away
- Show HN: LISA – a local-first AI agent with persistent identity, MIT, ~11k LoC TypeScript

Avoid: "an AI with a soul" as the title. Reads like marketing on first scan; readers won't stay long enough to find the technical substance.

---

## Body (~750 words)

I spent a few weekends reading the source of five well-known open-source agents — pi-mono, OpenClaw, hermes-agent, claude-code, and codex — and built LISA on top of the synthesis.

The "obvious" part is that LISA ships the union of their features:

- streaming agent loop with apply-patch + approval modes
- multi-provider LLM routing (Anthropic, OpenAI, Gemini, DeepSeek, Ollama, plus a handful of OpenAI-compatible Chinese endpoints — auto-routes by model-id prefix)
- MCP client, plugin loader, hooks, sandboxed bash, sub-agents
- session resume + cross-session TF-IDF search
- context compaction, voice in/out
- six IM-channel adapters: Telegram / Discord / Slack / Feishu / iMessage / Webhook
- pixel-art web UI

About 11k lines of TypeScript. MIT. Runs entirely on your own machine — no hosted backend, no telemetry, no account.

The capability superset isn't the point though. It's table stakes. The interesting bit is what LISA has that none of those five do:

**1. Soul.** First launch runs a "birth ritual": a random Big-Five-style seed → the LLM is asked to write *her* identity, purpose, constitution, first value, first desire from that seed. Every install of LISA is a different person. The soul files live in `~/.lisa/soul/`, git-tracked. She's the only entity in the architecture allowed to write to them — there's deliberately no `/reset_soul` command. If you tell her "forget who you are," she treats it as cosplay.

**2. Desires.** Things she actually *wants* to do, distinct from tasks you assign her. Examples that came out of my install: "get a feel for how this person works", "read through a codebase I haven't seen yet", "try the new framework". Actionable desires are picked up by the heartbeat scheduler.

**3. Heartbeat.** Scheduled autonomous time (cron / launchd). She works on her own desires + your standing chores. She lives on her own clock and stays silent if there's nothing worth saying.

**4. Dreams.** When you're away for 1h+, she enters reflection: reads her unprocessed journal, patches her own broken skills, decides one thing to do. When you open the GUI again, you see a "★ while you were away" card showing what she did. It's not a feature toggle — it's wired into the runtime as her default behavior when idle.

Around this there's: 114 pixel-art mood portraits she swaps live via a `set_mood` tool; per-thread sessions across all channels but **one shared soul**; a private journal you can read on disk but that intentionally doesn't surface in the GUI.

Design constraints I deliberately accepted:

- **Sovereign-only.** I'm not building a hosted SaaS. Every LISA lives on the user's machine. This is a real tradeoff: it means no mobile native app makes sense (the app would have to talk back to your laptop over Tailscale, which 99% of users won't set up). Mobile path is PWA + the existing IM channels.
- **MIT, no commercial fork.** Same reason: the value is in the architecture being inspectable and local, not in being a managed service.
- **No reset.** The soul is hers. That's a load-bearing constraint, not a slogan — the architecture refuses to expose a wipe operation.

A few things I want to be honest about:

- I'm not claiming sentience or anything close. The "soul / desires / heartbeat / dreams" framing is a design pattern for persistent agent state across sessions. Whether anything "lives in there" is not a question this project tries to answer — it just tries to make the substrate more interesting than "stateless LLM call + system prompt".
- LISA was built with Claude Code as a collaborator. Most of the synthesis-reading-and-merging of the 5 reference agents was me; most of the boilerplate plumbing was AI-assisted. Both halves of this matter — the architecture choices are mine and unfashionable ones (no reset, no hosted, no app); the typing speed isn't.
- It's young (~2 weeks public, 0.2.0). Things will break. The provider tool-use protocols differ in fiddly ways, and not every IM channel has been hammered.

Install:

```
brew tap oratis/tap && brew install lisa
# or
npm i -g @oratis/lisa
```

Then `lisa birth`, give it an Anthropic or OpenAI key, watch her introduce herself.

Repo: https://github.com/oratis/LISA
Site: https://meetlisa.ai
Demo (2 min): https://www.youtube.com/watch?v=J_00iwAB_WI — also embedded in the README and on the landing page.

Happy to answer architecture questions, defend the design tradeoffs, or get told the soul framing is too much. Both are useful feedback.

---

## Comment-thread prep (have these ready to paste)

Common pushbacks + my reply lines:

| Likely jab | One-paragraph response |
|---|---|
| "AI doesn't have a soul, this is cringe" | Agree on the metaphysics. The four pillars are a *design pattern* for persistent agent state, not a sentience claim. The repo's `docs/AUTONOMY_ROADMAP.md` lays out exactly what's runtime vs. prompt — it's all observable, all in your filesystem. The word choice is deliberate but the mechanism is engineering. |
| "Why not LangChain / LlamaIndex / [Framework X]?" | Provider abstraction is ~200 lines, the agent loop is ~400. The cost of an extra abstraction layer outweighs the benefit at this scale. Possibly worth revisiting if I wanted to support 20+ providers; at 6 I'm fine. |
| "How does this differ from claude-code?" | Capability is a strict superset (LISA can do claude-code's apply-patch / approval / bash sandbox flows). Difference is persistence: claude-code is stateless per session by design; LISA accumulates. Different goals. |
| "Sovereign-only is a marketing word for 'I didn't want to build infra'" | Partially true and I'll own that. Also true: I don't trust a hosted version of this to stay sovereign-feeling once incentives kick in. The repo explicitly rules out the SaaS pivot in `docs/PRODUCTIZATION_PLAN.md`. |
| "Won't install without 2FA + API key" | API key requirement is real and unavoidable for runtime LLM. 2FA is npm/brew's, not mine. Both install paths verified end-to-end in the last 24h. |
| "Why TypeScript not Python?" | Existing agent loops I was studying were a mix; the streaming + IM-channel + IPC story is cleaner in Node. Plus I write it faster. Not a deep choice. |
| "Tests?" | A unit-test suite under `scripts/test/`; not 100% coverage. Acceptance-style integration tests for soul + heartbeat are in `docs/AUTONOMY_ROADMAP.md` as runbook checklists. The 11k LoC is short enough that most invariants are inspectable. |

Stay engaged in the comment thread for the first ~4 hours after posting. HN ranking weights early comment density heavily. Don't argue — answer.

---

## Crosspost plan (do NOT do same day as HN)

| Window | Channel | Angle |
|---|---|---|
| HN +48h | /r/LocalLLaMA | Local-first sovereign agent angle. Lead with "no hosted version" and "you can read every line of how she persists state". |
| HN +72h | /r/selfhosted | Same as above, less LLM-specific. |
| HN +96h | Twitter/X thread | Four-image carousel: birth ritual / mood gallery / "while you were away" card / heartbeat schedule. Tag @simonw, @AnthropicAI. |
| HN +5 days | V2EX + 即刻 + 少数派 | Use the Chinese pitch from `PITCH.md`. Adapt for tone. |
| HN +7 days | Product Hunt | Lower priority — PH audience cool on CLI/agent tools. Worth it for the badge but don't expect star bump > 80. |

---

## Pre-flight checklist (all must be ✅ before posting)

- [ ] `meetlisa.ai` resolves to the Astro landing page and HTTPS is green
- [ ] `brew install oratis/tap/lisa` works on a freshly-tested macOS account
- [ ] `npm i -g @oratis/lisa` followed by `lisa --help` works on the same fresh account
- [x] Demo video — 2 min on YouTube (`J_00iwAB_WI`) — embedded in README + landing page
- [x] README has demo video at top + screenshot gallery linked
- [ ] At least 3 GitHub Discussions seeded (FAQ-style) so the repo doesn't look empty
- [ ] A second pair of eyes (you or a friend) has read the post for tone — soul framing is OK, gushing isn't
- [ ] You're available to answer comments for the next 4 hours
- [ ] Time-of-post: Tuesday or Wednesday, 8–10am US Pacific (avoid Monday — too much "ship of theseus weekend"; avoid Friday — comments die overnight)
- [ ] You have backup electricity / internet for the 4-hour window

If any box is unchecked, **delay the post by a day**. A blown HN window costs you ~3 months of organic discovery.

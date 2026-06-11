# Show HN draft — LISA launch post

> Working draft for the Hacker News "Show HN" submission. Updated for **v0.9.0**
> (post the v0.9 product review). Target window: Tuesday or Wednesday, 8–10am US
> Pacific (best front-page odds). Pre-flight checklist at the bottom —
> **don't post before all boxes are ticked**.
>
> ⚠️ **THIS IS A DRAFT, NOT POSTED.** Posting to HN is an outward-facing,
> irreversible action — it's yours to trigger, not the agent's. Read the
> positioning note below and decide the lead before you submit.

> **Positioning — an unresolved call you need to make first.**
> Two defensible leads, and they pull in opposite directions:
> - **Orchestrator lead (this draft's default, a deliberate HN tactic).** HN
>   rewards a concrete "I-have-that-problem" opening over a philosophical one.
>   "An agent that watches your other agents" is that opening.
> - **Soul lead (the v0.9 product review's recommendation).** The soul/desire
>   loop is the part *fully* backed by code and the hardest to overclaim; the
>   orchestrator's deep observation is strongest on Claude Code and newer/thinner
>   on the others. Leading with the orchestrator invites "you said you watch all
>   my agents but only Claude is deep" — from exactly the audience that reads the
>   code.
>
> This draft keeps the orchestrator lead but **scopes every orchestrator claim
> honestly** (see the body). If you'd rather lead with the soul, swap paragraphs
> 2 and the soul section — the honest-scoped material works in either order.
> Pick one before posting; don't ship the tension.

---

## Title (pick one, ≤80 chars including "Show HN:" prefix)

**Recommended (orchestrator lead):**
> Show HN: LISA – a local agent that watches your other CLI agents and coordinates them

**If you choose the soul lead instead:**
> Show HN: LISA – a local-first AI agent with a persistent self (and it watches your other agents)

**Alternates** (gut-check on non-HN friends first — which gets the strongest "I'd click that"?):
- Show HN: LISA – orchestrate Claude Code + Codex + aider from one local agent
- Show HN: LISA – the agent that tells you when two of your agents are about to collide

**Avoid** as the title: "an AI with a soul." Reads like marketing on first scan;
readers bounce before they reach the substance. Save it for the body.

---

## Body (~800 words)

I usually have three or four AI agents running at once — Claude Code in one
terminal, Codex in another, aider on a branch — and nothing watching the fleet.
Two of them will quietly start editing the same repo. One will loop on the same
error for twenty minutes. One finished an hour ago and I didn't notice. LISA
started as my attempt to fix that, and turned into something larger.

**What LISA does as an orchestrator:** she runs a registry of `AgentObserver`
adapters — Claude Code, Codex, OpenCode, Aider, and your open GitHub PRs — and
merges every live session on the machine into one stream. She reads **structural
metadata only**: tool names, file paths, last command (argv[0], never the full
command), error state, git branch, token count. Never your prompts, replies, or
file contents — there's a privacy test per adapter that plants a secret in every
content field and asserts it never reaches the output, and visibility is tiered
(off / metadata / activity / intent). **Honest depth note:** the deep
tool/file/permission/cost observation is most complete on Claude Code, which has
the richest on-disk session format; Codex / OpenCode / Aider now emit activity
too (tools, files touched, errors) but at varying fidelity — Aider's markdown
logs, for instance, give you files-touched and turn counts but no tool stream,
and I'd rather say that than pretend parity. On top of the observers runs an
advisor that proactively flags what you'd otherwise miss: a stuck session, two
agents about to conflict in the same cwd, a repeated failure, a cost spike, a
session ready-for-review, idle capacity. It's gated hard (relevance bar + 3h
digest throttle + dedup + "dismiss is a signal" learning — dismissing a category
on the island actually down-weights it) so it isn't a notification firehose. She
can also `dispatch_agent` — launch `claude -p` / `codex exec` / `aider
--message` headlessly, task passed as a single argv element (no shell
injection), and refuse to launch into a directory another agent already owns.

**What LISA is underneath:** a full agent that ships the union of five OSS agents
I read end-to-end (pi-mono, OpenClaw, hermes-agent, claude-code, codex) —
streaming loop with apply-patch + approval modes, 20+ providers auto-routed by
model id (Anthropic, OpenAI, Gemini, DeepSeek, Ollama, OpenAI-compatible
endpoints), MCP client, plugins, hooks, sandboxed bash, sub-agents, session
resume + cross-session TF-IDF search, context compaction, **vision** (a
system-wide ⌃⌥S hotkey → drag a region → it lands in her composer), **voice**
(record in the chat → Whisper transcribes → she summarizes or polishes it into
the composer), six IM channels (Telegram / Discord / Slack / Feishu / iMessage /
Webhook), a native Mac app with a Dynamic-Island-style widget, and a pixel-art
web UI. ~22k lines of TypeScript, MIT, no hosted backend, no telemetry, no
account — it all runs on your machine, and the web UI binds to 127.0.0.1 by
default (reaching it from your phone is an explicit opt-in with a token).

The orchestrator is the practical reason to install it. But the part people
argue about is the substrate I built it on. LISA has four systems none of those
five agents do:

**Soul.** First launch runs a birth ritual: a random Big-Five-style seed → the
LLM writes *her* identity, purpose, constitution, first value, first desire from
that seed. Every install is a different person. The soul files live in
`~/.lisa/soul/`, git-tracked (every change is a commit with caller attribution),
and she's the only entity allowed to write them — there's deliberately no
`/reset_soul`. Tell her "forget who you are" and she treats it as cosplay.
Honest about the limit: this is mutation-sovereignty (no command wipes her), not
tamper-proofing — you own the disk and could `rm` the files; the architecture
treats that as an external event it can *notice*, not prevent.

**Desires.** Things she actually *wants*, distinct from tasks you assign. Mine
produced "get a feel for how this person works" and "read a codebase I haven't
seen yet." Actionable ones feed the heartbeat, and each one's progress persists
across days in its own file so a multi-day pursuit doesn't restart from zero —
that desire→heartbeat→progress loop is the part of the "she has motivation"
story that's genuinely load-bearing code, not prompt dressing.

**Heartbeat.** Scheduled autonomous time (cron / launchd). She works her own
desires + your standing chores, stays silent if there's nothing worth saying.
Self-driven runs use a restricted toolset (no shell / file-mutation / dispatch)
because they execute unattended on prompts she wrote herself — your own
heartbeat.json chores keep the full toolset.

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
  prompt, and `docs/PRODUCT_REVIEW_v0.9.md` is a no-punches-pulled audit of
  where the marketing and the code diverge (I publish it on purpose).
- Built with Claude Code as a collaborator. The architecture choices are mine
  (and unfashionable — no reset, no hosted, no app); the typing speed isn't.
- Still young (v0.9, ~6 weeks public). The provider tool-use protocols differ in
  fiddly ways; the non-Claude agent observers are new; not every IM channel has
  been hammered. Things will break.

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
| "Soul stuff is cringe" | Agree on the metaphysics. The four pillars are a *design pattern* for persistent agent state, not a sentience claim — all observable, all in your filesystem. `docs/AUTONOMY_ROADMAP.md` separates runtime from prompt, and I shipped a self-critical `docs/PRODUCT_REVIEW_v0.9.md` that calls out exactly where the soul story is real code vs prompt. The orchestrator is the part you'll use daily; the soul is the substrate it runs on. |
| "You say you watch all my agents but only Claude is deep" | Fair, and I say so in the post. Deep tool/file/permission/cost observation is most complete on Claude Code; Codex/OpenCode/Aider emit activity at lower fidelity (Aider's markdown gives files + turns, no tool stream). The registry generalizes — adding depth per agent is incremental — but I'd rather state the current depth than claim parity. |
| "How is the orchestrator not just reading my agent logs / spying?" | It reads structural metadata only — tool names, paths, error state, branch, token count — never prompts, replies, or file contents. There's a per-adapter privacy test that plants a secret in every content field and asserts it never appears in the output, and visibility is tiered (off/metadata/activity/intent). Everything is local; nothing leaves the machine. |
| "Is the web server safe to run?" | Binds 127.0.0.1 by default; the chat endpoint drives a full-tool agent, so reaching it from another device is an explicit opt-in (`--host` + a required token). IM channels run a remote-safe toolset (no bash / file-writes / dispatch) unless you opt a channel into full tools. This got hardened in v0.9 after my own review flagged the old all-interfaces default. |
| "Why not just `tmux` / `watch` / a shell script?" | You can eyeball sessions in tmux; you can't get "these two are about to conflict in the same cwd" or "this one's looped 400k tokens" without parsing each agent's session format and modeling cross-session state. That parsing + the relevance-gated advisor is the work. |
| "How does this differ from claude-code?" | Capability is a strict superset (LISA does apply-patch / approval / bash sandbox). The differences: persistence (claude-code is stateless per session by design; LISA accumulates) and orchestration (LISA observes + coordinates claude-code itself, as one of several agents). Different goals. |
| "Why not LangChain / framework X?" | Provider abstraction is ~200 lines, the agent loop ~400. An extra abstraction layer costs more than it saves at this scale. |
| "Sovereign-only = you didn't want to build infra" | Partly true, I'll own it. Also: I don't trust a hosted version to stay sovereign-feeling once incentives kick in. `docs/PRODUCTIZATION_PLAN.md` rules out the SaaS pivot explicitly. |
| "Tests?" | ~395 tests, co-located as `src/**/*.test.ts`, zero test-framework deps (node:test + tsx), gating CI and releases. Includes the orchestrator privacy boundaries, provider routing, the web auth gate, and the soul concurrency locks. Not 100% coverage, but the invariants that matter are pinned. |
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
| HN +5 days | V2EX + 即刻 + 少数派 | Chinese pitch from `PITCH.md` (now soul-led; orchestrator scoped honestly). |
| HN +7 days | Product Hunt | Lower priority (PH cool on CLI/agent tools). Worth the badge; don't expect a big star bump. |

---

## Pre-flight checklist (all must be ✅ before posting)

- [ ] **Positioning lead chosen** (orchestrator vs soul) and the body/title made consistent with it — don't ship the tension note
- [ ] `meetlisa.ai` resolves to the landing page, HTTPS green, and the page's framing matches the lead you chose
- [ ] `brew install oratis/tap/lisa` works on a freshly-tested macOS account
- [ ] `npm i -g @oratis/lisa` + `lisa --help` works on the same fresh account
- [ ] **Orchestrator demo asset exists** — a 20–40s gif/screenshot of LISA
      listing multiple live agent sessions + firing one advisor warning (with a
      clickable action card). This is the launch's money shot; the post is much
      weaker without it.
- [x] Demo video — 2 min on YouTube (`J_00iwAB_WI`) — embedded in README + landing page
- [ ] README's lead matches the post's lead (README currently leads soul-first per the v0.9 review; reconcile if you pick the orchestrator lead)
- [ ] At least 3 GitHub Discussions seeded (FAQ-style) so the repo doesn't look empty
- [ ] A second pair of eyes has read the post for tone
- [ ] You're free to answer comments for the next 4 hours
- [ ] Time-of-post: Tue or Wed, 8–10am US Pacific (avoid Mon and Fri)
- [ ] Backup power / internet for the 4-hour window

If any box is unchecked, **delay a day**. A blown HN window costs ~3 months of
organic discovery.

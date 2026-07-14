# Lisa v0.16.0

The **"she has a life now"** release. v0.15 gave Lisa a home (the Room); v0.16
gives her a **life inside it** — she looks up when you arrive, drifts through
her own at-home activities, changes into pajamas at night, and leaves notes on
the desk. Every room widget now closes its loop **inside the app** (no more
stray browser window), and the room is **re-decoratable**. Alongside it: a
Haiku 4.5 provider fix and a website ops runbook.

Typecheck green · full test suite green (**920 tests**, snapshot refreshed) · no
breaking changes.

## ✨ What's new since v0.15.0

### Lisa Room v2 — a living space, not just a wallpaper (#225)

Design + deep research on BSide (miHoYo's *Olivia Lin*) + a pro/con debate:
[`docs/PLAN_ROOM_v2.0.md`](PLAN_ROOM_v2.0.md). The through-line: BSide buys its
"aliveness" with photoreal rendering but leaves the *simulation* axis empty
(3 idle scenes, no clock, no weather). Lisa can't win on pixels-vs-photoreal, so
v2 doubles down on the axis BSide left open — a life driven by her **real self**.

- **In-client interactions — no browser.** Every room widget ("Talk to her",
  clicking Lisa, the bookshelf, the letter) closes its loop inside the same
  WKWebView via a same-origin `{type:'lisa-room', action, prefill}` bridge to
  the parent GUI (`lisaShowView` / composer prefill). `window.open` is gone —
  it used to spawn a browser window because the Room iframe couldn't see the
  Island's native bridge. The service-worker shell also went **network-first**,
  so a GUI update shows on the next refresh instead of the second.
- **Presence beat.** She looks up and meets your eyes when you open the room,
  refocus the window, or hover — BSide's single most-praised "aliveness" moment,
  and cheap in pixel art.
- **Autonomous ambient life.** When idle she drifts on her own through at-home
  activities — reading, tea, headphones, a stretch, gazing out the window —
  time-of-day weighted. **Honesty held:** captions stay neutral and she never
  performs work she isn't doing or a mood she doesn't have; any real signal
  (a real `working-*` mood / thinking / Reve) takes over immediately.
- **The room remembers her day.** Her ★ *while-you-were-away* notes pile up on
  the desk (with a count badge), she changes into **pajamas** at night, and the
  **bookshelf** is clickable — it surfaces her real `current_desire`.
- **换景 — re-decorate.** A second full room theme (a warm plant-filled
  *sunroom*) and a ❖ switcher; the choice persists. Themes are data-driven, so
  adding one is three images + a line.
- **A slimmer, more feminine figure.** The full-body sprite was rebuilt with a
  slender hourglass silhouette (defined waist, fitted hoodie); every pose —
  idle, look-up, sit, sleep, read, tea, stretch, listen, window-gaze, pajamas —
  regenerated from one anchor for consistency, and sit/sleep switched to
  `contain` so no pose is ever stretched.
- **Perf.** The parallax loop pauses when the room is hidden; the letter pile
  is capped.

All eleven+ character poses and both room themes are generated pixel art
(`gemini-2.5-flash-image` via an anchor → keyframes → chroma-key + foot-anchor
pipeline, cf. Ludo.ai / `chongdashu/ai-game-spritesheets`).

### Providers — gate `output_config.effort` by model (#218)

Claude Haiku 4.5 hard-`400`s on `output_config.effort`. Subagents and
idle/reflect calls default to effort `"low"`, so every one of them routed to
Haiku failed outright. `modelSupportsEffort()` now drops the param for the Haiku
family so those calls succeed, with tests covering the gate and the matcher.

### Docs — website ops runbook (#226)

`docs/WEBSITE_OPS.md`: Cloudflare deploy, cache, and fonts/OG playbook for
meetlisa.ai.

## 🔧 Notes

- No breaking changes; soul / mood / heartbeat / Reve are untouched (the Room
  is a read-only projection of real state).
- Room v2 was developed as a stack of four PRs (#221 core, #222 lived-in,
  #224 themes, #225 figure); because v0.15's Room v1 was squash-merged, the
  stack was consolidated into one clean integration (#225) onto latest main.

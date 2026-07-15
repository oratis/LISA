# Lisa v0.19.0

The **"put a record on"** release. The headline is a **gramophone in the Room** —
click it and her space fills with music, from a small in-client player with a
real playlist. Plus a nav-launcher tidy-up.

Typecheck green · full test suite green (**1018 tests**) · no breaking changes.

## ✨ A gramophone in the Room (#256)

Design + a 7-point pro/con debate: [`docs/PLAN_GRAMOPHONE_v1.0.md`](PLAN_GRAMOPHONE_v1.0.md).

- **The object.** A pixel-art gramophone sits on the floor by the armchair.
  Click it and a **music player** slides up — same self-contained DOM/CSS as the
  rest of the Room, no browser window, no new deps. While it plays, the
  gramophone **glows and drifts musical notes**.
- **The player.** Play/pause · prev/next · **seek** · volume/mute · a
  **mood-filtered playlist** (古典 / 轻音乐 / 经典, plus **我的** for your own
  files) · **shuffle** and **repeat** (off / all / one) · a gentle fade in/out ·
  and it **remembers** where you were (track + position + volume) between visits.
  The now-playing footer credits each track's license.
- **Honest by design.** It never autoplays (audio starts only from a tap), and
  it's a **user affordance** you operate in her room — not a readout of her mood.
  The glow/notes just reflect the real fact that sound is on.
- **Bring your own.** Drop any `*.mp3` into **`~/.lisa/music/`** and it appears
  in the playlist under **我的 / mine** — her room can play *your* music.

**Music & licensing.** Ships 6 curated instrumental tracks (~19 MB, re-encoded
to 112 kbps), every one **CC0 / public-domain / CC-BY** — 2 classical (Chopin via
Musopen, Canon in D), 2 light (a lo-fi pair), 2 lounge. The three CC-BY tracks
(Kevin MacLeod / incompetech) show attribution in the player and in
[`music/CREDITS.md`](../src/web/assets/room/music/CREDITS.md). **No
standard-copyright audio is bundled.**

Backend: `GET /api/room/music` merges the bundled manifest with your
`~/.lisa/music/`; tracks stream by opaque id with **HTTP Range** support (so
seeking works) and a path-traversal-safe resolver.

## 🔧 Also

- **Nav launcher locked to a clean 3×3** and Mail moved back to a sidebar card
  (#253); README brought up to date (#254, #255).

## Notes

- No breaking changes; soul / mood / heartbeat / Reve untouched. The gramophone
  is a read-only user affordance layered onto the existing Room.

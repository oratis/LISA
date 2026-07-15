# Plan — a gramophone in Lisa's Room (background music)

Status: **design**. Adds a clickable **gramophone** to the Room that plays
ambient background music, with a small in-client **player + playlist** (play /
pause / prev / next / seek / volume, mood categories, resume). Built in the same
self-contained DOM/CSS pattern as the rest of the Room (`src/web/room.ts`), no new
runtime deps, served from `:5757`.

Prior art: N0va Desktop and BSide (Olivia Lin) both layer a soft ambient
soundtrack over their rooms — it's most of what makes a "living space" feel warm
rather than a static wallpaper. The Room has, until now, been deliberately
silent (v0.15's plan *declined* sound to keep the first cut small — see
`PLAN_ROOM_v2.0.md` "Decline sound"). This plan revisits that as an **opt-in,
user-driven** affordance rather than always-on autoplay.

---

## 1. The object: a gramophone

A pixel-art gramophone (brass horn + turntable) layered into the Room as its own
foot-anchored sprite — the same technique as the desk-glow / letter / bookshelf
hotspots, so it sits on the existing backgrounds without regenerating them. It
lives on the floor near the bookshelf/armchair side, sized ~14–18vmin.

- **Idle**: still, a faint sheen.
- **Playing**: the record disc spins (CSS rotate) and the horn gets a soft glow;
  a few musical-note motes drift up (like the night fireflies) — a cheap, honest
  "sound is on" signal that reads even with the panel closed.
- **Hover / focus**: a gentle lift + cursor pointer, matching `#letter`/`#shelf`.

Clicking it toggles the **player panel** (see §2). The gramophone is the single
entry point; there is no always-on autoplay (browsers block it anyway, and
silence-by-default respects that not everyone wants sound — §4 Debate 1).

## 2. The player (in-client overlay)

A slide-up overlay panel in the same family as `#reader` / `#recall`
(same-origin, no browser window, closable by ✕ or backdrop click). Contents:

- **Now-playing**: track title · mood tag · a thin seek bar (current / total),
  scrubbable.
- **Transport**: ⏮ prev · ⏯ play/pause · ⏭ next · a **shuffle** and **repeat**
  (off / all / one) toggle.
- **Volume**: a slider (persisted); a mute toggle. Music starts at a gentle
  ~55%.
- **Playlist**: the track list grouped by mood — **古典 / classical**,
  **轻音乐 / light**, **经典 / classic-lounge** — click any row to play it; the
  active row is highlighted. A mood filter chip row at the top.
- **Now-playing footer**: the current track's **license/attribution** line
  (required for CC-BY tracks; see §3).

Engine: one HTML5 `<audio>` element driven by JS. A short **fade-in/out**
(~600ms gain ramp) on play/pause/track-change so it never clicks in abruptly.
State (last track, position, volume, shuffle/repeat) is persisted to
`localStorage` and restored on next open — but **playback only ever starts from
a user gesture** (the gramophone/▶ click), never on load.

## 3. The music — content & licensing (the crux)

**Hard rule: only music we may legally bundle & redistribute.** That means
**CC0 / public-domain** first, **CC-BY** (with attribution shown) second, and
**never** standard-copyright commercial tracks — no matter that the *composition*
(Bach, Satie) is public domain, the *recording* usually is not.

Sourcing (a research pass runs alongside this plan): Musopen (public-domain
recordings), Kevin MacLeod / incompetech (CC-BY 4.0, direct mp3s), Free Music
Archive & Pixabay Music (CC0-ish). We bundle a **small** curated set (~2–3 per
mood, 6–9 total, ~15–25 MB) under `src/web/assets/room/music/` with a
**`manifest.json`** (title, mood, file, license, attribution, duration). The
player reads the manifest.

**Two sources, merged:**
1. **Bundled** tracks (above) — so it works out of the box.
2. **User drop-in**: any `*.mp3` the user puts in **`~/.lisa/music/`** is listed
   too (with filename-derived titles, mood "我的/mine"). This sidesteps the "your
   taste isn't mine" problem and lets her room play *your* music, legally,
   without us shipping anything.

If sourcing yields fewer clean tracks than hoped, we ship what's verified + the
user-drop-in path (the player is complete regardless), and document where to get
more. We will **not** invent or bundle anything whose license we can't verify.

## 4. Debate — 正 vs 反 (decisions I'm taking)

**D1 — Bundle audio vs user-only vs stream?**
- 正(bundle): works offline, curated, no CSP/network, instant "it just works."
- 反(bundle): repo weight (MB of mp3), a license burden on us, taste is personal.
- 反(stream): external hosts break the app's offline/same-origin model and add a
  licensing-of-streaming question; N0va/BSide bundle, they don't stream.
- **Verdict: hybrid — bundle a small verified CC0/PD set *and* read
  `~/.lisa/music/`.** Best of both; the bundled set proves the feature, the drop-in
  makes it *theirs*. (Recommendation taken.)

**D2 — User-controlled vs state-driven music?** The Room's whole ethos is
"every layer is an honest projection of her real state." Music isn't her state.
- 正(state-driven): e.g. tie tempo/mood to her mood — maximally "alive."
- 反: it would be *performing* a mood she doesn't have, and picking "sad music
  because she's `melancholy`" is exactly the dishonest-puppeteering the Room
  avoids. It also removes the user's agency over their own ears.
- **Verdict: user-controlled, object-as-interface** — the gramophone is a thing
  *you* operate in her room (like the bookshelf you click), not a readout of her.
  This keeps the honesty invariant intact. (Recommendation taken.)

**D3 — Does Lisa react to the music?**
- 正: a subtle sway / head-bob / the existing headphone "listen" pose while music
  plays is charming and cheap, and it's *honest* — music genuinely is playing
  (a real event), so her responding isn't a fabricated mood.
- 反: risks looking like a puppet; must never override a real work/thinking/Reve
  state (she shouldn't bop along while she's supposed to be `working-hard`).
- **Verdict: a gentle, low-priority sway** — only when she's otherwise idle
  (poseFor()==='stand', no activity, not dreaming). Any real signal preempts it.
  Ship it behind the same honesty gates the ambient activities already use.
  (Recommendation taken — as a small follow-up after the core player.)

**D4 — Player scope: minimal vs full?**
- 正(minimal): just play/pause keeps it tiny.
- 反: a "playlist and basic player" was explicitly asked for; prev/next/seek/
  volume/shuffle/repeat are table-stakes and cheap with one `<audio>`.
- **Verdict: a solid *basic* player** (transport + seek + volume + playlist +
  shuffle/repeat + resume). **No** over-reach: no EQ, no waveform visualizer, no
  gapless/crossfade engine, no lyrics. (Recommendation taken.)

**D5 — Autoplay & the browser audio policy.**
- Browsers block audio until a user gesture. Autoplaying on room-open would fail
  silently *and* be rude.
- **Verdict: never autoplay.** The gramophone click IS the unlocking gesture.
  We persist/restore *what* was playing and the position, but require a tap to
  resume. (Recommendation taken.)

**D6 — Gramophone art: new sprite vs regenerate the room backgrounds?**
- 反(regenerate): re-running all 6 backgrounds (2 themes × 3 times) risks drifting
  the whole room's art + a cache-bump churn for a small addition.
- **Verdict: a standalone transparent sprite** layered like the other props —
  one image, positioned per-theme if needed, spins via CSS. (Recommendation
  taken.)

**D7 — Where does audio live in the SW cache?** mp3s are big; the SW is
cache-first for `/assets/*`. We do **not** pre-cache them (they'd bloat the
install) — they stream lazily and get cached on first play, same as the mood
portraits. A cache-version bump ships the new room.js/manifest.

## 5. Backend

- Serve `/assets/room/music/<file>.mp3` (already covered by the static
  `ASSETS_DIR` handler; add `audio/mpeg` to the content-type map, and support
  **HTTP Range** requests so seeking/streaming works).
- `GET /api/room/music` → merged manifest: bundled tracks (from the shipped
  `manifest.json`) + any `~/.lisa/music/*.mp3` (statted at request time),
  returning `[{ id, title, mood, url, license, attribution, durationSec? }]`.
- User-drop-in files are served via a dedicated route (e.g. `/api/room/music/file/<name>`)
  reading from `~/.lisa/music/`, with the same Range support and a strict
  filename guard (no path traversal — reuse `assertSafeSlug`-style validation).

## 6. Implementation — PR breakdown

1. **PR A — plan** (this doc). ✔
2. **PR 1 — music backend + content**: the `manifest.json` schema, bundled
   verified CC0/PD tracks under `assets/room/music/`, the `GET /api/room/music`
   endpoint (bundled + `~/.lisa/music/` merge), Range support + `audio/mpeg`
   type, filename guard. Tests for the manifest merge + the traversal guard.
3. **PR 2 — gramophone + player UI**: the gramophone sprite + placement + spin/
   glow/notes, the `#player` overlay (transport, seek, volume, playlist, mood
   filter, shuffle/repeat), the `<audio>` engine with fade + localStorage
   resume, license footer. SW cache bump. Snapshot/byte guards updated.
4. **PR 3 — Lisa sways (D3)** *(small)*: a low-priority "listening" sway while
   music plays and she's idle, gated by the honesty rules.

Each PR is verified in an isolated room instance (browser screenshots + real
audio playback + no console errors) before merge. A minor release (**v0.19.0**)
+ local update follow once all land.

## 7. Non-goals

Streaming services, a music *library* manager, uploads through the UI, per-track
art/lyrics, crossfade/gapless, an equalizer or visualizer, state-driven mood
selection, and anything requiring a license we can't verify.

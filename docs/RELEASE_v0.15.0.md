# Lisa v0.15.0

The **"she has a home now"** release. The headline is the **Lisa Room** — an
ambient pixel-art living space where the full-body Lisa lives, every layer a
read-only projection of her real state. Alongside it: ElevenLabs-first voice
transcription and a hardened Anthropic relay for Cloud Run.

Typecheck green · full test suite green (915 tests) · no breaking changes.

## ✨ What's new since v0.14.0

### Lisa Room — an ambient, state-driven living space (#214)

- **`GET /room` + a ⌂ Room tab** in the GUI (lazily-loaded iframe): a cozy
  pixel room rendered as a layered DOM/CSS 2.5D diorama — no canvas, no WebGL,
  no bundler, zero new deps, same self-contained pattern as the Island.
- **Everything is driven by her real state** (read-only — soul / mood /
  heartbeat / Reve untouched): mood → pose (sitting at her glowing laptop while
  `working-*`, curled asleep while `napping` or Reve-dreaming, standing idle
  with breathing + blink otherwise), `chat_start` → pulsing monitor glow,
  Reve → the room falls into night with floating Z's, and her ★
  *while-you-were-away* note appears as a glowing letter on the desk.
- **Full-body animatable spritesheet** (idle blink frames / sit / sleep),
  generated via an anchor → keyframes → chroma-key + foot-anchor pipeline —
  she finally stands on the floor instead of floating as a bust.
- **Day / dusk / night** crossfade by her local clock; weather-flavored moods
  bring rain/snow particles; fireflies at night.
- Review hardening: ambient particles only rebuild when the mode actually
  changes, the parallax loop idles when the tab is hidden (and stays off under
  `prefers-reduced-motion`), honest state mapping (`sleepy` ≠ asleep, a
  raincoat doesn't make it rain indoors), and in-GUI "Talk to her" switches
  back to chat in place instead of spawning a duplicate tab.
- Design + build notes: `docs/PLAN_ROOM_v1.0.md`.

### Voice — ElevenLabs-first transcription (#174)

- Transcription now prefers **ElevenLabs Scribe** (`ELEVENLABS_API_KEY`),
  falling back to **OpenAI Whisper**; the no-key error names both providers.
- Composer ＋ / 🎙 glyphs became line-style SVG icons matching the function bar.

### Infra — Anthropic reverse-proxy relay for Cloud Run (#209)

- `packaging/gcp-relay/`: a ~110-line zero-dep Node relay forwarding `/v1/*`
  (streaming included) to `api.anthropic.com`, for reaching Claude reliably
  from behind flaky networks by pointing `ANTHROPIC_BASE_URL` at it.
- **Key-swap gate**: the real Anthropic key lives only in Secret Manager and is
  injected server-side; clients present a revocable `RELAY_TOKEN` instead.

### Docs

- Lisa Pocket (iOS) surfaced in the README, extracted OSS repos cross-linked,
  and an App Store 4.1(a) response kit (#213).
- The no-clone `gh api` Homebrew-tap bump used for v0.14.0 is now the
  documented path (#212).

## Install / update

- **Mac**: download `Lisa-Suite-v0.15.0.dmg` below, or let the in-app updater pull it.
- **CLI**: `npm i -g @oratis/lisa@0.15.0` (or the `lisa-*-bundle` tarballs below).
- **iOS**: via TestFlight (ships separately from this release).

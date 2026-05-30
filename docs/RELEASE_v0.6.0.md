## What's new in v0.6.0 — LISA can listen

LISA gets **ears**. Record audio right in the chat and she transcribes it and
gives you a summary — in her own voice, persisted and discussable.

### Record → transcribe → summary

- **🎙 button** in the composer toggles recording (turns into a pulsing ⏹
  while live). Press it again to stop.
- On stop, the clip is transcribed (OpenAI Whisper, server-side) and the
  transcript is handed to Lisa with a "summarize this" framing — so she replies
  with a clear summary (key points, decisions, action items) **in her own
  voice**, as a normal chat turn you can ask follow-ups about.

### How it works

- Recording happens in the browser via the standard `MediaRecorder` API (no
  native dependency), so it works in Lisa.app and any browser tab. First use
  prompts for microphone permission.
- A new `POST /api/voice/transcribe` endpoint takes the base64 clip, writes a
  temp file, runs the existing Whisper transcriber, returns the transcript, and
  deletes the temp. Summarization is the model's job through the normal chat —
  no special endpoint — so it inherits LISA's soul, memory, and context.
- Privacy: nothing is recorded until you press 🎙, the clip only leaves the
  machine for transcription when you stop, and the temp file is deleted
  immediately after.

### Requirements

- **`OPENAI_API_KEY`** (Whisper). Set it in `~/.lisa/config.env`. Without it the
  recorder shows a clear error instead of failing silently.

### Upgrade

```sh
npm install -g @oratis/lisa            # 0.6.0
# or
brew update && brew upgrade lisa
# or grab the signed + notarized Lisa-Suite-v0.6.0.dmg below
```

Test suite: **170 passing**. Still zero new runtime dependencies.

---
name: cloud-screencast
description: >-
  Record a clean product demo video of a web app on a disposable cloud VM —
  provision a GCE instance, install Xvfb + Chrome + ffmpeg + real fonts, deploy the
  app, drive the UI deterministically with Playwright over CDP while x11grab
  records, then cut the raw take into a social-ready clip with speed ramps and
  burned-in captions. Use when asked to record a demo / screencast / promo video,
  produce a GIF or clip of a UI, or capture a reproducible app walkthrough — and
  especially when the local machine is unsuitable (personal bookmarks and profile
  chrome in frame, wrong window size, the app must start from a pristine state, or
  the recording would tie up the user's desktop for minutes).
allowed-tools:
  - Read
  - Write
  - Edit
  - Bash
---

# cloud-screencast — reproducible UI demo videos on a throwaway VM

Records a web UI on a headless cloud box instead of the user's desktop. You get a
pristine app state, a chosen viewport, no personal data in frame, and a scripted
take you can re-run until it's right — none of which is true of a hand-recorded
local screen capture.

> **Cost + lifecycle:** this creates a billable VM. Always tell the user it exists,
> and **delete it** when the recording is downloaded (§8). An e2-standard-4 left
> running is roughly $95/month.

---

## Config

Fill once per project, then run.

```
PROJECT   = <gcp-project-id>
ZONE      = <zone, e.g. us-central1-a>
VM        = <instance-name, e.g. app-record>
APP_REPO  = <git url of the app, or an npm package name>
APP_START = <command that serves the UI, e.g. node dist/cli.js serve --web --port 5757>
APP_URL   = <local url the browser opens, e.g. http://127.0.0.1:5757/>
SECRETS   = <local env file the app needs, e.g. ~/.app/config.env>
```

---

## 1. Pick the geometry first

Everything downstream depends on this, and getting it wrong means re-recording.

Chrome's `--force-device-scale-factor=N` divides the X display into CSS pixels:

```
CSS viewport = Xvfb resolution / DSF
```

Record at **2× the delivery resolution** and downscale in post — supersampling is
what makes small UI text look sharp in an H.264 clip.

| Delivery | Xvfb | DSF | CSS viewport | Notes |
|---|---|---|---|---|
| 1920×1080 | 2880×1620 | 2 | 1440×810 | good default, 16:9 |
| 1920×1080 | 2560×1440 | 2 | 1280×720 | tighter; short UIs get clipped |
| 1080×1080 | 2160×2160 | 2 | 1080×1080 | square, better mobile in-feed |

**Do not just use 1280×720.** A real user's browser window is far taller than 720
CSS px, so a 720-tall viewport clips panels that never clip in real life — and the
clipped part is usually the payoff (the final state, the confirm button). Probe the
actual content height before committing (§4) and go taller if it overflows.

Keep integer DSF values. Fractional scale factors make Chrome's text rendering
noticeably softer.

## 2. Provision

```bash
gcloud compute instances create <VM> --project=<PROJECT> --zone=<ZONE> \
  --machine-type=e2-standard-4 \
  --image-family=ubuntu-2404-lts-amd64 --image-project=ubuntu-os-cloud \
  --boot-disk-size=50GB --boot-disk-type=pd-balanced \
  --labels=purpose=demo-recording
```

4 vCPU is the floor — x11grab at 2880×1620/30fps plus Chrome plus the app will
saturate 2 cores. Copy `reference/setup.sh` over and run it: it installs Xvfb,
ffmpeg, Chrome, xdotool, ImageMagick, Node, and — critically — **fonts**.

> **Fonts are the whole ballgame for "does this look right".** Most web UIs specify
> `-apple-system, BlinkMacSystemFont, "SF Pro Text"` and `ui-monospace, "SF Mono",
> Menlo`. None of those exist on Linux, so you get DejaVu fallback and the app looks
> subtly wrong in a way reviewers notice but can't name. Install `fonts-inter`
> (a near-exact SF Pro substitute, and often already in the CSS fallback chain),
> `fonts-jetbrains-mono`, `fonts-noto-color-emoji` (UIs lean on ❤️ 🌙 ★ far more than
> you expect), and `fonts-noto-cjk`. Then `fc-cache -f`.

**`gcloud compute ssh` is flaky under load.** It intermittently dies with
`RemoteDisconnected`. Fall back to plain SSH against the external IP with the key
gcloud already provisioned:

```bash
ssh -i ~/.ssh/google_compute_engine -o StrictHostKeyChecking=no <user>@<EXTERNAL_IP>
```

## 3. Deploy the app + secrets

Prefer building from source at the version you want to show — a published package
often lags the current version.

**Never put secrets in instance metadata or in a command line.** Metadata is
readable by anyone with project viewer, and argv shows up in `ps` and shell
history. Pipe them over SSH's stdin instead:

```bash
grep -E '^(API_KEY|BASE_URL)=' <SECRETS> | \
  ssh ... "mkdir -p ~/.app && cat > ~/.app/config.env && chmod 600 ~/.app/config.env"
```

**Snapshot the pristine state before the app ever runs.** First-run flows —
onboarding, setup wizards, a birth ritual — happen exactly once, and you will need
three or four takes to get one good one:

```bash
cp -r ~/.app ~/.app-pristine     # BEFORE first launch
# each retake starts with:  rm -rf ~/.app && cp -r ~/.app-pristine ~/.app
```

## 4. Bring the stack up

`reference/stack.sh` does Xvfb → app → Chrome, idempotently. Chrome flags that
matter for a clean frame:

```
--kiosk                      no tabs, no URL bar, no bookmarks
--hide-scrollbars            scrollbars read as clutter on video
--force-device-scale-factor  see §1
--lang=en-US                 UIs branch on navigator.language; pin it
--remote-debugging-port=9222 so Playwright can attach
--user-data-dir=/tmp/...     fresh profile, no first-run bubbles
--disable-features=Translate,TranslateUI,AutofillServerCommunication,MediaRouter
```

Also `xsetroot -solid '<app-bg-color>'` so any gap looks deliberate, and
`xset -dpms s off s noblank` so the screen never blanks mid-take.

Then **probe before recording** — check the content actually fits:

```js
await page.evaluate(() => ({
  viewport: [innerWidth, innerHeight], dpr: devicePixelRatio,
  overflow: document.querySelector('<container>').scrollHeight,
  clientH:  document.querySelector('<container>').clientHeight,
}))
```

If `scrollHeight > clientHeight` on something that shouldn't scroll, go back to §1.

## 5. Drive it

Attach to the running Chrome rather than letting Playwright launch its own — the
browser then survives a script crash, so a failed drive doesn't cost you the whole
recording:

```js
const b = await chromium.connectOverCDP('http://127.0.0.1:9222');
const page = b.contexts()[0].pages()[0];
```

Use `playwright-core` (no bundled browser download). Rules that make takes usable:

- **Print a `MARK <label> <seconds>` timeline.** The edit is driven entirely by
  these timestamps; without them you are scrubbing a 6-minute file by hand.
- **Record `-draw_mouse 0`.** A programmatically driven cursor never moves, so a
  visible pointer just looks frozen.
- **Type with `{ delay: 40-60 }`.** Instant `fill()` looks like a bug.
- **Hold 2–3s on each payoff state.** You can always cut time out in post; you
  cannot add a frame that was never captured.
- **Poll for real completion**, not fixed sleeps — watch for text length going
  stable, a class appearing, an element count changing.
- **Scroll cinematically**: `for (i=0..N) el.scrollTop = total*i/N` with a ~50ms
  gap reads as a deliberate camera move; a single jump reads as a glitch.

## 6. Record

ffmpeg runs for the whole take; you cut afterwards.

```bash
ffmpeg -y -f x11grab -draw_mouse 0 -framerate 30 -video_size <W>x<H> -i :99.0 \
  -c:v libx264 -preset ultrafast -crf 16 -pix_fmt yuv420p /tmp/raw.mp4
```

`ultrafast` + `crf 16` keeps capture real-time on 4 vCPU; quality is recovered in
the encode pass. Stop it with `SIGINT` (not `SIGKILL`) so the container finalizes.

**Beware orphaned ffmpeg.** If the drive script dies, its ffmpeg child keeps
recording and holds the output file — every later take then silently writes
nowhere. Start each take with `pkill -f x11grab`.

**Launch long takes detached** or the SSH session ending kills them:

```bash
ssh ... 'setsid bash ~/take.sh > ~/take.log 2>&1 < /dev/null & disown; exit 0'
```

Do not try to chain `sed`/`mv`/launch in one backgrounded compound — the `&` breaks
the chain and you get a half-applied state that looks like it worked. Write the
script to a file, `scp` it, run it.

## 7. Cut

`reference/edit.sh` turns the raw take plus the MARK timeline into a clip: extract
each beat, apply a speed ramp, concat, burn captions, downscale.

**Cut with the `trim` filter, never `-ss`/`-to`.** Both shortcuts fail silently here
and you only notice when reviewing the output:

| | what goes wrong |
|---|---|
| `-ss` before `-i` | seeks to the previous keyframe. An `ultrafast` screen capture has ~8s keyframe gaps, so the cut starts seconds early — on the wrong beat entirely. |
| `-to` after `-i` | measured on the *filtered* timeline, so a `setpts` speed-up stretches the window. A 30s target came out 57s. |

```
trim=start=S:end=E,setpts=PTS-STARTPTS[,crop=W:H:X:Y],setpts=PTS/SPEED,fps=30,scale=...
```

`trim` runs on input timestamps, before `setpts` touches them.

**Push in on small UI.** Full-frame desktop UI is unreadable in a phone feed. Crop
to the element (keep it 16:9) and rescale — a 1.2–1.4× push-in is usually enough.
**Measure the bounding box** from a full-res extracted frame first; a crop that
misses the thing you are pointing at is invisible until you review the cut.

Editorial rules for a silent autoplay feed:

- **No voiceover.** Social video autoplays muted — everything must be in captions.
- **3–5 words per caption**, ~2.5s each, bottom third, white on a subtle scrim.
- **Speed-ramp the dead air** (network waits, model latency) 3–8×; never hold a
  static frame.
- **The first 2 seconds decide completion.** Open on the payoff of the first beat,
  never on an empty screen or a loading state.
- **End card**: what it is, the license, the URL. 2–3s.
- Downscale with `flags=lanczos`; export `yuv420p` + `-movflags +faststart`.

## 8. Music (optional)

If a bed is wanted, **synthesise it** — `reference/music.sh` builds one from ffmpeg
sine sources. Never attach a track you found online: a promo clip is a commercial
use, and "royalty-free" pages routinely mislabel licences. Generated audio has no
rights question at all.

The recipe that sounds like music rather than a test tone: a four-chord progression
with tight voice leading, each voice doubled by a second sine ~0.35% off for slow
beating, then `lowpass` (warmth) → `aecho` (space) → `tremolo` (movement) →
`loudnorm`. Put `aresample=48000` **after** `loudnorm`, which otherwise leaves the
output at 192kHz.

Verify what you can measure — `-14` to `-20` LUFS integrated, true peak under
`-1 dBTP`, 48kHz stereo:

```bash
ffmpeg -hide_banner -i bed.wav -af ebur128 -f null - 2>&1 | tail -12
```

**Say plainly that you could not listen to it** and ask the user to audition before
posting. Levels and format are verifiable; whether it actually sounds good is not.

## 9. Tear down — required

```bash
gcloud compute scp <VM>:/tmp/final.mp4 ./ --zone=<ZONE> --project=<PROJECT>
gcloud compute instances delete <VM> --zone=<ZONE> --project=<PROJECT> --quiet
```

Confirm the download opens locally *before* deleting. Then tell the user the VM is
gone. If you are keeping it for retakes, say so explicitly and give them the delete
command.

---

## Honesty constraints

The recording is a claim about how the product behaves. So:

- **Never inject CSS/JS to make the UI fit or look better.** If content clips,
  change the viewport (§1), not the app. A viewport that matches a real user's
  browser is the honest fix.
- **Never fake a state the app didn't produce.** If a feature stays silent or empty
  during the take, that is the product's real behaviour — either give it genuine
  input that exercises it, or cut the beat.
- Cutting and speeding up real footage is fine and expected. Staging output that
  the app never generated is not.

## Reference

- `reference/setup.sh` — VM package + font install
- `reference/stack.sh` — Xvfb + app + Chrome bring-up
- `reference/take.mjs` — annotated Playwright drive script with the MARK timeline
- `reference/edit.sh` — segment / speed-ramp / caption / downscale pipeline

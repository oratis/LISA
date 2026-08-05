#!/usr/bin/env bash
# Cut a raw take into a social-ready clip.
#
#   RAW=/tmp/raw.mp4 OUT=/tmp/final.mp4 bash edit.sh
#
# Edit SEGMENTS below using the MARK timeline the drive script printed. Each row is
#   "<start> <end> <speed> <caption>"
# start/end are seconds into RAW; speed>1 compresses (setpts=PTS/speed).
# Speed-ramp network + model latency hard; hold real payoff states at ~1x.
set -euo pipefail

RAW="${RAW:-/tmp/raw.mp4}"
OUT="${OUT:-/tmp/final.mp4}"
WORK="${WORK:-/tmp/edit}"
OUT_W="${OUT_W:-1920}"; OUT_H="${OUT_H:-1080}"
FONT="${FONT:-/usr/share/fonts/opentype/inter/InterDisplay-Bold.otf}"
ENDCARD_LINE1="${ENDCARD_LINE1:-<app name>}"
ENDCARD_LINE2="${ENDCARD_LINE2:-<tagline · license · url>}"

# "start|end|speed|crop|caption"
#   crop = "none" or W:H:X:Y — a push-in, so small UI text survives a phone feed.
#          Keep the crop 16:9. Measure the element first (extract a full-res frame
#          and read off its bounding box); do not guess, a crop that misses the
#          thing you are pointing at is invisible until you review the cut.
#   caption = empty means the UI already says it better than an overlay would.
SEGMENTS=(
  "0.0|17.0|3.0|2160:1215:360:202|Caption for beat one"
  "18.5|24.0|1.6|none|Caption for beat two"
  "25.0|38.0|1.7|none|Caption for beat three"
  "38.0|50.0|2.0|2400:1350:240:140|Caption for beat four"
  "112.0|126.0|1.4|none|"
)

rm -rf "$WORK"; mkdir -p "$WORK"

# ── 1. extract + speed-ramp each beat ──────────────────────────────────
i=0; : > "$WORK/list.txt"; CAPS=(); CUM=0
for row in "${SEGMENTS[@]}"; do
  IFS='|' read -r S E SP CROP CAP <<< "$row"
  DUR=$(awk -v s="$S" -v e="$E" -v p="$SP" 'BEGIN{printf "%.3f", (e-s)/p}')
  # Cut with the `trim` FILTER — NOT -ss/-to. Both shortcuts are silently wrong here:
  #   -ss before -i  snaps to the previous keyframe. An ultrafast screen capture has
  #                  ~8s keyframe gaps, so it starts seconds early on the wrong beat.
  #   -to after -i   is measured on the FILTERED timeline, so a setpts speed-up
  #                  stretches the window (a 30s cut came out 57s that way).
  # trim runs on input timestamps, before setpts touches them.
  FV="trim=start=$S:end=$E,setpts=PTS-STARTPTS"
  [ "$CROP" = "none" ] || FV="$FV,crop=$CROP"
  FV="$FV,setpts=PTS/$SP,fps=30,scale=${SRC_W:-2880}:${SRC_H:-1620}:flags=lanczos"
  ffmpeg -v error -y -i "$RAW" -filter:v "$FV" -an \
    -c:v libx264 -preset slow -crf 18 -pix_fmt yuv420p "$WORK/seg$i.mp4"
  echo "file '$WORK/seg$i.mp4'" >> "$WORK/list.txt"
  END=$(awk -v c="$CUM" -v d="$DUR" 'BEGIN{printf "%.3f", c+d}')
  CAPS+=("$CUM|$END|$CAP")
  CUM=$END; i=$((i+1))
  printf "seg%d: %s->%s x%s %s = %ss cum=%s\n" $((i-1)) "$S" "$E" "$SP" "$CROP" "$DUR" "$CUM"
done

# ── 2. end card ────────────────────────────────────────────────────────
ffmpeg -v error -y -f lavfi -i "color=c=#0b0a1a:s=${OUT_W}x${OUT_H}:d=2.6:r=30" \
  -vf "drawtext=fontfile=$FONT:text='$ENDCARD_LINE1':fontcolor=white:fontsize=76:x=(w-tw)/2:y=(h/2)-70,
       drawtext=fontfile=$FONT:text='$ENDCARD_LINE2':fontcolor=0xB8C0E0:fontsize=34:x=(w-tw)/2:y=(h/2)+40,
       fade=t=in:st=0:d=0.4" \
  -c:v libx264 -preset slow -crf 18 -pix_fmt yuv420p "$WORK/end.mp4"
echo "file '$WORK/end.mp4'" >> "$WORK/list.txt"

# ── 3. concat ──────────────────────────────────────────────────────────
ffmpeg -v error -y -f concat -safe 0 -i "$WORK/list.txt" -c copy "$WORK/joined.mp4"

# ── 4. captions + downscale ────────────────────────────────────────────
# Captions live in the bottom third on a scrim. 3-5 words, ~2.5s each: social
# video autoplays muted, so every bit of meaning has to survive with no audio.
VF="scale=${OUT_W}:${OUT_H}:flags=lanczos"
for c in "${CAPS[@]}"; do
  IFS='|' read -r A B TXT <<< "$c"
  ESC=$(printf '%s' "$TXT" | sed "s/'/\\\\\\\\'/g; s/:/\\\\:/g")
  VF="$VF,drawbox=x=0:y=ih-190:w=iw:h=190:color=black@0.42:t=fill:enable='between(t,$A,$B)'"
  VF="$VF,drawtext=fontfile=$FONT:text='$ESC':fontcolor=white:fontsize=44:x=(w-tw)/2:y=h-125:enable='between(t,$A,$B)'"
done
VF="$VF,fade=t=in:st=0:d=0.35"

ffmpeg -v error -y -i "$WORK/joined.mp4" -vf "$VF" \
  -c:v libx264 -preset slow -crf 19 -pix_fmt yuv420p -movflags +faststart -an "$OUT"

echo "--- $OUT ---"
ffprobe -v error -show_entries format=duration,size -show_entries stream=width,height,r_frame_rate \
  -of default=noprint_wrappers=1 "$OUT"

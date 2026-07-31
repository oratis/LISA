#!/usr/bin/env bash
# Synthesised ambient bed — 100% generated, no sampled or licensed material, so the
# clip is safe to publish. Am - F - G - C with close voice leading, detuned sine
# pairs for width, lowpass + echo for warmth and space.
set -euo pipefail
D="${OUTDIR:-$(cd "$(dirname "$0")" && pwd)}"
CH=9              # seconds per chord
XF=1.5            # crossfade
OUTDUR=30

chord () {  # $1=out  $2..$5 = bass, low, mid, high (Hz)
  local out="$1"; shift
  local ins=() fc="" n=0
  for f in "$@"; do
    # each voice = two sines a few cents apart -> slow beating, not a test tone
    ins+=(-f lavfi -i "sine=frequency=$f:duration=$CH:sample_rate=48000")
    ins+=(-f lavfi -i "sine=frequency=$(awk -v x="$f" 'BEGIN{printf "%.4f", x*1.0035}'):duration=$CH:sample_rate=48000")
    n=$((n+2))
  done
  for ((i=0;i<n;i++)); do fc="$fc[$i:a]"; done
  # bass voice sits louder, top voice quieter -> the chord reads as one sound
  ffmpeg -v error -y "${ins[@]}" -filter_complex \
    "${fc}amix=inputs=$n:normalize=0,volume=0.11,afade=t=in:st=0:d=2.2,afade=t=out:st=$(awk -v c=$CH 'BEGIN{print c-2.2}'):d=2.2" \
    -c:a pcm_s16le "$out"
}

# Am        F         G         C     (voice leading kept tight between chords)
chord "$D/c1.wav" 110.00 220.00 261.63 329.63
chord "$D/c2.wav"  87.31 220.00 261.63 349.23
chord "$D/c3.wav"  98.00 196.00 246.94 293.66
chord "$D/c4.wav"  65.41 196.00 261.63 329.63

ffmpeg -v error -y -i "$D/c1.wav" -i "$D/c2.wav" -i "$D/c3.wav" -i "$D/c4.wav" \
  -filter_complex "\
[0][1]acrossfade=d=$XF:c1=tri:c2=tri[a];\
[a][2]acrossfade=d=$XF:c1=tri:c2=tri[b];\
[b][3]acrossfade=d=$XF:c1=tri:c2=tri[c];\
[c]lowpass=f=1500,\
aecho=0.8:0.85:420|770:0.28|0.18,\
tremolo=f=0.18:d=0.22,\
loudnorm=I=-20:TP=-2:LRA=7,\
aresample=48000,\
pan=stereo|c0=c0|c1=c0,\
atrim=0:$OUTDUR,asetpts=N/SR/TB,\
afade=t=in:st=0:d=1.6,afade=t=out:st=27.2:d=2.8[out]" \
  -map "[out]" -c:a pcm_s16le -ar 48000 "$D/bed.wav"

ffprobe -v error -show_entries format=duration -show_entries stream=sample_rate,channels \
  -of default=noprint_wrappers=1 "$D/bed.wav"
echo "--- peak / loudness ---"
ffmpeg -v error -i "$D/bed.wav" -af "volumedetect" -f null - 2>&1 | grep -E "mean_volume|max_volume"

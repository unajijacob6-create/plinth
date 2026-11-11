#!/usr/bin/env bash
# Post-process a Remotion render: TV-range yuv420p H.264 and two-pass loudnorm to -16 LUFS / -1.5 dBTP.
# Usage: bash tools/finalize.sh out/render-x.mp4 out/plinth-x.mp4
set -euo pipefail
in="$1"; out="$2"
m=$(ffmpeg -hide_banner -i "$in" -af loudnorm=I=-16:TP=-1.5:LRA=11:print_format=json -f null - 2>&1 | sed -n '/^{/,/^}/p')
get() { echo "$m" | sed -n "s/.*\"$1\" : \"\(.*\)\".*/\1/p"; }
ffmpeg -v error -y -i "$in" \
  -vf "scale=in_range=pc:out_range=tv,format=yuv420p" -c:v libx264 -preset slow -crf 18 -profile:v high -pix_fmt yuv420p \
  -color_range tv -colorspace bt709 -color_primaries bt709 -color_trc bt709 \
  -af "loudnorm=I=-16:TP=-1.5:LRA=11:measured_I=$(get input_i):measured_TP=$(get input_tp):measured_LRA=$(get input_lra):measured_thresh=$(get input_thresh):offset=$(get target_offset):linear=true" \
  -ar 48000 -c:a aac -b:a 192k -movflags +faststart -shortest "$out"
ffprobe -v error -show_entries stream=codec_name,pix_fmt,width,height:format=duration,size -of compact "$out"

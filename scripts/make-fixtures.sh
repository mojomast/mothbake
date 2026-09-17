#!/usr/bin/env bash
# Regenerate the tiny animated-GIF and WAV fixtures committed under
# test/fixtures/. These stand in for engine outputs so the test suite stays
# fully offline; the system ffmpeg is a build-time convenience only, not a
# runtime dependency of mothbake.
#
# Usage: scripts/make-fixtures.sh
set -euo pipefail

cd "$(dirname "$0")/.."
out="test/fixtures"
mkdir -p "$out"

command -v ffmpeg >/dev/null 2>&1 || {
  echo "ffmpeg is required to regenerate fixtures (the committed copies are enough to run tests)" >&2
  exit 1
}

# Animated GIF: 8x8, three frames at 10 fps (100 ms per frame).
ffmpeg -hide_banner -loglevel error -y \
  -f lavfi -i "testsrc=size=8x8:rate=10:duration=0.3" \
  -loop 0 "$out/anim.gif"

# PCM 16-bit mono, 8 kHz, 50 ms sine.
ffmpeg -hide_banner -loglevel error -y \
  -f lavfi -i "sine=frequency=440:sample_rate=8000:duration=0.05" \
  -ac 1 -c:a pcm_s16le "$out/clip-pcm16.wav"

# PCM 16-bit mono with 20 ms of silence at each end, for trim tests.
ffmpeg -hide_banner -loglevel error -y \
  -f lavfi -i "aevalsrc=0.6*sin(2*PI*440*t)*between(t\,0.02\,0.08):d=0.1:s=8000" \
  -ac 1 -c:a pcm_s16le "$out/clip-padded.wav"

# 8-bit unsigned PCM mono.
ffmpeg -hide_banner -loglevel error -y \
  -f lavfi -i "sine=frequency=440:sample_rate=8000:duration=0.05" \
  -ac 1 -c:a pcm_u8 "$out/clip-pcm8.wav"

# 24-bit signed PCM stereo.
ffmpeg -hide_banner -loglevel error -y \
  -f lavfi -i "sine=frequency=330:sample_rate=8000:duration=0.05" \
  -ac 2 -c:a pcm_s24le "$out/clip-pcm24.wav"

# 32-bit float stereo.
ffmpeg -hide_banner -loglevel error -y \
  -f lavfi -i "sine=frequency=550:sample_rate=8000:duration=0.05" \
  -ac 2 -c:a pcm_f32le "$out/clip-float32.wav"

ls -l "$out"/*.gif "$out"/clip-*.wav

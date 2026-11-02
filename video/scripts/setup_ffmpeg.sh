#!/usr/bin/env bash
# يجلب ffmpeg ثابت (بدون صلاحيات روت) من حزمة imageio-ffmpeg على PyPI
set -e
DEST="$(cd "$(dirname "$0")/.." && pwd)/tools"
mkdir -p "$DEST/tmp"
cd "$DEST/tmp"
python3 -m pip download imageio-ffmpeg --no-deps -q -d .
unzip -o -q imageio_ffmpeg-*.whl
cp "$(find . -name 'ffmpeg-linux*' -type f | head -1)" "$DEST/ffmpeg"
chmod +x "$DEST/ffmpeg"
echo "ffmpeg -> $DEST/ffmpeg"

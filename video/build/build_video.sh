#!/usr/bin/env bash
# ============================================================================
#  إعادة إنتاج احترافية للفيديو الموجود في المستودع
#  • لا موسيقى ولا أي صوت مُصنَّع — الصوت الأصلي فقط بعد تنظيفه وموازنته
#  • لا رسومات لكائنات حية — بطاقات هندسية صامتة فقط
#  • تثبيت الكاميرا + تدرّج لوني + إطار 9:16 و16:9
# ============================================================================
set -euo pipefail
cd "$(dirname "$0")/../.."

FF=video/tools/ffmpeg
SRC="WhatsApp Video 2026-11-03 at 1.33.12 AM.mp4"
B=video/build
WORK="$B/work"
PY="${PY:-/tmp/venv/bin/python}"
mkdir -p "$WORK" video/out

T_IN=0.15          # قصّ البداية
T_OUT=22.60        # قصّ النهاية
INTRO=2.10
ADELAY=2100       # تأخير صوت الماستر بمقدار بطاقة الافتتاح (مللي ثانية)
OUTRO=3.40
MAIN=22.45
TOTAL=27.95

GRADE="curves=master='0/0.015 0.25/0.26 0.75/0.78 1/0.985',eq=contrast=1.06:saturation=1.03:gamma=1.02,colorbalance=rs=-0.02:bs=0.02:rm=0.01:bm=0.0:rh=0.02:bh=-0.015,vibrance=intensity=0.08"
ACLEAN="highpass=f=85,afftdn=nr=16:nf=-32:tn=1,equalizer=f=240:t=q:w=1.3:g=-2.0,equalizer=f=3400:t=q:w=1.4:g=1.2,acompressor=threshold=-20dB:ratio=3.2:attack=6:release=260,loudnorm=I=-16:TP=-1.5:LRA=11,aresample=48000"

# --- 1) تحليل الاهتزاز ------------------------------------------------------
if [ ! -f "$WORK/motion.trf" ]; then
  echo "• تحليل الاهتزاز…"
  $FF -v error -y -i "$SRC" -an -vf "vidstabdetect=shakiness=8:accuracy=15:result=$WORK/motion.trf" -f null -
fi

# --- 2) بطاقات الافتتاح والختام -------------------------------------------
if [ ! -f "$B/cards/intro.mp4" ] || [ ! -f "$B/cards/outro.mp4" ]; then
  echo "• رسم بطاقات 9:16…"; "$PY" "$B/make_cards.py"
fi
if [ ! -f "$B/cards_wide/intro.mp4" ] || [ ! -f "$B/cards_wide/outro.mp4" ]; then
  echo "• رسم بطاقات 16:9…"; "$PY" "$B/make_cards.py" wide
fi

# --- 3) الماستر العمودي 1080×1920 -----------------------------------------
echo "• معالجة 9:16 (تثبيت + لون + صوت)…"
$FF -v error -y -i "$SRC" \
  -vf "vidstabtransform=input=$WORK/motion.trf:smoothing=18:zoom=3:optzoom=2,${GRADE},trim=$T_IN:$T_OUT,setpts=PTS-STARTPTS,scale=1080:1920:flags=lanczos+accurate_rnd+full_chroma_int,unsharp=5:5:0.7:5:5:0.0,vignette=PI/4.6,noise=alls=4:allf=t,fade=t=in:st=0:d=0.60,fade=t=out:st=21.85:d=0.60,format=yuv420p" \
  -af "atrim=$T_IN:$T_OUT,asetpts=PTS-STARTPTS,$ACLEAN,afade=t=out:st=21.85:d=0.60" \
  -c:v libx264 -preset medium -crf 17 -x264-params "keyint=60:min-keyint=30" \
  -colorspace bt709 -color_primaries bt709 -color_trc bt709 \
  -c:a aac -b:a 192k -ar 48000 -ac 2 -movflags +faststart "$WORK/main_9x16.mp4"

# --- 4) الماستر الأفقي 1920×1080 (الإطار الأصلي في منتصف خلفية ضبابية) -----
echo "• معالجة 16:9…"
$FF -v error -y -i "$SRC" \
  -vf "vidstabtransform=input=$WORK/motion.trf:smoothing=18:zoom=3:optzoom=2,${GRADE},trim=$T_IN:$T_OUT,setpts=PTS-STARTPTS,split=2[fg][bg];\
[bg]scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080,gblur=sigma=34,eq=brightness=-0.10:saturation=0.85[bgb];\
[fg]scale=-1:1080:flags=lanczos,unsharp=5:5:0.6:5:5:0.0,drawbox=x=0:y=0:w=iw:h=ih:color=0xE3C07A@0.20:t=2[fgs];\
[bgb][fgs]overlay=(W-w)/2:(H-h)/2,fade=t=in:st=0:d=0.60,fade=t=out:st=21.85:d=0.60,vignette=PI/5,noise=alls=3:allf=t,format=yuv420p" \
  -af "atrim=$T_IN:$T_OUT,asetpts=PTS-STARTPTS,$ACLEAN,afade=t=out:st=21.85:d=0.60" \
  -c:v libx264 -preset medium -crf 17 -x264-params "keyint=60:min-keyint=30" \
  -colorspace bt709 -color_primaries bt709 -color_trc bt709 \
  -c:a aac -b:a 192k -ar 48000 -ac 2 -movflags +faststart "$WORK/main_16x9.mp4"

# --- 5) التجميع ------------------------------------------------------------
assemble () { # $1=مجلد البطاقات  $2=الماستر  $3=الناتج  $4=maxrate  $5=crf
  $FF -v error -y -i "$1/intro.mp4" -i "$2" -i "$1/outro.mp4" \
   -filter_complex "\
[0:v]setsar=1,fps=30[v0];[1:v]setsar=1,fps=30[v1];[2:v]setsar=1,fps=30[v2];\
[v0][v1][v2]concat=n=3:v=1:a=0[vc];\
[vc]fade=t=out:st=27.30:d=0.60,format=yuv420p[v];\
[1:a]adelay=$ADELAY|$ADELAY,apad,atrim=0:$TOTAL,asetpts=N/SR/TB[a]" \
   -map "[v]" -map "[a]" -c:v libx264 -preset slow -crf "$5" -maxrate "$4" -bufsize "$(echo "$4*2" | bc)" \
   -profile:v high -level 4.2 -pix_fmt yuv420p \
   -colorspace bt709 -color_primaries bt709 -color_trc bt709 \
   -c:a aac -b:a 160k -ar 48000 -ac 2 -movflags +faststart "$3"
}

echo "• تجميع 9:16…"
assemble "$B/cards" "$WORK/main_9x16.mp4" "video/out/01_master_9x16.mp4" 8M 22

echo "• نسخة نظيفة (بلا بطاقات)…"
$FF -v error -y -i "$WORK/main_9x16.mp4" -c:v libx264 -preset slow -crf 23 -maxrate 4500k -bufsize 9000k \
  -pix_fmt yuv420p -c:a aac -b:a 128k -ac 2 -movflags +faststart "video/out/02_clean_9x16.mp4"

echo "• تجميع 16:9…"
assemble "$B/cards_wide" "$WORK/main_16x9.mp4" "video/out/03_master_16x9.mp4" 6M 22

echo "• نسخة خفيفة للمشاركة (720×1280)…"
$FF -v error -y -i "$WORK/main_9x16.mp4" -vf "scale=720:1280:flags=lanczos,fade=t=in:st=0:d=0.3,format=yuv420p" \
  -c:v libx264 -preset slow -crf 24 -maxrate 3000k -bufsize 6000k -pix_fmt yuv420p \
  -c:a aac -b:a 128k -ac 2 -movflags +faststart "video/out/05_share_720x1280.mp4"

# --- 6) الغلاف -------------------------------------------------------------
echo "• الغلاف…"
$FF -v error -y -ss 6.4 -i "$WORK/main_9x16.mp4" -frames:v 1 -q:v 2 "video/out/04_cover.jpg"

echo "✓ تم الإنتاج"
ls -lh video/out

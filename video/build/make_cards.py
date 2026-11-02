#!/usr/bin/env python3
"""بطاقتا الافتتاح والختام — هندسة ذهبية صامتة، بلا نصوص وبلا أي كائن حي.

تُنتج إطارات PNG بمقاس 1080×1920 ثم تُرمّز إلى MP4 بواسطة ffmpeg.
"""
import math
import os
import subprocess
import sys

import numpy as np
from PIL import Image

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from lib.common import ffmpeg, BUILD, VIDEO

W, H = 1080, 1920
FPS = 30
OUT = None

INK_TOP = (0.016, 0.031, 0.047)
INK_BOT = (0.043, 0.078, 0.106)
GOLD_A = np.array([0.949, 0.851, 0.639])   # #F2D9A3
GOLD_B = np.array([0.722, 0.518, 0.243])   # #B8843E


def clamp(x, a=0.0, b=1.0):
    return np.clip(x, a, b)


def smoothstep(e0, e1, x):
    t = clamp((x - e0) / (e1 - e0))
    return t * t * (3 - 2 * t)


def ease_out_cubic(x):
    x = min(max(x, 0.0), 1.0)
    return 1 - (1 - x) ** 3


def ease_in_out(x):
    x = min(max(x, 0.0), 1.0)
    return x * x * (3 - 2 * x)


# ----------------------------------------------------------------------------
# خلفية ثابتة (تدرّج + هالة) تُحسب مرة واحدة
YY = XX = None
BG = None
PARTICLES = []

def _background():
    v = (YY / (H - 1))[..., None]
    bg = (1 - v) * np.array(INK_TOP) + v * np.array(INK_BOT)
    # هالة ذهبية ناعمة في المنتصف العلوي
    cx, cy, r = W / 2, H * 0.47, 780.0
    d = np.sqrt((XX - cx) ** 2 + (YY - cy) ** 2)
    halo = np.exp(-(d / r) ** 2 * 1.6) * 0.085
    bg = bg + halo[..., None] * GOLD_A * 0.9
    # تدرّج داكن في الأطراف (vignette)
    nd = np.sqrt(((XX - W / 2) / (W / 2)) ** 2 + ((YY - H / 2) / (H / 2)) ** 2)
    vig = 1 - 0.55 * smoothstep(0.55, 1.5, nd)
    return bg * vig[..., None]


# جزيئات غبار ضوئي (ثابتة الموضع، تتحرك ببطء)
def _make_particles():
    PARTICLES.clear()
    _rng = np.random.default_rng(20261103)
    for i in range(22):
        PARTICLES.append(
            dict(
                x=_rng.uniform(0.06, 0.94) * W,
                y=_rng.uniform(0.10, 0.92) * H,
                r=_rng.uniform(0.8, 2.6) * (H / 1920.0),
                vy=_rng.uniform(-22.0, -9.0) * (H / 1920.0),
                vx=_rng.uniform(-4.0, 4.0) * (H / 1920.0),
                ph=_rng.uniform(0, 6.28),
                sp=_rng.uniform(0.6, 1.7),
                amp=_rng.uniform(0.18, 0.55),
            )
        )


def setup(w, h):
    global W, H, XX, YY, BG
    W, H = w, h
    YY, XX = np.mgrid[0:H, 0:W].astype(np.float32)
    BG = _background()
    _make_particles()
    return BG


def _disc_mask(cx, cy, r, feather=1.1):
    x0, x1 = int(max(0, cx - r - 3)), int(min(W, cx + r + 3))
    y0, y1 = int(max(0, cy - r - 3)), int(min(H, cy + r + 3))
    if x1 <= x0 or y1 <= y0:
        return None
    ys, xs = np.mgrid[y0:y1, x0:x1].astype(np.float32)
    d = np.sqrt((xs - cx) ** 2 + (ys - cy) ** 2)
    return (x0, y0, x1, y1), smoothstep(r, r - feather, d)


def _ring_mask(cx, cy, r, width, arc=None, feather=1.0, arc_feather=0.014):
    pad = r + width + 4
    x0, x1 = int(max(0, cx - pad)), int(min(W, cx + pad))
    y0, y1 = int(max(0, cy - pad)), int(min(H, cy + pad))
    if x1 <= x0 or y1 <= y0:
        return None
    ys, xs = np.mgrid[y0:y1, x0:x1].astype(np.float32)
    d = np.sqrt((xs - cx) ** 2 + (ys - cy) ** 2)
    radial = smoothstep(width / 2 + feather, width / 2 - feather, np.abs(d - r))
    if arc is not None:
        a0, sweep = arc  # بالراديان، عقارب الساعة من الأعلى
        ang = np.arctan2(xs - cx, -(ys - cy))  # 0 = أعلى، موجب = يمين
        rel = np.mod(ang - a0, 2 * math.pi)
        inside = smoothstep(sweep, sweep - arc_feather, rel)
        radial = radial * inside
    return (x0, y0, x1, y1), radial


def _blit(img, box, mask, color, alpha=1.0):
    x0, y0, x1, y1 = box
    a = (mask * alpha)[..., None]
    img[y0:y1, x0:x1] = img[y0:y1, x0:x1] * (1 - a) + np.asarray(color) * a


def _glow(img, box, mask, color, radius, strength):
    """هالة ناعمة على كانفس موسّع حتى لا تظهر حدود الصندوق."""
    from PIL import ImageFilter

    x0, y0, x1, y1 = box
    pad = int(radius * 2.2) + 2
    X0, Y0 = max(0, x0 - pad), max(0, y0 - pad)
    X1, Y1 = min(W, x1 + pad), min(H, y1 + pad)
    canvas = np.zeros((Y1 - Y0, X1 - X0), np.float32)
    canvas[y0 - Y0:y1 - Y0, x0 - X0:x1 - X0] = mask
    im = Image.fromarray((np.clip(canvas, 0, 1) * 255).astype(np.uint8))
    im = im.filter(ImageFilter.GaussianBlur(radius))
    m2 = np.asarray(im).astype(np.float32) / 255.0
    _blit(img, (X0, Y0, X1, Y1), m2, color, strength)


def _gold(theta):
    t = 0.5 + 0.5 * math.cos(theta - math.pi / 2)
    return GOLD_B + (GOLD_A - GOLD_B) * (0.35 + 0.65 * t)


def _particles(img, t):
    for p in PARTICLES:
        x = p["x"] + p["vx"] * t
        y = p["y"] + p["vy"] * t
        tw = 0.55 + 0.45 * math.sin(p["ph"] + t * p["sp"] * 2.2)
        res = _disc_mask(x, y, p["r"], feather=max(0.9, p["r"] * 0.9))
        if res:
            _blit(img, res[0], res[1], GOLD_A, p["amp"] * tw * 0.5)


def _grain(img, seed):
    rng = np.random.default_rng(seed)
    n = rng.normal(0, 1, (H, W, 1)).astype(np.float32)
    return np.clip(img + n * 0.0075, 0, 1)


def _finish(img, t, seed, fade):
    img = _grain(img, seed)
    if fade < 1:
        img = img * fade
    return (np.clip(img, 0, 1) ** (1 / 1.02) * 255).astype(np.uint8)


# ----------------------------------------------------------------------------
def intro_frame(t, dur=1.9):
    img = BG.copy()
    _particles(img, t)
    cx, cy = W / 2, H * 0.47
    settle = ease_out_cubic(min(1.0, t / 1.5))
    r = H * 0.0615 + H * 0.0177 * (1 - settle)          # ينغلق بلطف
    alpha = smoothstep(0.05, 0.55, t)

    sweep = ease_out_cubic(min(1.0, max(0.0, (t - 0.10) / 1.15))) * 2 * math.pi
    res = _ring_mask(cx, cy, r, 3.0, arc=(-math.pi / 2, max(sweep, 0.001)))
    if res and sweep > 0:
        _glow(img, res[0], res[1], GOLD_A, 26, 0.55 * alpha)
        _blit(img, res[0], res[1], _gold(-math.pi / 2), alpha)

    # قوس داخلي رقيق
    res2 = _ring_mask(cx, cy, r - H * 0.0135, 1.2, arc=(math.pi / 2, max(sweep * 0.55, 0.001)))
    if res2 and sweep > 0.4:
        _blit(img, res2[0], res2[1], GOLD_A, 0.30 * alpha)

    # نقطة المركز
    a_dot = smoothstep(1.0, 1.55, t)
    if a_dot > 0:
        res3 = _disc_mask(cx, cy, H * 0.0022)
        _glow(img, res3[0], res3[1], GOLD_A, 18, 0.5 * a_dot)
        _blit(img, res3[0], res3[1], GOLD_A, a_dot)

    # خط أفقي رقيق تحت الحلقة
    a_line = smoothstep(0.85, 1.7, t)
    if a_line > 0:
        half = H * 0.0677 * ease_out_cubic(min(1.0, max(0.0, (t - 0.85) / 0.8)))
        y0, y1 = int(cy + H * 0.0875), int(cy + H * 0.0875 + 2)
        x0, x1 = int(cx - half), int(cx + half)
        if x1 > x0:
            img[y0:y1, x0:x1] = img[y0:y1, x0:x1] * (1 - 0.62 * a_line) + GOLD_A * (0.62 * a_line)

    # كل العناصر تختفي قبل نهاية البطاقة (تسليم نظيف إلى الأسود)
    fade = smoothstep(0.0, 0.30, t) * (1 - smoothstep(dur - 0.55, dur - 0.06, t))
    return _finish(img, t, int(1000 + t * 1000), fade)


def outro_frame(t, dur=3.4):
    img = BG.copy()
    _particles(img, 2.0 + t)
    cx, cy = W / 2, H * 0.47
    # يبدأ المشهد أسود بالكامل، ثم يدخل الرمز بعد أن يكتمل تلاشي الصورة
    alpha = smoothstep(0.85, 1.30, t)
    r = H * 0.0615 - H * 0.003 * ease_in_out(min(1.0, t / dur))

    res = _ring_mask(cx, cy, r, 3.0)
    if res:
        _glow(img, res[0], res[1], GOLD_A, 30, 0.55 * alpha)
        _blit(img, res[0], res[1], _gold(0.0), 0.95 * alpha)

    # قوس دوّار رقيق
    res2 = _ring_mask(cx, cy, r - H * 0.0115, 1.3, arc=(math.pi * 0.15 + max(0.0, t - 1.0) * 0.5, 0.85))
    if res2:
        _blit(img, res2[0], res2[1], GOLD_A, 0.45 * alpha)

    res3 = _disc_mask(cx, cy, H * 0.0022)
    if res3:
        _glow(img, res3[0], res3[1], GOLD_A, 18, 0.5 * alpha)
        _blit(img, res3[0], res3[1], GOLD_A, alpha)

    a_line = smoothstep(1.15, 1.85, t)
    half = H * 0.0677 * ease_out_cubic(min(1.0, max(0.0, (t - 1.15) / 0.75)))
    if a_line > 0 and half > 1:
        y0, y1 = int(cy + H * 0.0875), int(cy + H * 0.0875 + 2)
        x0, x1 = int(cx - half), int(cx + half)
        img[y0:y1, x0:x1] = img[y0:y1, x0:x1] * (1 - 0.62 * a_line) + GOLD_A * (0.62 * a_line)

    fade = smoothstep(0.50, 1.20, t) * (1 - smoothstep(dur - 0.85, dur - 0.10, t))
    return _finish(img, t, int(5000 + t * 1000), fade)


def render(name, fn, dur, out=None):
    out = out or OUT
    d = os.path.join(out, name)
    os.makedirs(d, exist_ok=True)
    n = int(round(dur * FPS))
    for i in range(n):
        t = i / FPS
        arr = fn(t, dur)
        Image.fromarray(arr).save(os.path.join(d, "%04d.png" % i), compress_level=1)
    outfile = os.path.join(out, name + ".mp4")
    subprocess.run(
        [
            ffmpeg(), "-v", "error", "-y", "-framerate", str(FPS),
            "-i", os.path.join(d, "%04d.png"),
            "-c:v", "libx264", "-preset", "slow", "-crf", "14",
            "-pix_fmt", "yuv420p", "-colorspace", "bt709", "-color_primaries", "bt709",
            "-color_trc", "bt709", "-movflags", "+faststart", outfile,
        ],
        check=True,
    )
    print("✓", outfile, n, "إطار")


def build(w, h, out):
    setup(w, h)
    os.makedirs(out, exist_ok=True)
    render("intro", intro_frame, 2.1, out)
    render("outro", outro_frame, 3.4, out)


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "wide":
        build(1920, 1080, os.path.join(BUILD, "cards_wide"))
    else:
        build(1080, 1920, os.path.join(BUILD, "cards"))

"""أدوات مشتركة: مسارات، ffmpeg، بيئة fontconfig، تشغيل أوامر."""
import os, glob, shutil, subprocess, hashlib, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
BUILD = os.path.dirname(HERE)
VIDEO = os.path.dirname(BUILD)
ROOT = os.path.dirname(VIDEO)
FONTS = os.path.join(VIDEO, "fonts")
CACHE = os.path.join(BUILD, "cache")
os.makedirs(CACHE, exist_ok=True)

_FF = None


def ffmpeg():
    global _FF
    if _FF:
        return _FF
    cands = [
        os.environ.get("FFMPEG"),
        os.path.join(VIDEO, "tools", "ffmpeg"),
        shutil.which("ffmpeg"),
    ] + sorted(glob.glob("/tmp/ffw/imageio_ffmpeg/binaries/ffmpeg*"))
    for c in cands:
        if c and os.path.isfile(c) and os.access(c, os.X_OK):
            _FF = c
            return c
    raise RuntimeError("ffmpeg غير متوفر — شغّل video/scripts/setup_ffmpeg.sh")


_FC = os.path.join(CACHE, "fonts.conf")
_FONTS_CONF = """<?xml version="1.0"?>
<!DOCTYPE fontconfig SYSTEM "fonts.dtd">
<fontconfig>
  <dir>{fonts}</dir>
  <cachedir>{cache}</cachedir>
  <config></config>
</fontconfig>
""".format(fonts=FONTS, cache=os.path.join(CACHE, "fc"))


def fc_env():
    if not os.path.exists(_FC):
        os.makedirs(os.path.join(CACHE, "fc"), exist_ok=True)
        open(_FC, "w").write(_FONTS_CONF)
    env = dict(os.environ)
    env["FONTCONFIG_FILE"] = _FC
    env["FONTCONFIG_PATH"] = "/etc/fonts"
    return env


def run(args, **kw):
    kw.setdefault("check", True)
    kw.setdefault("env", fc_env())
    kw.setdefault("stdout", subprocess.PIPE)
    kw.setdefault("stderr", subprocess.PIPE)
    p = subprocess.run(args, **kw)
    if kw.get("check") and p.returncode != 0:
        raise RuntimeError("فشل الأمر: %s\n%s" % (" ".join(args), p.stderr.decode("utf8", "ignore")[-2000:]))
    return p


def key(*parts):
    return hashlib.sha1(("|".join(str(p) for p in parts)).encode("utf8")).hexdigest()[:20]

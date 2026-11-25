"""Miniatures et métadonnées (EXIF, GPS, vidéos)."""
import hashlib
import json
import os
import subprocess
from datetime import datetime
from pathlib import Path

from PIL import Image, ImageOps
from pillow_heif import register_heif_opener

register_heif_opener()
Image.MAX_IMAGE_PIXELS = 250_000_000

THUMBS = Path("/var/lib/nas/thumbs")
IMAGE_EXT = {".jpg", ".jpeg", ".png", ".webp", ".heic", ".heif", ".gif", ".bmp", ".tif", ".tiff"}
VIDEO_EXT = {".mp4", ".mov", ".m4v", ".mkv", ".webm", ".avi", ".3gp", ".mts"}
AUDIO_EXT = {".mp3", ".flac", ".m4a", ".aac", ".ogg", ".opus", ".wav"}
TEXT_EXT = {".txt", ".md", ".log", ".json", ".yml", ".yaml", ".toml", ".ini", ".conf", ".csv", ".py", ".js",
            ".ts", ".java", ".sh", ".html", ".css", ".xml", ".properties", ".sk", ".mcfunction", ".cfg"}


def kind(name: str) -> str:
    ext = os.path.splitext(name)[1].lower()
    if ext in IMAGE_EXT: return "image"
    if ext in VIDEO_EXT: return "video"
    if ext in AUDIO_EXT: return "audio"
    if ext == ".pdf": return "pdf"
    if ext in TEXT_EXT: return "text"
    if ext in {".zip", ".tar", ".gz", ".7z", ".rar", ".xz", ".zst"}: return "archive"
    return "file"


def thumb(path: Path, size: int = 320) -> Path | None:
    st = path.stat()
    key = hashlib.sha1(f"{path}:{st.st_mtime_ns}:{st.st_size}:{size}".encode()).hexdigest()
    out = THUMBS / key[:2] / f"{key}.webp"
    if out.exists():
        return out
    out.parent.mkdir(parents=True, exist_ok=True)
    k = kind(path.name)
    try:
        if k == "image":
            with Image.open(path) as im:
                im.draft("RGB", (size * 2, size * 2))
                im = ImageOps.exif_transpose(im)
                im.thumbnail((size, size))
                if im.mode not in ("RGB", "RGBA"):
                    im = im.convert("RGB")
                im.save(out, "WEBP", quality=78)
        elif k == "video":
            tmp = out.with_suffix(".jpg")
            subprocess.run(["ffmpeg", "-v", "error", "-y", "-ss", "1", "-i", str(path), "-frames:v", "1",
                            "-vf", f"scale='min({size},iw)':-2", str(tmp)], timeout=60, capture_output=True)
            if not tmp.exists():
                subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", str(path), "-frames:v", "1",
                                "-vf", f"scale='min({size},iw)':-2", str(tmp)], timeout=60, capture_output=True)
            if tmp.exists():
                with Image.open(tmp) as im:
                    im.save(out, "WEBP", quality=75)
                tmp.unlink()
        else:
            return None
    except Exception:
        return None
    return out if out.exists() else None


def _gps(gps) -> tuple[float | None, float | None]:
    try:
        def conv(v, ref):
            d = float(v[0]) + float(v[1]) / 60 + float(v[2]) / 3600
            return -d if ref in ("S", "W") else d
        lat, lon = conv(gps[2], gps[1]), conv(gps[4], gps[3])
        if abs(lat) < 0.0001 and abs(lon) < 0.0001:
            return None, None
        return round(lat, 6), round(lon, 6)
    except Exception:
        return None, None


def _parse_dt(s: str) -> int | None:
    for fmt in ("%Y:%m:%d %H:%M:%S", "%Y-%m-%dT%H:%M:%S.%fZ", "%Y-%m-%dT%H:%M:%SZ", "%Y-%m-%d %H:%M:%S"):
        try:
            return int(datetime.strptime(s.strip()[:26], fmt).timestamp())
        except (ValueError, AttributeError):
            continue
    return None


def metadata(path: Path) -> dict:
    """Date de prise de vue, dimensions, GPS."""
    st = path.stat()
    meta = {"taken_at": int(st.st_mtime), "width": None, "height": None, "lat": None, "lon": None}
    k = kind(path.name)
    try:
        if k == "image":
            with Image.open(path) as im:
                meta["width"], meta["height"] = im.size
                ex = im.getexif()
                dt = ex.get_ifd(0x8769).get(36867) or ex.get(306)
                if dt and (t := _parse_dt(str(dt))):
                    meta["taken_at"] = t
                gps = ex.get_ifd(0x8825)
                if gps:
                    meta["lat"], meta["lon"] = _gps(gps)
                if ex.get(274) in (5, 6, 7, 8):
                    meta["width"], meta["height"] = meta["height"], meta["width"]
        elif k == "video":
            r = subprocess.run(["ffprobe", "-v", "error", "-print_format", "json", "-show_format", "-show_streams",
                                str(path)], capture_output=True, text=True, timeout=30)
            info = json.loads(r.stdout or "{}")
            tags = info.get("format", {}).get("tags", {})
            ct = tags.get("creation_time") or tags.get("com.apple.quicktime.creationdate")
            if ct and (t := _parse_dt(ct)):
                meta["taken_at"] = t
            for s in info.get("streams", []):
                if s.get("codec_type") == "video":
                    meta["width"], meta["height"] = s.get("width"), s.get("height")
                    break
            loc = tags.get("location") or tags.get("com.apple.quicktime.location.ISO6709")
            if loc:
                import re
                m = re.match(r"([+-]\d+\.\d+)([+-]\d+\.\d+)", loc)
                if m:
                    meta["lat"], meta["lon"] = float(m.group(1)), float(m.group(2))
    except Exception:
        pass
    return meta

"""Lecture des vidéos dans le navigateur.

Les téléphones filment en HEVC (H.265), que la plupart des navigateurs PC ne savent pas lire (écran noir / son seul).
On en fabrique une copie H.264 lisible partout, avec la carte graphique (VAAPI) et à défaut le processeur.
Les copies sont en cache dans /srv/storage/.nas/cache/video (exclu des instantanés) et préparées d'avance pour la
photothèque ; un fichier ailleurs est converti à la première lecture.
"""
import hashlib
import json
import logging
import os
import subprocess
import threading
import time
from pathlib import Path

from . import core

log = logging.getLogger("nas.video")
CACHE = core.STORAGE / ".nas" / "cache" / "video"
VAAPI = "/dev/dri/renderD128"
WEB_EXT = {".mp4", ".m4v", ".mov", ".webm"}
WEB_VIDEO = {"h264", "vp8", "vp9", "av1"}
WEB_AUDIO = {None, "aac", "mp3", "opus", "vorbis", "flac"}
WEB_PIX = {"yuv420p", "yuvj420p", None}

_probes: dict[str, dict] = {}
_jobs: dict[str, dict] = {}          # clé -> {"progress": 0..1, "error": str|None}
_jobs_lock = threading.Lock()
_one_at_a_time = threading.Semaphore(1)
_precache_running = threading.Event()


def _key(p: Path) -> str:
    st = p.stat()
    return hashlib.sha1(f"{p}:{st.st_mtime_ns}:{st.st_size}:web1".encode()).hexdigest()


def _out(key: str) -> Path:
    return CACHE / key[:2] / f"{key}.mp4"


def probe(p: Path, key: str | None = None) -> dict:
    key = key or _key(p)
    if key in _probes:
        return _probes[key]
    info = {"vcodec": None, "acodec": None, "pix": None, "w": 0, "h": 0, "duration": 0.0}
    try:
        r = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "stream=codec_type,codec_name,pix_fmt,width,height:format=duration",
                            "-of", "json", str(p)], capture_output=True, text=True, timeout=30)
        d = json.loads(r.stdout or "{}")
        for s in d.get("streams", []):
            if s.get("codec_type") == "video" and not info["vcodec"]:
                info.update(vcodec=s.get("codec_name"), pix=s.get("pix_fmt"), w=s.get("width") or 0, h=s.get("height") or 0)
            elif s.get("codec_type") == "audio" and not info["acodec"]:
                info["acodec"] = s.get("codec_name")
        info["duration"] = float(d.get("format", {}).get("duration") or 0)
    except Exception:
        log.exception("ffprobe %s", p)
    if len(_probes) > 5000:
        _probes.clear()
    _probes[key] = info
    return info


def reason(p: Path, info: dict) -> str | None:
    """Pourquoi le navigateur ne pourra pas lire le fichier tel quel (None = lisible)."""
    if not info["vcodec"]:
        return None if p.suffix.lower() in WEB_EXT else "format"
    if info["vcodec"] == "hevc" and info["pix"] in WEB_PIX and info["acodec"] in WEB_AUDIO and p.suffix.lower() in WEB_EXT:
        return "hevc"   # lisible par Safari et certains PC équipés : le navigateur nous dit s'il sait faire
    if info["vcodec"] not in WEB_VIDEO or info["pix"] not in WEB_PIX or info["acodec"] not in WEB_AUDIO or p.suffix.lower() not in WEB_EXT:
        return "format"
    return None


def status(p: Path, hevc_ok: bool = False, start: bool = True) -> dict:
    """{"mode": "native"} ou {"mode": "web", "ready": bool, "progress": float, "error": str|None}"""
    key = _key(p)
    info = probe(p, key)
    why = reason(p, info)
    if why is None:
        return {"mode": "native"}
    if _out(key).exists():   # la copie H.264 est lisible partout (et plus légère) : on la préfère quand elle est prête
        return {"mode": "web", "ready": True, "progress": 1}
    if why == "hevc" and hevc_ok:
        return {"mode": "native"}
    with _jobs_lock:
        job = _jobs.get(key)
        if job and job.get("error") and time.time() - job.get("at", 0) > 600:
            job = None   # nouvel essai après 10 min
        if not job and start:
            job = _jobs[key] = {"progress": 0, "error": None, "at": time.time()}
            threading.Thread(target=_run, args=(p, key, info), daemon=True, name="nas-video").start()
    if not job:
        return {"mode": "web", "ready": False, "progress": 0, "error": None, "queued": True}
    return {"mode": "web", "ready": False, "progress": round(job["progress"], 3), "error": job["error"]}


def web_file(p: Path) -> Path | None:
    f = _out(_key(p))
    return f if f.exists() else None


def _cmds(src: Path, dst: Path, info: dict) -> list[list[str]]:
    big = max(info["w"], info["h"]) > 1920
    common_out = ["-map", "0:v:0", "-map", "0:a:0?", "-c:a", "aac", "-b:a", "160k", "-ac", "2",
                  "-movflags", "+faststart", "-map_metadata", "0", "-f", "mp4", str(dst)]
    pre = ["ffmpeg", "-v", "error", "-nostats", "-progress", "pipe:1", "-y"]
    out = []
    if os.access(VAAPI, os.R_OK | os.W_OK):
        sc = "scale_vaapi=w=1920:h=1920:force_original_aspect_ratio=decrease:format=nv12" if big else "scale_vaapi=format=nv12"
        hw = ["-c:v", "h264_vaapi", "-profile:v", "high", "-rc_mode", "VBR", "-b:v", "5M", "-maxrate", "8M"]
        # 1) tout sur la carte graphique ; 2) décodage processeur + encodage carte graphique (HEVC 10 bits, etc.)
        out.append(pre + ["-vaapi_device", VAAPI, "-hwaccel", "vaapi", "-hwaccel_output_format", "vaapi", "-i", str(src),
                          "-vf", sc] + hw + common_out)
        out.append(pre + ["-vaapi_device", VAAPI, "-i", str(src), "-vf", "format=nv12,hwupload," + sc] + hw + common_out)
    sc = "scale=w=1920:h=1920:force_original_aspect_ratio=decrease:force_divisible_by=2" if big else "scale=trunc(iw/2)*2:trunc(ih/2)*2"
    out.append(pre + ["-i", str(src), "-vf", sc + ",format=yuv420p", "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
                      "-profile:v", "high", "-threads", "2"] + common_out)
    return out


def _run(src: Path, key: str, info: dict):
    with _one_at_a_time:
        dst = _out(key)
        if dst.exists():
            _jobs.pop(key, None)
            return
        dst.parent.mkdir(parents=True, exist_ok=True)
        tmp = dst.with_suffix(".part")
        dur = info["duration"] or 0
        err = "La conversion a échoué."
        for cmd in _cmds(src, tmp, info):
            _jobs[key]["progress"] = 0
            try:
                pr = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, preexec_fn=lambda: os.nice(10))
                for line in pr.stdout:
                    if line.startswith("out_time_us=") and dur:
                        try:
                            _jobs[key]["progress"] = min(0.99, int(line.split("=")[1]) / 1e6 / dur)
                        except ValueError:
                            pass
                stderr = pr.stderr.read()
                rc = pr.wait(timeout=60)
            except Exception as e:
                rc, stderr = 1, str(e)
            if rc == 0 and tmp.exists() and tmp.stat().st_size > 1000:
                os.replace(tmp, dst)
                (dst.with_suffix(".src")).write_text(str(src))
                with _jobs_lock:
                    _jobs.pop(key, None)
                log.info("vidéo convertie : %s", src)
                return
            log.warning("conversion vidéo (%s) : %s", cmd[cmd.index("-c:v") + 1], (stderr or "")[-400:])
            tmp.unlink(missing_ok=True)
        with _jobs_lock:
            if key in _jobs:
                _jobs[key].update(error=err, at=time.time())


def precache():
    """Prépare d'avance les vidéos de la photothèque (une à la fois, en tâche de fond)."""
    if _precache_running.is_set():
        return
    _precache_running.set()
    try:
        from . import db
        roots = {s["id"]: core.share_root(s) for s in db.q("SELECT * FROM shares")}
        for row in db.q("SELECT share_id, relpath FROM photos WHERE is_video=1 ORDER BY taken_at DESC"):
            root = roots.get(row["share_id"])
            if not root:
                continue
            p = root / row["relpath"]
            try:
                key = _key(p)
            except OSError:
                continue
            if _out(key).exists() or key in _jobs or reason(p, probe(p, key)) is None:
                continue
            with _jobs_lock:
                if key in _jobs:
                    continue
                _jobs[key] = {"progress": 0, "error": None, "at": time.time()}
            _run(p, key, probe(p, key))
    except Exception:
        log.exception("precache vidéo")
    finally:
        _precache_running.clear()


def cleanup():
    """Supprime les copies dont l'original a disparu ou changé."""
    if not CACHE.exists():
        return
    for src_file in CACHE.glob("*/*.src"):
        try:
            src = Path(src_file.read_text().strip())
            if not src.exists() or _key(src) != src_file.stem:
                src_file.with_suffix(".mp4").unlink(missing_ok=True)
                src_file.unlink(missing_ok=True)
        except OSError:
            pass
    for part in CACHE.glob("*/*.part"):
        if time.time() - part.stat().st_mtime > 86400:
            part.unlink(missing_ok=True)

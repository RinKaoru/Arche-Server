"""Tâches de fond : supervision + alertes, indexation photos, sauvegarde GitHub."""
import base64
import json
import logging
import os
import re
import subprocess
import threading
import time
from pathlib import Path

from . import core, db, media

log = logging.getLogger("nas.jobs")
STATE: dict = {"updated": 0}
_cpu_prev = None
_smart_cache = {"t": 0, "disks": []}
_alerts_log_pos = {"pos": None}
GITHUB_RUNNING = threading.Event()
GITHUB_DIR = core.STORAGE / "backups" / "github"


# ================================================================== collecte
def _cpu():
    global _cpu_prev
    with open("/proc/stat") as f:
        v = list(map(int, f.readline().split()[1:]))
    idle, total = v[3] + v[4], sum(v)
    pct = None
    if _cpu_prev:
        di, dt = idle - _cpu_prev[0], total - _cpu_prev[1]
        pct = round(100 * (1 - di / dt), 1) if dt else 0
    _cpu_prev = (idle, total)
    return pct


def _mem():
    m = {}
    with open("/proc/meminfo") as f:
        for l in f:
            k, v = l.split(":")
            m[k] = int(v.split()[0]) * 1024
    return {"total": m["MemTotal"], "available": m["MemAvailable"], "used": m["MemTotal"] - m["MemAvailable"],
            "swap_used": m["SwapTotal"] - m["SwapFree"]}


def _net():
    out = {}
    with open("/proc/net/dev") as f:
        for l in f.readlines()[2:]:
            name, data = l.split(":", 1)
            name = name.strip()
            if name in ("lo",) or name.startswith(("veth", "br-", "docker")):
                continue
            v = data.split()
            out[name] = {"rx": int(v[0]), "tx": int(v[8])}
    prev = STATE.get("_net_raw"), STATE.get("_net_t")
    now = time.time()
    rates = {}
    if prev[0]:
        dt = now - prev[1]
        for k, v in out.items():
            if k in prev[0]:
                rates[k] = {"rx": max(0, (v["rx"] - prev[0][k]["rx"]) / dt), "tx": max(0, (v["tx"] - prev[0][k]["tx"]) / dt)}
    STATE["_net_raw"], STATE["_net_t"] = out, now
    return rates


def _raid():
    arrays = []
    try:
        txt = open("/proc/mdstat").read()
    except OSError:
        return arrays
    for m in re.finditer(r"^(md\d+) : (\S+) (?:\(auto-read-only\) )?(raid\d+) ([^\n]+)\n\s+(\d+) blocks[^\n]*\[(\d+)/(\d+)\] \[([U_]+)\](.*?)(?=^md|\Z)",
                         txt, re.M | re.S):
        name, state, level, devs, blocks, n, act, bits, rest = m.groups()
        prog = re.search(r"(recovery|resync|check|reshape)\s*=\s*([\d.]+)%.*?finish=([\d.]+min)", rest)
        arrays.append({"name": name, "state": state, "level": level, "devices": re.findall(r"(\w+)\[\d+\](\(F\))?", devs),
                       "size": int(blocks) * 1024, "expected": int(n), "active": int(act), "bits": bits,
                       "degraded": "_" in bits, "action": prog.group(1) if prog else None,
                       "progress": float(prog.group(2)) if prog else None, "finish": prog.group(3) if prog else None})
    return arrays


def _smart(force=False):
    if not force and time.time() - _smart_cache["t"] < 1800 and _smart_cache["disks"]:
        return _smart_cache["disks"]
    disks = []
    try:
        lsblk = json.loads(subprocess.run(["lsblk", "-J", "-d", "-b", "-o", "NAME,SIZE,MODEL,SERIAL,ROTA,TYPE"],
                                          capture_output=True, text=True).stdout)["blockdevices"]
    except Exception:
        lsblk = []
    for d in lsblk:
        if d.get("type") != "disk" or not re.match(r"^(sd[a-z]+|nvme\d+n\d+)$", d["name"]):
            continue
        info = {"name": d["name"], "size": d["size"], "model": (d.get("model") or "").strip(), "serial": d.get("serial"),
                "hdd": bool(d.get("rota")), "healthy": None, "temp": None, "hours": None, "reallocated": None,
                "pending": None, "uncorrectable": None, "tests": []}
        try:
            j = json.loads(core.helper("smart", d["name"], raw=True) or "{}")
            info["healthy"] = j.get("smart_status", {}).get("passed")
            info["temp"] = j.get("temperature", {}).get("current")
            info["hours"] = j.get("power_on_time", {}).get("hours")
            for a in j.get("ata_smart_attributes", {}).get("table", []):
                if a["id"] == 5: info["reallocated"] = a["raw"]["value"]
                if a["id"] == 197: info["pending"] = a["raw"]["value"]
                if a["id"] in (198, 187): info["uncorrectable"] = max(info["uncorrectable"] or 0, a["raw"]["value"])
            for t in j.get("ata_smart_self_test_log", {}).get("standard", {}).get("table", [])[:5]:
                info["tests"].append({"type": t.get("type", {}).get("string"), "status": t.get("status", {}).get("string"),
                                      "passed": t.get("status", {}).get("passed"), "hours": t.get("lifetime_hours")})
        except Exception as e:
            log.warning("smart %s: %s", d["name"], e)
        disks.append(info)
    _smart_cache.update(t=time.time(), disks=disks)
    return disks


def _services():
    names = {"smbd": "Partages Windows/Mac (Samba)", "caddy": "Serveur web (Caddy)", "tailscaled": "VPN (Tailscale)",
             "docker": "Docker", "smartmontools": "Surveillance des disques", "mdmonitor": "Surveillance du RAID",
             "nftables": "Pare-feu", "avahi-daemon": "Découverte réseau", "nas-snapshot.timer": "Snapshots quotidiens", "nas-syncthing": "Synchronisation PC / téléphones"}
    out = []
    for unit, label in names.items():
        r = subprocess.run(["systemctl", "is-active", unit], capture_output=True, text=True)
        out.append({"unit": unit, "label": label, "active": r.stdout.strip() == "active", "state": r.stdout.strip()})
    return out


def _tailscale():
    try:
        j = json.loads(core.helper("tailscale-status", raw=True) or "{}")
    except Exception:
        return {"state": "inconnu"}
    peers = []
    for p in (j.get("Peer") or {}).values():
        peers.append({"name": p.get("HostName"), "os": p.get("OS"), "online": p.get("Online"),
                      "ip": (p.get("TailscaleIPs") or [None])[0], "last_seen": p.get("LastSeen"),
                      "shared": bool(p.get("ShareeNode")), "rx": p.get("RxBytes"), "tx": p.get("TxBytes")})
    me = j.get("Self") or {}
    return {"state": j.get("BackendState"), "ip": (me.get("TailscaleIPs") or [None])[0], "dns": me.get("DNSName"),
            "auth_url": j.get("AuthURL"), "peers": peers}


def _fs(path):
    st = os.statvfs(path)
    total, free = st.f_blocks * st.f_frsize, st.f_bavail * st.f_frsize
    return {"total": total, "free": free, "used": total - free, "pct": round(100 * (total - free) / total, 1) if total else 0}


def snapshot_state():
    try:
        return json.load(open("/var/lib/nas/snapshot-state.json"))
    except (OSError, json.JSONDecodeError):
        return None


def sysbackup_state():
    try:
        parts = open("/var/lib/nas/sysbackup-state").read().split()
        return {"ok": parts[0] == "ok", "date": parts[1], "size": parts[2] if len(parts) > 2 else ""}
    except (OSError, IndexError):
        return None


def _age_h(iso):
    try:
        return (time.time() - time.mktime(time.strptime(iso[:19], "%Y-%m-%dT%H:%M:%S"))) / 3600
    except (TypeError, ValueError):
        return 1e9


def collect(smart=False):
    la = os.getloadavg()
    STATE.update({
        "updated": int(time.time()),
        "hostname": os.uname().nodename, "kernel": os.uname().release,
        "uptime": int(float(open("/proc/uptime").read().split()[0])),
        "cpu": _cpu(), "cores": os.cpu_count(), "load": [round(x, 2) for x in la],
        "mem": _mem(), "net": _net(),
        "storage": _fs("/srv/storage") if os.path.ismount("/srv/storage") else None,
        "storage_mounted": os.path.ismount("/srv/storage"),
        "system": _fs("/"), "raid": _raid(), "disks": _smart(force=smart),
        "services": _services(), "tailscale": _tailscale(),
        "photos": db.one("SELECT COUNT(*) n FROM photos")["n"],
    })
    try:
        temps = [int(open(f"/sys/class/thermal/{z}/temp").read()) / 1000 for z in os.listdir("/sys/class/thermal")
                 if z.startswith("thermal_zone")]
        STATE["cpu_temp"] = max(temps) if temps else None
    except OSError:
        STATE["cpu_temp"] = None


# ================================================================== alertes
def alert(key, active, level="warning", title="", body=""):
    """Alerte dédupliquée : notifie quand elle apparaît, puis quand elle est résolue."""
    cur = db.one("SELECT * FROM alerts WHERE key=?", key)
    now = db.now()
    if active:
        if not cur or not cur["active"]:
            db.run("INSERT INTO alerts(key,level,title,body,active,since,updated) VALUES(?,?,?,?,1,?,?) "
                   "ON CONFLICT(key) DO UPDATE SET level=excluded.level,title=excluded.title,body=excluded.body,"
                   "active=1,since=excluded.since,updated=excluded.updated", key, level, title, body, now, now)
            core.notify(core.admins_with("viewMonitoring"), title, body, level, "/admin")
            core.discord(title, body, level)
        else:
            db.run("UPDATE alerts SET body=?, updated=? WHERE key=?", body, now, key)
    elif cur and cur["active"]:
        db.run("UPDATE alerts SET active=0, updated=? WHERE key=?", now, key)
        core.notify(core.admins_with("viewMonitoring"), "Résolu : " + cur["title"], "", "success", "/admin")
        core.discord("Résolu : " + cur["title"], "", "success")


def evaluate():
    s = STATE
    alert("storage.mount", not s["storage_mounted"], "error", "Le stockage n'est pas monté",
          "/srv/storage n'est pas monté : le RAID est peut-être absent.")
    for a in s["raid"]:
        alert(f"raid.{a['name']}.degraded", a["degraded"], "error", f"RAID {a['name']} dégradé",
              f"Seulement {a['active']}/{a['expected']} disques actifs ({a['bits']}). Remplace le disque défaillant au plus vite.")
        alert(f"raid.{a['name']}.rebuild", a["action"] in ("recovery", "reshape"), "warning",
              f"RAID {a['name']} en reconstruction", f"{a['progress']}% — fin estimée dans {a['finish']}.")
    for d in s["disks"]:
        n = f"{d['name']} ({d['model']})"
        alert(f"disk.{d['serial']}.health", d["healthy"] is False, "error", f"Disque {n} en mauvaise santé",
              "SMART signale une défaillance. Sauvegarde et prévois le remplacement.")
        bad = (d["reallocated"] or 0) + (d["pending"] or 0) + (d["uncorrectable"] or 0)
        alert(f"disk.{d['serial']}.sectors", bad > 0, "warning", f"Secteurs défectueux sur {n}",
              f"Réalloués : {d['reallocated']}, en attente : {d['pending']}, non corrigibles : {d['uncorrectable']}.")
        alert(f"disk.{d['serial']}.temp", (d["temp"] or 0) >= 50, "warning", f"Disque {n} trop chaud",
              f"{d['temp']} °C. Vérifie la ventilation.")
    if s["storage"]:
        p = s["storage"]["pct"]
        alert("storage.full", p >= 85, "error" if p >= 95 else "warning", "Stockage presque plein",
              f"{p}% utilisés, {core.fmt_size(s['storage']['free'])} libres.")
    alert("system.full", s["system"]["pct"] >= 90, "warning", "Disque système presque plein", f"{s['system']['pct']}% utilisés.")
    for sv in s["services"]:
        if sv["unit"] == "tailscaled" and s["tailscale"].get("state") == "NeedsLogin":
            continue
        alert(f"service.{sv['unit']}", not sv["active"], "error", f"Service arrêté : {sv['label']}",
              f"{sv['unit']} est « {sv['state']} ».")
    snap = snapshot_state()
    stale = not snap or time.time() - time.mktime(time.strptime(snap["date"][:19], "%Y-%m-%dT%H:%M:%S")) > 36 * 3600
    alert("snapshot.stale", bool(stale or (snap and not snap["ok"])), "warning", "Snapshot quotidien manquant ou en échec",
          "Le dernier snapshot réussi date de plus de 36 h." if stale else "Le dernier snapshot a échoué.")
    sb = sysbackup_state()
    alert("sysbackup.stale", not sb or _age_h(sb["date"]) > 36, "warning", "Sauvegarde du disque système manquante",
          "nas-sysbackup n'a pas tourné depuis plus de 36 h.")
    # Événements remontés par smartd / mdadm
    path = "/var/lib/nas/alerts.log"
    try:
        size = os.path.getsize(path)
        if _alerts_log_pos["pos"] is None:
            _alerts_log_pos["pos"] = size
        elif size > _alerts_log_pos["pos"]:
            with open(path) as f:
                f.seek(_alerts_log_pos["pos"])
                for line in f.read().splitlines()[-20:]:
                    core.notify(core.admins_with("viewMonitoring"), "Alerte système", line[26:], "error", "/admin")
                    core.discord("Alerte système", line[26:], "error")
            _alerts_log_pos["pos"] = size
    except OSError:
        pass


# ================================================================== photos
def index_file(share, path: Path, sha1=None):
    st = path.stat()
    m = media.metadata(path)
    rel = str(path.relative_to(core.share_root(share)))
    db.run("INSERT INTO photos(share_id,relpath,taken_at,mtime,size,width,height,is_video,lat,lon,sha1,seen) "
           "VALUES(?,?,?,?,?,?,?,?,?,?,?,1) ON CONFLICT(share_id,relpath) DO UPDATE SET taken_at=excluded.taken_at,"
           "mtime=excluded.mtime,size=excluded.size,width=excluded.width,height=excluded.height,is_video=excluded.is_video,"
           "lat=excluded.lat,lon=excluded.lon,sha1=COALESCE(excluded.sha1,photos.sha1),seen=1",
           share["id"], rel, m["taken_at"], int(st.st_mtime), st.st_size, m["width"], m["height"],
           1 if media.kind(path.name) == "video" else 0, m["lat"], m["lon"], sha1)
    try:
        media.thumb(path, 320)
    except Exception:
        pass


_index_lock = threading.Lock()


def index_photos():
    if not _index_lock.acquire(blocking=False):
        return
    try:
        for share in db.q("SELECT * FROM shares WHERE photos=1"):
            root = core.share_root(share)
            if not root.is_dir():
                continue
            known = {r["relpath"]: r for r in db.q("SELECT relpath, mtime, size FROM photos WHERE share_id=?", share["id"])}
            seen = set()
            for dirpath, dirs, files in os.walk(root):
                dirs[:] = [d for d in dirs if not d.startswith((".", "@", "#"))]
                for f in files:
                    if f.startswith(".") or media.kind(f) not in ("image", "video"):
                        continue
                    p = Path(dirpath) / f
                    rel = str(p.relative_to(root))
                    seen.add(rel)
                    try:
                        st = p.stat()
                    except OSError:
                        continue
                    k = known.get(rel)
                    if k and k["mtime"] == int(st.st_mtime) and k["size"] == st.st_size:
                        continue
                    index_file(share, p)
            gone = set(known) - seen
            for rel in gone:
                db.run("DELETE FROM photos WHERE share_id=? AND relpath=?", share["id"], rel)
        db.run("DELETE FROM photos WHERE share_id NOT IN (SELECT id FROM shares WHERE photos=1)")
    finally:
        _index_lock.release()


# ================================================================== GitHub
def _gh_api(url, token):
    import urllib.request
    req = urllib.request.Request(url, headers={"Accept": "application/vnd.github+json", "User-Agent": "nas-backup",
                                               **({"Authorization": f"Bearer {token}"} if token else {})})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read()), r.headers.get("Link", "")


def github_backup():
    if GITHUB_RUNNING.is_set():
        return
    GITHUB_RUNNING.set()
    try:
        cfg = db.get_setting("github") or {}
        token, owners = cfg.get("token", ""), cfg.get("owners", [])
        repos = {}
        for owner in owners:
            for kind in ("orgs", "users"):
                try:
                    page = 1
                    while True:
                        data, _ = _gh_api(f"https://api.github.com/{kind}/{owner}/repos?per_page=100&page={page}&type=all", token)
                        for rp in data:
                            repos[rp["full_name"]] = rp
                        if len(data) < 100:
                            break
                        page += 1
                    break
                except Exception:
                    continue
        if token:  # dépôts privés accessibles au token (y compris ceux des orgas)
            try:
                page = 1
                while True:
                    data, _ = _gh_api(f"https://api.github.com/user/repos?per_page=100&page={page}&affiliation=owner,organization_member,collaborator", token)
                    for rp in data:
                        if rp["owner"]["login"].lower() in [o.lower() for o in owners]:
                            repos[rp["full_name"]] = rp
                    if len(data) < 100:
                        break
                    page += 1
            except Exception as e:
                log.warning("github /user/repos: %s", e)
        auth = []
        if token:
            b = base64.b64encode(f"x-access-token:{token}".encode()).decode()
            auth = ["-c", f"http.extraHeader=Authorization: Basic {b}"]
        errors = 0
        for full, rp in sorted(repos.items()):
            dest = GITHUB_DIR / f"{full}.git"
            dest.parent.mkdir(parents=True, exist_ok=True)
            url = rp["clone_url"]
            if dest.exists():
                cmd = ["git", *auth, "-C", str(dest), "remote", "update", "--prune"]
            else:
                cmd = ["git", *auth, "clone", "--mirror", url, str(dest)]
            r = subprocess.run(cmd, capture_output=True, text=True, timeout=3600,
                               env={**os.environ, "GIT_TERMINAL_PROMPT": "0", "HOME": "/var/lib/nas"})
            ok = r.returncode == 0
            errors += 0 if ok else 1
            size = sum(f.stat().st_size for f in dest.rglob("*") if f.is_file()) if dest.exists() else 0
            db.run("INSERT INTO github_repos(full_name,private,last_sync,status,detail,size) VALUES(?,?,?,?,?,?) "
                   "ON CONFLICT(full_name) DO UPDATE SET private=excluded.private,last_sync=excluded.last_sync,"
                   "status=excluded.status,detail=excluded.detail,size=excluded.size",
                   full, 1 if rp.get("private") else 0, db.now(), "ok" if ok else "erreur",
                   "" if ok else (r.stderr.replace(token, "***") if token else r.stderr)[-500:], size)
        alert("github.backup", errors > 0, "warning", "Sauvegarde GitHub incomplète",
              f"{errors} dépôt(s) n'ont pas pu être sauvegardés.")
    finally:
        GITHUB_RUNNING.clear()


# ================================================================== planificateur
def _loop():
    last = {"collect": 0, "evaluate": 0, "photos": 0, "github_day": None, "video": time.time() - 540}
    time.sleep(3)
    while True:
        now = time.time()
        try:
            if now - last["collect"] >= 30:
                collect()
                last["collect"] = now
            if now - last["evaluate"] >= 120:
                evaluate()
                last["evaluate"] = now
            if now - last.get("sync", 0) >= 20:
                last["sync"] = now
                from .routes.sync import accept_pending
                threading.Thread(target=accept_pending, daemon=True).start()
            if now - last["photos"] >= 900:
                threading.Thread(target=index_photos, daemon=True).start()
                last["photos"] = now
            if now - last["video"] >= 600:
                last["video"] = now
                from . import video
                threading.Thread(target=video.precache, daemon=True, name="nas-video-pre").start()
            lt = time.localtime()
            cfg = db.get_setting("github") or {}
            if cfg.get("enabled") and lt.tm_hour == 4 and last["github_day"] != lt.tm_yday:
                last["github_day"] = lt.tm_yday
                threading.Thread(target=github_backup, daemon=True).start()
            if lt.tm_hour == 3 and last.get("cleanup_day") != lt.tm_yday:
                last["cleanup_day"] = lt.tm_yday
                from .routes.drive import cleanup_transfers, cleanup_chunks
                cleanup_transfers()
                cleanup_chunks()
                from . import video
                video.cleanup()
                db.run("DELETE FROM activity WHERE ts < ?", db.now() - 180 * 86400)
            db.run("DELETE FROM sessions WHERE expires < ?", db.now())
            db.run("DELETE FROM notifications WHERE created_at < ? AND read=1", db.now() - 90 * 86400)
        except Exception:
            log.exception("job")
        time.sleep(10)


def start():
    threading.Thread(target=_loop, daemon=True, name="nas-jobs").start()

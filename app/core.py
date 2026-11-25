"""Cœur : authentification, permissions, accès aux partages, helper root, audit, notifications."""
import base64
import hashlib
import hmac
import json
import os
import secrets
import struct
import subprocess
import threading
import time
from pathlib import Path

from argon2 import PasswordHasher
from argon2.exceptions import VerifyMismatchError, InvalidHashError
from fastapi import Depends, HTTPException, Request

from . import db
import logging
log = logging.getLogger("nas")

STORAGE = Path("/srv/storage")
SNAPSHOTS = STORAGE / ".snapshots"
TRASH_DIR = ".corbeille"
SESSION_COOKIE = "nas_session"
SESSION_DAYS = 30
ph = PasswordHasher()

# ---------------------------------------------------------------- permissions
# Interrupteurs fins par permission ; un administrateur a tout d'office.
PERMISSIONS = {
    "manageUsers": "Comptes, groupes, réinitialisation des mots de passe et de la 2FA",
    "manageShares": "Créer et modifier tous les dossiers partagés et leurs permissions",
    "viewMonitoring": "Vue d'ensemble, disques, RAID, services, alertes",
    "manageBackups": "Snapshots, sauvegarde GitHub",
    "manageDocker": "Conteneurs Docker (démarrer, arrêter, journaux)",
    "viewLogs": "Journal d'audit",
}
ROLES = {"admin": "Administrateur", "membre": "Membre de la famille", "invite": "Invité"}


def user_perms(u) -> dict:
    if u["role"] == "admin":
        return {k: True for k in PERMISSIONS}
    p = json.loads(u["perms"] or "{}") if isinstance(u["perms"], str) else (u["perms"] or {})
    if u["role"] == "invite":  # un invité n'a jamais de droits d'administration
        return {k: False for k in PERMISSIONS}
    return {k: bool(p.get(k)) for k in PERMISSIONS}


def has_admin_space(u) -> bool:
    return any(user_perms(u).values())


# ---------------------------------------------------------------- mots de passe
def hash_pw(pw: str) -> str:
    return ph.hash(pw)


def check_pw(h: str, pw: str) -> bool:
    try:
        return ph.verify(h, pw)
    except (VerifyMismatchError, InvalidHashError):
        return False


def validate_pw(pw: str):
    if not isinstance(pw, str) or len(pw) < 10:
        raise HTTPException(400, "Le mot de passe doit faire au moins 10 caractères.")
    if len(pw) > 200:
        raise HTTPException(400, "Mot de passe trop long.")


def gen_password() -> str:
    alphabet = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789"
    return "-".join("".join(secrets.choice(alphabet) for _ in range(4)) for _ in range(4))


# ---------------------------------------------------------------- TOTP (2FA)
def totp_new_secret() -> str:
    return base64.b32encode(secrets.token_bytes(20)).decode().rstrip("=")


def _totp(secret: str, counter: int) -> str:
    key = base64.b32decode(secret + "=" * (-len(secret) % 8))
    d = hmac.new(key, struct.pack(">Q", counter), hashlib.sha1).digest()
    o = d[-1] & 0x0F
    return f"{(struct.unpack('>I', d[o:o + 4])[0] & 0x7FFFFFFF) % 1_000_000:06d}"


_totp_used = {}


def totp_verify(u, code: str) -> bool:
    """Vérifie un code contre tous les appareils 2FA du compte (téléphone, PC…)."""
    for d in db.q("SELECT * FROM totp_devices WHERE user_id=?", u["id"]):
        if totp_check(d["secret"], code, f"{u['id']}:{d['id']}"):
            db.run("UPDATE totp_devices SET last_used=? WHERE id=?", db.now(), d["id"])
            return True
    return False


def sync_totp_flag(user_id: int):
    n = db.one("SELECT COUNT(*) n FROM totp_devices WHERE user_id=?", user_id)["n"]
    db.run("UPDATE users SET totp_enabled=? WHERE id=?", 1 if n else 0, user_id)


def totp_check(secret: str, code: str, user_id=0) -> bool:
    code = (code or "").replace(" ", "")
    if not (code.isdigit() and len(code) == 6) or not secret:
        return False
    t = int(time.time()) // 30
    for c in (t - 1, t, t + 1):
        if hmac.compare_digest(_totp(secret, c), code):
            if _totp_used.get(user_id) == (c, code):  # anti-rejeu
                return False
            _totp_used[user_id] = (c, code)
            return True
    return False


# ---------------------------------------------------------------- limite de tentatives
_fails = {}


def rate_check(key: str, limit=5, window=600):
    now = time.time()
    lst = [t for t in _fails.get(key, []) if now - t < window]
    _fails[key] = lst
    if len(lst) >= limit:
        raise HTTPException(429, "Trop de tentatives. Réessaie dans quelques minutes.")


def rate_fail(key: str):
    _fails.setdefault(key, []).append(time.time())


# ---------------------------------------------------------------- sessions
import ipaddress
# Réseau de la maison : plages privées par défaut, à restreindre avec ARCHE_LAN_NETS (ex. "192.168.1.0/24")
_LAN_NETS = os.environ.get("ARCHE_LAN_NETS", "10.0.0.0/8,172.16.0.0/12,192.168.0.0/16")
INTERNAL_NETS = [ipaddress.ip_network(n) for n in ("127.0.0.0/8", "::1/128", "100.64.0.0/10",
                                                   "fd7a:115c:a1e0::/48", "fe80::/10",
                                                   *[x.strip() for x in _LAN_NETS.split(",") if x.strip()])]


_pub = {"t": 0, "ips": set()}


def home_public_ips() -> list:
    """Adresses publiques de la maison (écrites par nas-ddns) : IPv4 de la box + préfixe IPv6 /64 du réseau local.
    Derrière Cloudflare, un appareil de la maison apparaît avec l'une d'elles (on ne peut pas les usurper)."""
    if time.time() - _pub["t"] > 60:
        nets = []
        try:
            for l in open("/var/lib/nas/public-ip"):
                try:
                    nets.append(ipaddress.ip_network(l.strip(), strict=False))
                except ValueError:
                    pass
        except OSError:
            pass
        _pub["ips"], _pub["t"] = nets, time.time()
    return _pub["ips"]


def in_home(ip_str: str) -> bool:
    try:
        ip = ipaddress.ip_address(ip_str)
        return any(ip.version == n.version and ip in n for n in home_public_ips())
    except ValueError:
        return False


def via_edge(req: Request) -> bool:
    """Requête arrivée par Cloudflare (en-tête posé par Caddy, retiré sur les accès locaux)."""
    return req.headers.get("x-nas-edge") == "cf"


_bans = {"t": 0, "m": 0, "ips": set()}


def banned_ips() -> set:
    """IP bannies par fail2ban (action nas-ban) : l'app les refuse, car derrière Cloudflare le pare-feu ne voit que Cloudflare."""
    if time.time() - _bans["t"] > 5:
        _bans["t"] = time.time()
        try:
            m = os.stat("/var/lib/nas/banned-ips").st_mtime
            if m != _bans["m"]:
                _bans["m"] = m
                _bans["ips"] = {l.strip() for l in open("/var/lib/nas/banned-ips") if l.strip()}
        except OSError:
            _bans["ips"] = set()
    return _bans["ips"]


def is_internal(req: Request) -> bool:
    """Vrai si la requête vient de la maison (LAN, NAT loopback) ou du VPN Tailscale."""
    if via_edge(req):  # par Internet : « maison » seulement si l'IP réelle est l'IP publique de la maison
        return in_home(client_ip(req))
    try:
        ip = ipaddress.ip_address(client_ip(req))
        if ip.version == 6 and ip.ipv4_mapped:
            ip = ip.ipv4_mapped
        return any(ip in n for n in INTERNAL_NETS) or in_home(str(ip))
    except ValueError:
        return False


def client_ip(req: Request) -> str:
    # Adresse résolue par uvicorn (--proxy-headers, uniquement depuis Caddy en local) : jamais un en-tête brut du client.
    return req.client.host if req.client else ""


def is_https(req: Request) -> bool:
    return req.headers.get("x-forwarded-proto") == "https" or req.url.scheme == "https"


def create_session(req: Request, user_id: int) -> str:
    token = secrets.token_urlsafe(32)
    now = db.now()
    db.run("INSERT INTO sessions(token_hash,user_id,created,expires,last_seen,ip,ua) VALUES(?,?,?,?,?,?,?)",
           hashlib.sha256(token.encode()).hexdigest(), user_id, now, now + SESSION_DAYS * 86400, now,
           client_ip(req), req.headers.get("user-agent", "")[:200])
    db.run("UPDATE users SET last_login=? WHERE id=?", now, user_id)
    return token


# Jeton de l'app Android : n'ouvre que la sauvegarde des photos, l'envoi par morceaux, les notifications et /api/app/*
APP_PATHS = ("/api/photos/backup", "/api/photos/check", "/api/chunks/", "/api/app/", "/api/notifications", "/api/me")


def app_user(req: Request):
    auth = req.headers.get("authorization", "")
    if not auth.startswith("Bearer arche_app_") or not req.url.path.startswith(APP_PATHS):
        return None
    th = hashlib.sha256(auth[7:].strip().encode()).hexdigest()
    d = db.one("SELECT id, user_id, last_seen FROM app_devices WHERE token_hash=?", th)
    if not d:
        return None
    u = db.one("SELECT * FROM users WHERE id=? AND disabled=0", d["user_id"])
    if not u:
        return None
    if db.now() - (d["last_seen"] or 0) > 300:
        db.run("UPDATE app_devices SET last_seen=? WHERE id=?", db.now(), d["id"])
    u["_app_device"] = d["id"]
    return u


def session_user(req: Request):
    token = req.cookies.get(SESSION_COOKIE)
    if not token:
        return app_user(req)
    th = hashlib.sha256(token.encode()).hexdigest()
    s = db.one("SELECT * FROM sessions WHERE token_hash=?", th)
    if not s or s["expires"] < db.now():
        return None
    u = db.one("SELECT * FROM users WHERE id=? AND disabled=0", s["user_id"])
    if not u:
        return None
    if db.now() - s["last_seen"] > 300:
        db.run("UPDATE sessions SET last_seen=? WHERE token_hash=?", db.now(), th)
    u["_session"] = th
    return u


def current_user(req: Request):
    # Anti-CSRF : toute requête qui modifie doit porter l'en-tête X-NAS (impossible cross-origin sans CORS)
    if req.method not in ("GET", "HEAD", "OPTIONS") and req.headers.get("x-nas") != "1":
        raise HTTPException(403, "Requête refusée (CSRF).")
    u = session_user(req)
    if not u:
        raise HTTPException(401, "Non connecté.")
    path = req.url.path
    if u["must_change"] and not path.startswith(("/api/auth/", "/api/me")):
        raise HTTPException(403, detail="password_change_required")
    if not u["totp_enabled"] and not is_internal(req) and not (path.startswith("/api/auth/") or path == "/api/me"
                                                                or path.startswith("/api/me/2fa") or path == "/api/me/password"):
        raise HTTPException(403, detail="2fa_setup_required")
    return u


def require_perm(perm: str):
    """Dépendance FastAPI : vérifie la permission + la 2FA pour l'espace Administration."""
    def dep(req: Request, u=Depends(current_user)):
        if not is_internal(req):
            raise HTTPException(403, "L'administration n'est accessible que depuis la maison ou le VPN.")
        if not user_perms(u).get(perm):
            raise HTTPException(403, "Tu n'as pas la permission d'accéder à cet outil.")
        if db.get_setting("require_2fa_admin") and not u["totp_enabled"]:
            raise HTTPException(403, detail="2fa_required")
        return u
    return dep


def require_member(u=Depends(current_user)):
    if u["role"] == "invite":
        raise HTTPException(403, "Réservé aux membres de la famille.")
    return u


def public_user(u) -> dict:
    return {"id": u["id"], "username": u["username"], "display_name": u["display_name"], "role": u["role"],
            "perms": user_perms(u), "totp_enabled": bool(u["totp_enabled"]), "must_change": bool(u["must_change"]),
            "smb_enabled": bool(u["smb_enabled"]), "disabled": bool(u["disabled"]),
            "last_login": u["last_login"], "created_at": u["created_at"],
            "prefs": json.loads(u.get("prefs") or "{}")}


# ---------------------------------------------------------------- audit
def audit(req: Request | None, u, action: str, target: str = "", detail: str = ""):
    db.run("INSERT INTO audit(ts,user_id,username,action,target,detail,ip) VALUES(?,?,?,?,?,?,?)",
           db.now(), u["id"] if u else None, u["username"] if u else None, action, target[:300],
           detail[:1000], client_ip(req) if req else None)


# ---------------------------------------------------------------- helper root
def helper(*args, stdin: str | None = None, timeout=120, raw=False):
    r = subprocess.run(["sudo", "-n", "/usr/local/sbin/nas-helper", *args], input=stdin,
                       capture_output=True, text=True, timeout=timeout)
    if raw:
        return r.stdout
    try:
        out = json.loads(r.stdout.strip().splitlines()[-1]) if r.stdout.strip() else {}
    except (json.JSONDecodeError, IndexError):
        out = {}
    if r.returncode != 0 or (isinstance(out, dict) and out.get("ok") is False):
        raise HTTPException(500, f"Action système échouée : {out.get('error') or r.stderr.strip()[:300]}")
    return out


# ---------------------------------------------------------------- partages & accès
LEVELS = {"none": 0, "read": 1, "write": 2}


def user_group_ids(user_id: int) -> list[int]:
    return [r["group_id"] for r in db.q("SELECT group_id FROM group_members WHERE user_id=?", user_id)]


def share_level(u, share) -> str:
    if u["role"] == "admin":
        return "write"
    if share["owner_id"] == u["id"]:
        return "write"
    if user_perms(u).get("manageShares") and share["kind"] != "personal":
        return "write"
    best = 0
    gids = user_group_ids(u["id"])
    for p in db.q("SELECT * FROM share_perms WHERE share_id=?", share["id"]):
        if (p["subject_type"] == "user" and p["subject_id"] == u["id"]) or \
           (p["subject_type"] == "group" and p["subject_id"] in gids):
            best = max(best, LEVELS.get(p["level"], 0))
    return {0: "none", 1: "read", 2: "write"}[best]


def can_manage_share(u, share) -> bool:
    return u["role"] == "admin" or share["owner_id"] == u["id"] or \
        (user_perms(u).get("manageShares") and share["kind"] != "personal")


def get_share(share_id) -> dict:
    s = db.one("SELECT * FROM shares WHERE id=?", int(share_id))
    if not s:
        raise HTTPException(404, "Dossier partagé introuvable.")
    return s


def share_root(share) -> Path:
    return STORAGE / share["path"]


def safe_path(share, rel: str = "", must_exist=True) -> Path:
    """Résout un chemin relatif dans un partage, sans jamais en sortir."""
    rel = (rel or "").strip("/")
    parts = [p for p in rel.split("/") if p not in ("", ".")]
    if any(p == ".." for p in parts) or (parts and parts[0] == TRASH_DIR):
        raise HTTPException(400, "Chemin invalide.")
    root = share_root(share).resolve()
    p = (root / "/".join(parts)).resolve() if parts else root
    if p != root and root not in p.parents:
        raise HTTPException(400, "Chemin invalide.")
    if must_exist and not p.exists():
        raise HTTPException(404, "Fichier ou dossier introuvable.")
    return p


def access(u, share_id, need="read"):
    s = get_share(share_id)
    lvl = share_level(u, s)
    if LEVELS[lvl] < LEVELS[need]:
        raise HTTPException(403, "Tu n'as pas accès à ce dossier." if lvl == "none" else "Accès en lecture seule.")
    return s, lvl


def valid_name(name: str) -> str:
    name = (name or "").strip()
    if not name or name in (".", "..") or "/" in name or "\0" in name or len(name.encode()) > 250 \
            or name == TRASH_DIR:
        raise HTTPException(400, "Nom invalide.")
    return name


def unique_path(p: Path) -> Path:
    if not p.exists():
        return p
    stem, suf = (p.stem, p.suffix) if p.is_file() or "." in p.name else (p.name, "")
    i = 1
    while True:
        c = p.with_name(f"{stem} ({i}){suf}")
        if not c.exists():
            return c
        i += 1


def sync_samba():
    """Régénère la config Samba à partir de la base (via le helper root)."""
    users = {u["id"]: u for u in db.q("SELECT * FROM users WHERE disabled=0 AND smb_enabled=1")}
    groups = {}
    for gm in db.q("SELECT * FROM group_members"):
        groups.setdefault(gm["group_id"], []).append(gm["user_id"])
    admins = [u["username"] for u in users.values() if u["role"] == "admin"]
    spec = []
    for s in db.q("SELECT * FROM shares WHERE smb=1 ORDER BY name"):
        rw, ro = set(), set()
        if s["kind"] != "timemachine":
            rw |= set(admins)
        if s["owner_id"] in users:
            rw.add(users[s["owner_id"]]["username"])
        for p in db.q("SELECT * FROM share_perms WHERE share_id=?", s["id"]):
            ids = [p["subject_id"]] if p["subject_type"] == "user" else groups.get(p["subject_id"], [])
            for i in ids:
                if i in users:
                    (rw if p["level"] == "write" else ro).add(users[i]["username"])
        for u in users.values():
            if s["kind"] == "standard" and user_perms(u).get("manageShares"):
                rw.add(u["username"])
        spec.append({"name": s["name"], "path": s["path"], "write": sorted(rw), "read": sorted(ro - rw),
                     "timemachine": s["kind"] == "timemachine", "tm_size_gb": s["tm_size_gb"]})
    tmp = "/var/lib/nas/samba-shares.json"
    with open(tmp + ".tmp", "w") as f:
        json.dump(spec, f, indent=1)
    os.replace(tmp + ".tmp", tmp)
    helper("samba-apply")


# ---------------------------------------------------------------- notifications
def notify(user_ids, title, body="", level="info", link=None, push=True):
    from . import push as pushmod
    for uid in set(user_ids):
        db.run("INSERT INTO notifications(user_id,level,title,body,link,created_at) VALUES(?,?,?,?,?,?)",
               uid, level, title, body, link, db.now())
    if push:
        threading.Thread(target=pushmod.send_to_users, args=(list(set(user_ids)), title, body, link),
                         daemon=True).start()


DISCORD_COLORS = {"error": 0xE5484D, "warning": 0xEC8200, "success": 0x30A46C, "info": 0x3E63DD}


def discord(title, body="", level="info"):
    """Envoie un message au webhook Discord configuré (Réglages). Silencieux en cas d'erreur."""
    url = db.get_setting("discord_webhook") or ""
    if not url:
        return
    import urllib.request

    def send():
        payload = {"username": db.get_setting("app_name") or "Arche",
                   "embeds": [{"title": str(title)[:256], "description": str(body)[:2000],
                               "color": DISCORD_COLORS.get(level, DISCORD_COLORS["info"])}]}
        req = urllib.request.Request(url, data=json.dumps(payload).encode(), method="POST",
                                     headers={"Content-Type": "application/json", "User-Agent": "Arche-NAS"})
        try:
            urllib.request.urlopen(req, timeout=10).read()
        except Exception as e:
            log.warning("discord: %s", e)
    threading.Thread(target=send, daemon=True).start()


def admins_with(perm: str) -> list[int]:
    return [u["id"] for u in db.q("SELECT * FROM users WHERE disabled=0") if user_perms(u).get(perm)]


def log_activity(u, share, rel, action):
    try:
        db.run("INSERT INTO activity(user_id,share_id,relpath,action,ts) VALUES(?,?,?,?,?)",
               u["id"] if u else None, share["id"], str(rel), action, db.now())
    except Exception:
        pass


def zip_stream(items):
    """items: liste de (Path absolu, nom dans l'archive). Zip en flux (sans fichier temporaire)."""
    import zipfile
    r, w = os.pipe()

    def writer():
        with os.fdopen(w, "wb") as fw:
            try:
                with zipfile.ZipFile(fw, "w", zipfile.ZIP_STORED, allowZip64=True) as z:
                    for path, arc in items:
                        if path.is_dir():
                            for dp, dirs, files in os.walk(path):
                                dirs[:] = [d for d in dirs if not d.startswith(".")]
                                for f in files:
                                    if f.startswith("."):
                                        continue
                                    fp = Path(dp) / f
                                    z.write(fp, str(Path(arc) / fp.relative_to(path)))
                        elif path.is_file():
                            z.write(path, arc)
            except (BrokenPipeError, OSError):
                pass
    threading.Thread(target=writer, daemon=True).start()

    def gen():
        with os.fdopen(r, "rb") as fr:
            while chunk := fr.read(1 << 20):
                yield chunk
    return gen()


SAFE_INLINE = ("image/jpeg", "image/png", "image/webp", "image/gif", "image/avif", "image/heic", "image/heif",
               "application/pdf")
SCRIPTABLE = ("text/html", "image/svg+xml", "application/xhtml+xml", "text/xml", "application/xml",
              "text/javascript", "application/javascript")


def file_response(path: Path, dl: bool = False, cache: str = "private, max-age=3600"):
    """FileResponse durcie : un fichier utilisateur ne peut jamais exécuter de script dans l'origine du NAS."""
    import mimetypes
    from urllib.parse import quote
    from fastapi.responses import FileResponse
    mt = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
    headers = {"Cache-Control": cache, "X-Content-Type-Options": "nosniff",
               "Content-Disposition": f"{'attachment' if dl else 'inline'}; filename*=UTF-8''{quote(path.name)}"}
    if not (mt in SAFE_INLINE or mt.startswith(("video/", "audio/"))):
        headers["Content-Security-Policy"] = "sandbox; default-src 'none'; style-src 'unsafe-inline'"
        if mt in SCRIPTABLE or mt.startswith("text/"):
            mt = "text/plain; charset=utf-8"
    return FileResponse(path, media_type=mt, headers=headers)


def fmt_size(n: int) -> str:
    for unit in ("o", "Ko", "Mo", "Go", "To"):
        if n < 1024:
            return f"{n:.0f} {unit}" if unit == "o" else f"{n:.1f} {unit}"
        n /= 1024
    return f"{n:.1f} Po"

"""Synchronisation des PC Windows et téléphones Android (façon OneDrive / Google Photos) via Syncthing.

Syncthing tourne sous l'utilisateur `nas` (service nas-syncthing), son API n'écoute qu'en local ;
Arche la pilote :
  - chaque appareil (PC ou téléphone) appartient à un compte Arche ;
  - quand un appareil propose un dossier, Arche l'accepte tout seul et le range dans l'espace perso du propriétaire :
      PC        → <perso>/Ordinateurs/<appareil>/<dossier>   (synchro dans les 2 sens, corbeille 30 jours côté NAS)
      téléphone → <perso>/Photos/<appareil>/<dossier>        (réception seule, les suppressions du téléphone sont ignorées)
  - un appareil ne voit jamais que ses propres dossiers.
"""
import json
import re
import threading
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

import qrcode
import qrcode.image.svg
from fastapi import APIRouter, Depends, HTTPException, Request

from .. import core, db

r = APIRouter()
API = "http://127.0.0.1:8384/rest"
HOME = Path("/var/lib/nas/syncthing")
KINDS = {"pc": "Ordinateurs", "phone": "Photos"}
_lock = threading.Lock()
_key = None

db.conn().executescript("""
CREATE TABLE IF NOT EXISTS sync_devices(device_id TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL, kind TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS sync_folders(folder_id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, device_id TEXT NOT NULL,
  label TEXT NOT NULL, relpath TEXT NOT NULL, kind TEXT NOT NULL, created_at INTEGER NOT NULL);
""")


# ------------------------------------------------------------------ client API Syncthing
def _apikey():
    global _key
    if not _key:
        m = re.search(r"<apikey>([^<]+)</apikey>", (HOME / "config.xml").read_text())
        _key = m.group(1) if m else ""
    return _key


def st(method, path, body=None, timeout=6):
    req = urllib.request.Request(API + path, method=method, headers={"X-API-Key": _apikey(), "Content-Type": "application/json"},
                                 data=json.dumps(body).encode() if body is not None else None)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as res:
            raw = res.read()
            return json.loads(raw) if raw.strip() else None
    except urllib.error.HTTPError as e:
        raise HTTPException(502, f"Synchronisation : {e.read().decode(errors='replace')[:200] or e.reason}")
    except (urllib.error.URLError, OSError):
        raise HTTPException(503, "Le service de synchronisation ne répond pas. Réessaie dans un instant.")


def my_id():
    return st("GET", "/system/status")["myID"]


def _clean(name, fallback):
    name = re.sub(r'[\\/:*?"<>|\x00-\x1f]', " ", str(name or "")).strip(" .")
    return re.sub(r"\s+", " ", name)[:60] or fallback


def _perso(uid):
    s = db.one("SELECT * FROM shares WHERE kind='personal' AND owner_id=?", uid)
    if not s:
        raise HTTPException(400, "Aucun espace personnel pour ce compte.")
    return s


# ------------------------------------------------------------------ acceptation automatique des dossiers
def accept_pending():
    """Accepte les dossiers proposés par les appareils connus (appelé toutes les 20 s et à chaque affichage)."""
    if not _lock.acquire(blocking=False):
        return
    try:
        pend = st("GET", "/cluster/pending/folders") or {}
        if not pend:
            return
        owners = {d["device_id"]: d for d in db.q("SELECT * FROM sync_devices")}
        folders = {f["id"]: f for f in st("GET", "/config/folders")}
        for fid, info in pend.items():
            for did, offer in (info.get("offeredBy") or {}).items():
                dev = owners.get(did)
                if not dev or offer.get("remoteEncrypted") or offer.get("receiveEncrypted"):
                    continue
                known = db.one("SELECT * FROM sync_folders WHERE folder_id=?", fid)
                if fid in folders:
                    # même dossier partagé par un 2e appareil du MÊME compte (ex. PC ↔ téléphone) : on l'ajoute ; sinon jamais
                    if known and known["user_id"] == dev["user_id"]:
                        f = folders[fid]
                        if not any(x["deviceID"] == did for x in f["devices"]):
                            f["devices"].append({"deviceID": did, "introducedBy": "", "encryptionPassword": ""})
                            st("PUT", f"/config/folders/{urllib.parse.quote(fid)}", f)
                    continue
                _create_folder(fid, offer.get("label") or fid, dev)
    except HTTPException:
        pass
    except Exception:
        core.log.exception("sync accept")
    finally:
        _lock.release()


def _create_folder(fid, label, dev, offered_by_nas=False):
    share = _perso(dev["user_id"])
    root = core.share_root(share)
    base = f"{KINDS[dev['kind']]}/{_clean(dev['name'], 'Appareil')}/{_clean(label, 'Dossier')}"
    rel, n = base, 2
    while (root / rel).exists() and db.one("SELECT 1 FROM sync_folders WHERE relpath=? AND user_id=? AND folder_id<>?", rel, dev["user_id"], fid):
        rel, n = f"{base} ({n})", n + 1
    f = st("GET", "/config/defaults/folder")
    phone = dev["kind"] == "phone"
    f.update({
        # proposé par Arche : le téléphone voit juste « Appareil photo » ; sinon on précise l'appareil
        "id": fid, "label": label if offered_by_nas else f"{label} · {dev['name']}", "path": str(root / rel),
        "type": "receiveonly" if phone else "sendreceive",
        "devices": [{"deviceID": dev["device_id"], "introducedBy": "", "encryptionPassword": ""}],
        "ignoreDelete": phone,          # Google Photos : effacer sur le téléphone ne supprime pas la sauvegarde
        "ignorePerms": True, "fsWatcherEnabled": True, "rescanIntervalS": 3600,
        "versioning": {"type": "trashcan", "params": {"cleanoutDays": "30"}, "cleanupIntervalS": 3600, "fsPath": "", "fsType": "basic"},
    })
    (root / rel).mkdir(parents=True, exist_ok=True)
    st("PUT", f"/config/folders/{urllib.parse.quote(fid)}", f)
    db.run("INSERT OR REPLACE INTO sync_folders(folder_id,user_id,device_id,label,relpath,kind,created_at) VALUES(?,?,?,?,?,?,?)",
           fid, dev["user_id"], dev["device_id"], label, rel, dev["kind"], db.now())
    core.audit(None, {"id": dev["user_id"], "username": _uname(dev["user_id"])}, "synchro.dossier", rel, dev["name"])
    if offered_by_nas:
        return
    core.notify([dev["user_id"]], f"« {label} » se synchronise", f"Depuis {dev['name']}, dans Mes fichiers › {rel.replace('/', ' › ')}.",
                "success", "/fichiers?p=" + urllib.parse.quote(rel))


def _uname(uid):
    u = db.one("SELECT username FROM users WHERE id=?", uid)
    return u["username"] if u else None


# ------------------------------------------------------------------ API Arche
def _qr(text):
    import io
    buf = io.BytesIO()
    qrcode.make(text, image_factory=qrcode.image.svg.SvgPathImage, box_size=8, border=2).save(buf)
    return buf.getvalue().decode()


def _ago_ts(iso):
    """Horodatage Syncthing (RFC 3339, nanosecondes possibles) → secondes epoch."""
    from datetime import datetime
    if not iso or iso.startswith(("1970", "0001")):
        return None
    try:
        m = re.match(r"(.*T\d\d:\d\d:\d\d)(\.\d+)?(Z|[+-]\d\d:\d\d)?$", iso)
        return int(datetime.fromisoformat(m.group(1) + (m.group(3) or "Z").replace("Z", "+00:00")).timestamp())
    except (ValueError, AttributeError):
        return None


@r.get("/api/sync")
def overview(since: int = 0, u=Depends(core.current_user)):
    accept_pending()
    me = my_id()
    devs = db.q("SELECT * FROM sync_devices WHERE user_id=? ORDER BY created_at", u["id"])
    conns = (st("GET", "/system/connections") or {}).get("connections", {})
    stats = st("GET", "/stats/device") or {}
    out = []
    for d in devs:
        c = conns.get(d["device_id"], {})
        folders = []
        for f in db.q("SELECT * FROM sync_folders WHERE device_id=? AND user_id=? ORDER BY label", d["device_id"], u["id"]):
            try:
                s = st("GET", "/db/status?folder=" + urllib.parse.quote(f["folder_id"]))
                comp = st("GET", f"/db/completion?folder={urllib.parse.quote(f['folder_id'])}&device={d['device_id']}")
                errs = len((st("GET", "/folder/errors?folder=" + urllib.parse.quote(f["folder_id"])) or {}).get("errors") or [])
            except HTTPException:
                s, comp, errs = {}, {}, 0
            folders.append({"id": f["folder_id"], "label": f["label"], "relpath": f["relpath"], "kind": f["kind"],
                            "state": s.get("state", "unknown"), "files": s.get("localFiles", 0), "bytes": s.get("localBytes", 0),
                            "need_bytes": s.get("needBytes", 0), "need_files": s.get("needFiles", 0),
                            "remote_completion": comp.get("completion"), "remote_state": comp.get("remoteState"),
                            "offered": f["folder_id"] == phone_folder_id(d["device_id"]), "errors": errs})
        out.append({"id": d["device_id"], "name": d["name"], "kind": d["kind"], "created_at": d["created_at"],
                    "connected": bool(c.get("connected")), "address": c.get("address", ""), "relay": c.get("type", "").startswith("relay"),
                    "last_seen": _ago_ts((stats.get(d["device_id"]) or {}).get("lastSeen")), "folders": folders})
    owned = {x["device_id"] for x in db.q("SELECT device_id FROM sync_devices")}
    pending = []
    if since:  # appareils qui viennent de frapper à la porte, pendant l'assistant uniquement
        for did, p in (st("GET", "/cluster/pending/devices") or {}).items():
            t = _ago_ts(p.get("time"))
            if did not in owned and t and t >= since - 120:
                pending.append({"id": did, "name": p.get("name") or "Appareil", "address": p.get("address", ""), "time": t})
    return {"nas_id": me, "nas_qr": _qr(me), "devices": out, "pending": pending}


@r.post("/api/sync/devices")
async def add_device(req: Request, u=Depends(core.current_user)):
    d = await req.json()
    kind = d.get("kind")
    if kind not in KINDS:
        raise HTTPException(400, "Type d'appareil inconnu.")
    raw = re.sub(r"\s", "", str(d.get("device_id", ""))).upper()
    chk = st("GET", "/svc/deviceid?id=" + urllib.parse.quote(raw))
    if not chk or chk.get("error") or not chk.get("id"):
        raise HTTPException(400, "Cet identifiant d'appareil n'est pas valide. Copie-le en entier depuis Syncthing (Actions → Afficher l'ID).")
    did = chk["id"]
    if did == my_id():
        raise HTTPException(400, "C'est l'identifiant d'Arche lui-même : colle celui de ton PC ou de ton téléphone.")
    other = db.one("SELECT user_id FROM sync_devices WHERE device_id=?", did)
    if other and other["user_id"] != u["id"]:
        raise HTTPException(409, "Cet appareil est déjà associé à un autre compte.")
    name = _clean(d.get("name"), "PC" if kind == "pc" else "Téléphone")
    dev = st("GET", "/config/defaults/device")
    dev.update({"deviceID": did, "name": name, "addresses": ["dynamic"], "compression": "metadata",
                "introducer": False, "autoAcceptFolders": False, "paused": False})
    st("PUT", f"/config/devices/{did}", dev)
    db.run("INSERT OR REPLACE INTO sync_devices(device_id,user_id,name,kind,created_at) VALUES(?,?,?,?,?)", did, u["id"], name, kind, db.now())
    try:
        st("DELETE", f"/cluster/pending/devices?device={did}")
    except HTTPException:
        pass
    core.audit(req, u, "synchro.appareil.ajout", name, kind)
    if kind == "phone":
        # Arche propose lui-même le dossier « Appareil photo » : sur le téléphone, il suffit d'accepter et de choisir DCIM/Camera
        _create_folder(phone_folder_id(did), "Appareil photo", {"device_id": did, "user_id": u["id"], "name": name, "kind": kind}, offered_by_nas=True)
    return {"ok": True, "id": did, "name": name}


def phone_folder_id(did):
    return "arche-photos-" + did[:7].lower()


@r.patch("/api/sync/devices/{did}")
async def rename_device(did: str, req: Request, u=Depends(core.current_user)):
    dev = _mine(did, u)
    name = _clean((await req.json()).get("name"), dev["name"])
    cfg = st("GET", f"/config/devices/{did}")
    cfg["name"] = name
    st("PUT", f"/config/devices/{did}", cfg)
    db.run("UPDATE sync_devices SET name=? WHERE device_id=?", name, did)
    return {"ok": True}


@r.delete("/api/sync/devices/{did}")
def remove_device(did: str, req: Request, u=Depends(core.current_user)):
    dev = _mine(did, u)
    for f in st("GET", "/config/folders"):
        if any(x["deviceID"] == did for x in f["devices"]):
            f["devices"] = [x for x in f["devices"] if x["deviceID"] != did]
            if [x for x in f["devices"] if x["deviceID"] != my_id()]:
                st("PUT", f"/config/folders/{urllib.parse.quote(f['id'])}", f)
            else:   # plus personne en face : on arrête la synchro, les fichiers restent sur le NAS
                st("DELETE", f"/config/folders/{urllib.parse.quote(f['id'])}")
                db.run("DELETE FROM sync_folders WHERE folder_id=?", f["id"])
    st("DELETE", f"/config/devices/{did}")
    db.run("DELETE FROM sync_devices WHERE device_id=?", did)
    db.run("DELETE FROM sync_folders WHERE device_id=?", did)
    core.audit(req, u, "synchro.appareil.retrait", dev["name"])
    return {"ok": True}


@r.post("/api/sync/folders/{fid}/rescan")
def rescan(fid: str, u=Depends(core.current_user)):
    f = db.one("SELECT * FROM sync_folders WHERE folder_id=? AND user_id=?", fid, u["id"])
    if not f:
        raise HTTPException(404, "Dossier introuvable.")
    st("POST", "/db/scan?folder=" + urllib.parse.quote(fid))
    return {"ok": True}


def _mine(did, u):
    dev = db.one("SELECT * FROM sync_devices WHERE device_id=? AND user_id=?", did, u["id"])
    if not dev:
        raise HTTPException(404, "Appareil introuvable.")
    return dev

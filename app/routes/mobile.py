"""App Android « Arche » : association du téléphone, état de la sauvegarde, distribution de l'app et de ses mises à jour.

L'app affiche l'interface web d'Arche (WebView) et sauvegarde elle-même les photos en arrière-plan.
Pour cela elle reçoit, après connexion, un jeton propre au téléphone (empreinte SHA-256 en base, révocable)
qui n'ouvre QUE : sauvegarde des photos, envoi par morceaux, notifications, /api/me et /api/app/* (voir core.APP_PATHS).
"""
import hashlib
import json
import os
import secrets
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import FileResponse

from .. import core, db

r = APIRouter()
APK_DIR = Path("/var/lib/nas/app")
LAN_HOST = os.environ.get("ARCHE_LAN_HOST", "")  # IP locale du NAS (pour le téléphone à la maison)

db.conn().executescript("""
CREATE TABLE IF NOT EXISTS app_devices(id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  install_id TEXT NOT NULL, name TEXT NOT NULL, model TEXT, token_hash TEXT UNIQUE NOT NULL, created_at INTEGER NOT NULL,
  last_seen INTEGER, last_backup INTEGER, app_version TEXT, stats TEXT, UNIQUE(user_id, install_id));
""")


def _clean(s, n=60):
    return "".join(c for c in str(s or "") if c.isprintable()).strip()[:n]


@r.post("/api/app/pair")
async def pair(req: Request, u=Depends(core.current_user)):
    """Appelé par l'app juste après la connexion dans l'interface : crée (ou renouvelle) le jeton du téléphone."""
    if not u.get("_session"):
        raise HTTPException(403, "Connexion requise.")
    d = await req.json()
    install = _clean(d.get("install_id"), 64)
    if len(install) < 16:
        raise HTTPException(400, "Identifiant d'installation invalide.")
    name = _clean(d.get("name")) or "Téléphone"
    token = "arche_app_" + secrets.token_urlsafe(32)
    th = hashlib.sha256(token.encode()).hexdigest()
    old = db.one("SELECT id FROM app_devices WHERE user_id=? AND install_id=?", u["id"], install)
    if old:
        db.run("UPDATE app_devices SET token_hash=?, name=?, model=?, last_seen=? WHERE id=?", th, name, _clean(d.get("model")), db.now(), old["id"])
        did = old["id"]
    else:
        did = db.run("INSERT INTO app_devices(user_id,install_id,name,model,token_hash,created_at,last_seen) VALUES(?,?,?,?,?,?,?)",
                     u["id"], install, name, _clean(d.get("model")), th, db.now(), db.now())
        core.audit(req, u, "app.association", name, _clean(d.get("model")))
    return {"token": token, "device_id": did, "user": {"id": u["id"], "username": u["username"], "display_name": u["display_name"]}}


@r.get("/api/app/config")
def config(u=Depends(core.current_user)):
    pub = (db.get_setting("public_url") or "").replace("https://", "").replace("http://", "").strip("/")
    return {"user": {"id": u["id"], "username": u["username"], "display_name": u["display_name"]},
            "public_host": pub, "lan_host": LAN_HOST, "app_name": db.get_setting("app_name"), "device_id": u.get("_app_device")}


@r.post("/api/app/report")
async def report(req: Request, u=Depends(core.current_user)):
    """L'app envoie l'état de sa sauvegarde (affiché dans Synchronisation)."""
    if not u.get("_app_device"):
        raise HTTPException(403, "Réservé à l'app.")
    d = await req.json()
    keep = {k: d.get(k) for k in ("enabled", "on_phone", "backed_up", "pending", "albums", "errors", "running", "wifi_only", "charging_only", "last_error")}
    db.run("UPDATE app_devices SET stats=?, app_version=?, last_backup=COALESCE(?, last_backup), last_seen=? WHERE id=?",
           json.dumps(keep)[:20000], _clean(d.get("app_version"), 20), d.get("last_backup") if isinstance(d.get("last_backup"), int) else None,
           db.now(), u["_app_device"])
    return {"ok": True}


@r.get("/api/app/devices")
def devices(u=Depends(core.current_user)):
    out = []
    for x in db.q("SELECT * FROM app_devices WHERE user_id=? ORDER BY created_at", u["id"]):
        out.append({"id": x["id"], "name": x["name"], "model": x["model"], "created_at": x["created_at"], "last_seen": x["last_seen"],
                    "last_backup": x["last_backup"], "app_version": x["app_version"], "stats": json.loads(x["stats"] or "{}"),
                    "this": x["id"] == u.get("_app_device")})
    return out


@r.delete("/api/app/devices/{did}")
def revoke(did: int, req: Request, u=Depends(core.current_user)):
    x = db.one("SELECT * FROM app_devices WHERE id=? AND user_id=?", did, u["id"])
    if not x:
        raise HTTPException(404, "Appareil introuvable.")
    db.run("DELETE FROM app_devices WHERE id=?", did)
    core.audit(req, u, "app.revocation", x["name"])
    return {"ok": True}


# ------------------------------------------------------------------ distribution de l'app (publique : rien de secret dedans)
def _meta():
    try:
        return json.loads((APK_DIR / "android.json").read_text())
    except (OSError, ValueError):
        return None


@r.get("/api/app/android")
def android_meta():
    m = _meta()
    if not m:
        raise HTTPException(404, "L'app Android n'est pas encore disponible.")
    return {**m, "url": "/api/app/android.apk"}


@r.get("/api/app/android/qr")
def android_qr(req: Request):
    """QR code à scanner avec le téléphone pour télécharger l'app depuis un ordinateur."""
    import io
    import qrcode
    import qrcode.image.svg
    pub = db.get_setting("public_url") or str(req.base_url).rstrip("/")
    buf = io.BytesIO()
    qrcode.make(pub.rstrip("/") + "/api/app/android.apk", image_factory=qrcode.image.svg.SvgPathImage, box_size=8, border=2).save(buf)
    from fastapi.responses import Response
    return Response(buf.getvalue(), media_type="image/svg+xml", headers={"Cache-Control": "max-age=3600"})


@r.get("/api/app/android.apk")
def android_apk():
    m = _meta()
    f = APK_DIR / "arche.apk"
    if not m or not f.exists():
        raise HTTPException(404, "L'app Android n'est pas encore disponible.")
    return FileResponse(f, media_type="application/vnd.android.package-archive", filename=f"Arche-{m['version_name']}.apk",
                        headers={"Cache-Control": "no-cache"})

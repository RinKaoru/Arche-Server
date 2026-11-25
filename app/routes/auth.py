"""Connexion, profil, 2FA, sessions, notifications."""
import hashlib
import io
import json
from urllib.parse import quote

import qrcode
import qrcode.image.svg
from fastapi import APIRouter, Depends, HTTPException, Request, Response

from .. import core, db, push

r = APIRouter()


@r.post("/api/auth/login")
async def login(req: Request, resp: Response):
    if req.headers.get("x-nas") != "1":
        raise HTTPException(403, "Requête refusée.")
    data = await req.json()
    username = str(data.get("username", "")).strip().lower()
    ip = core.client_ip(req)
    core.rate_check(f"ip:{ip}", limit=15)
    core.rate_check(f"user:{username}")
    u = db.one("SELECT * FROM users WHERE username=? AND disabled=0", username)
    if not u or not core.check_pw(u["pw_hash"], str(data.get("password", ""))):
        core.rate_fail(f"ip:{ip}"); core.rate_fail(f"user:{username}")
        core.audit(req, None, "login.echec", username)
        raise HTTPException(401, "Identifiant ou mot de passe incorrect.")
    if u["totp_enabled"]:
        code = str(data.get("totp", ""))
        if not code:
            return {"need_totp": True}
        if not core.totp_verify(u, code):
            core.rate_fail(f"user:{username}")
            raise HTTPException(401, "Code de double authentification incorrect.")
    if not core.is_internal(req) and not db.one("SELECT 1 FROM audit WHERE action='login' AND user_id=? AND ip=? LIMIT 1", u["id"], ip):
        core.notify([u["id"]], "Nouvelle connexion à ton compte", f"Depuis l'adresse {ip} ({req.headers.get('user-agent', '')[:60]}). "
                    "Si ce n'est pas toi, change ton mot de passe et déconnecte cet appareil dans Mon compte.", "warning", "/compte")
    token = core.create_session(req, u["id"])
    resp.set_cookie(core.SESSION_COOKIE, token, max_age=core.SESSION_DAYS * 86400, httponly=True,
                    samesite="lax", secure=core.is_https(req), path="/")
    core.audit(req, u, "login")
    return {"ok": True, "user": core.public_user(u)}


@r.post("/api/auth/logout")
def logout(resp: Response, u=Depends(core.current_user)):
    db.run("DELETE FROM sessions WHERE token_hash=?", u["_session"])
    resp.delete_cookie(core.SESSION_COOKIE, path="/")
    return {"ok": True}


@r.get("/api/me")
def me(req: Request):
    u = core.session_user(req)
    if not u:
        raise HTTPException(401, "Non connecté.")
    out = core.public_user(u)
    out["admin_space"] = core.has_admin_space(u)
    out["require_2fa_admin"] = bool(db.get_setting("require_2fa_admin"))
    out["app_name"] = db.get_setting("app_name")
    out["internal"] = core.is_internal(req)
    out["need_2fa_setup"] = not out["internal"] and not u["totp_enabled"]
    out["public_url"] = db.get_setting("public_url") or ""
    out["unread"] = db.one("SELECT COUNT(*) n FROM notifications WHERE user_id=? AND read=0", u["id"])["n"]
    out["active_alerts"] = db.one("SELECT COUNT(*) n FROM alerts WHERE active=1")["n"] if out["perms"]["viewMonitoring"] else 0
    out["groups"] = [g["name"] for g in db.q(
        "SELECT g.name FROM groups g JOIN group_members m ON m.group_id=g.id WHERE m.user_id=?", u["id"])]
    try:
        out["https"] = json.load(open("/var/lib/nas/https.json")).get("https", False)
    except OSError:
        out["https"] = False
    return out


@r.post("/api/me/password")
async def change_password(req: Request, u=Depends(core.current_user)):
    data = await req.json()
    if not core.check_pw(u["pw_hash"], str(data.get("current", ""))):
        core.rate_fail(f"user:{u['username']}")
        raise HTTPException(400, "Mot de passe actuel incorrect.")
    new = str(data.get("new", ""))
    core.validate_pw(new)
    if new == data.get("current"):
        raise HTTPException(400, "Choisis un mot de passe différent de l'actuel.")
    core.helper("user-passwd", u["username"], stdin=new + "\n")
    db.run("UPDATE users SET pw_hash=?, must_change=0 WHERE id=?", core.hash_pw(new), u["id"])
    db.run("DELETE FROM sessions WHERE user_id=? AND token_hash<>?", u["id"], u["_session"])
    core.audit(req, u, "mot_de_passe.change")
    return {"ok": True}


@r.post("/api/me/prefs")
async def prefs(req: Request, u=Depends(core.current_user)):
    data = await req.json()
    p = json.loads(u["prefs"] or "{}")
    for k in ("seen_help", "notify_levels", "photo_dest", "onboarded", "view", "sort", "details"):
        if k in data:
            p[k] = data[k]
    db.run("UPDATE users SET prefs=? WHERE id=?", json.dumps(p), u["id"])
    return {"ok": True, "prefs": p}


# ------------------------------------------------------------------ 2FA
@r.post("/api/me/2fa/setup")
def totp_setup(u=Depends(core.current_user)):
    """Prépare un nouvel appareil : le secret reste « en attente » jusqu'à la saisie d'un code valide."""
    secret = core.totp_new_secret()
    db.run("UPDATE users SET totp_secret=? WHERE id=?", secret, u["id"])
    app = db.get_setting("app_name")
    n = db.one("SELECT COUNT(*) n FROM totp_devices WHERE user_id=?", u["id"])["n"]
    label = u["username"] + (f" ({n + 1})" if n else "")
    uri = f"otpauth://totp/{quote(app)}:{quote(label)}?secret={secret}&issuer={quote(app)}"
    img = qrcode.make(uri, image_factory=qrcode.image.svg.SvgPathImage, box_size=8, border=2)
    buf = io.BytesIO(); img.save(buf)
    return {"secret": secret, "uri": uri, "svg": buf.getvalue().decode()}


@r.post("/api/me/2fa/enable")
async def totp_enable(req: Request, u=Depends(core.current_user)):
    data = await req.json()
    name = str(data.get("name") or "").strip()[:40] or "Appareil"
    if not u["totp_secret"] or not core.totp_check(u["totp_secret"], str(data.get("code", "")), f"new:{u['id']}"):
        raise HTTPException(400, "Code incorrect. Vérifie l'heure de l'appareil et réessaie.")
    first = not u["totp_enabled"]
    db.run("INSERT INTO totp_devices(user_id,name,secret,created_at) VALUES(?,?,?,?)", u["id"], name, u["totp_secret"], db.now())
    db.run("UPDATE users SET totp_secret=NULL WHERE id=?", u["id"])
    core.sync_totp_flag(u["id"])
    core.audit(req, u, "2fa.activee" if first else "2fa.appareil_ajoute", name)
    if not first:
        core.notify([u["id"]], "Nouvel appareil de double authentification", f"« {name} » a été ajouté à ton compte. "
                    "Si ce n'est pas toi, retire-le dans Mon compte et change ton mot de passe.", "warning", "/compte")
    return {"ok": True}


@r.get("/api/me/2fa/devices")
def totp_devices(u=Depends(core.current_user)):
    return db.q("SELECT id, name, created_at, last_used FROM totp_devices WHERE user_id=? ORDER BY id", u["id"])


@r.post("/api/me/2fa/devices/{did}/delete")
async def totp_device_delete(did: int, req: Request, u=Depends(core.current_user)):
    data = await req.json()
    if not core.check_pw(u["pw_hash"], str(data.get("password", ""))):
        core.rate_fail(f"user:{u['username']}")
        raise HTTPException(400, "Mot de passe incorrect.")
    d = db.one("SELECT * FROM totp_devices WHERE id=? AND user_id=?", did, u["id"])
    if not d:
        raise HTTPException(404, "Appareil introuvable.")
    db.run("DELETE FROM totp_devices WHERE id=?", did)
    core.sync_totp_flag(u["id"])
    core.audit(req, u, "2fa.appareil_retire", d["name"])
    return {"ok": True, "remaining": db.one("SELECT COUNT(*) n FROM totp_devices WHERE user_id=?", u["id"])["n"]}


@r.patch("/api/me/2fa/devices/{did}")
async def totp_device_rename(did: int, req: Request, u=Depends(core.current_user)):
    name = str((await req.json()).get("name") or "").strip()[:40]
    if not name:
        raise HTTPException(400, "Nom requis.")
    db.run("UPDATE totp_devices SET name=? WHERE id=? AND user_id=?", name, did, u["id"])
    return {"ok": True}


# ------------------------------------------------------------------ sessions
@r.get("/api/me/sessions")
def sessions(u=Depends(core.current_user)):
    rows = db.q("SELECT token_hash, created, last_seen, ip, ua FROM sessions WHERE user_id=? AND expires>? "
                "ORDER BY last_seen DESC", u["id"], db.now())
    for s in rows:
        s["current"] = s["token_hash"] == u["_session"]
        s["id"] = s.pop("token_hash")[:16]
    return rows


@r.delete("/api/me/sessions/{sid}")
def revoke_session(sid: str, u=Depends(core.current_user)):
    db.run("DELETE FROM sessions WHERE user_id=? AND substr(token_hash,1,16)=? AND token_hash<>?",
           u["id"], sid, u["_session"])
    return {"ok": True}


# ------------------------------------------------------------------ notifications
@r.get("/api/notifications")
def notifications(u=Depends(core.current_user)):
    return db.q("SELECT * FROM notifications WHERE user_id=? ORDER BY id DESC LIMIT 100", u["id"])


@r.post("/api/notifications/read")
async def notif_read(req: Request, u=Depends(core.current_user)):
    data = await req.json()
    if data.get("all"):
        db.run("UPDATE notifications SET read=1 WHERE user_id=?", u["id"])
    else:
        db.run("UPDATE notifications SET read=1 WHERE user_id=? AND id=?", u["id"], int(data.get("id", 0)))
    return {"ok": True}


@r.delete("/api/notifications")
def notif_clear(u=Depends(core.current_user)):
    db.run("DELETE FROM notifications WHERE user_id=? AND read=1", u["id"])
    return {"ok": True}


@r.get("/api/push/key")
def push_key(u=Depends(core.current_user)):
    return {"key": push.public_key()}


@r.post("/api/push/subscribe")
async def push_sub(req: Request, u=Depends(core.current_user)):
    s = await req.json()
    ep, keys = s.get("endpoint", ""), s.get("keys", {})
    if not ep.startswith("https://") or not keys.get("p256dh") or not keys.get("auth"):
        raise HTTPException(400, "Abonnement invalide.")
    db.run("INSERT INTO push_subs(user_id,endpoint,p256dh,auth,created_at) VALUES(?,?,?,?,?) "
           "ON CONFLICT(endpoint) DO UPDATE SET user_id=excluded.user_id, p256dh=excluded.p256dh, auth=excluded.auth",
           u["id"], ep, keys["p256dh"], keys["auth"], db.now())
    return {"ok": True}


@r.post("/api/push/test")
def push_test(u=Depends(core.current_user)):
    core.notify([u["id"]], "Test de notification", "Si tu lis ceci sur ton téléphone, tout fonctionne 🎉", "success", "/notifications")
    return {"ok": True}


@r.post("/api/usage")
async def usage(req: Request, u=Depends(core.current_user)):
    page = str((await req.json()).get("page", ""))[:60]
    if page:
        db.run("INSERT INTO usage(user_id,page,last_used) VALUES(?,?,?) ON CONFLICT(user_id,page) "
               "DO UPDATE SET last_used=excluded.last_used", u["id"], page, db.now())
    return {"ok": True}

"""Administration : comptes, groupes, dossiers partagés, supervision, sauvegardes, Docker, audit, réglages."""
import hashlib
import ipaddress
import json
import secrets
import os
import re
import threading

from fastapi import APIRouter, Depends, HTTPException, Request

from .. import core, db, jobs

r = APIRouter()
USERNAME_RE = re.compile(r"^[a-z][a-z0-9_-]{1,31}$")
SHARE_NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9 _-]{0,40}$")
PATH_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9 _./-]{0,200}$")


# ================================================================== comptes
def _user_out(u):
    out = core.public_user(u)
    out["groups"] = [g["group_id"] for g in db.q("SELECT group_id FROM group_members WHERE user_id=?", u["id"])]
    return out


@r.get("/api/admin/users")
def users(u=Depends(core.require_perm("manageUsers"))):
    return [_user_out(x) for x in db.q("SELECT * FROM users ORDER BY role='admin' DESC, display_name")]


def _set_groups(uid, groups):
    db.run("DELETE FROM group_members WHERE user_id=?", uid)
    for g in groups or []:
        db.run("INSERT OR IGNORE INTO group_members(group_id,user_id) VALUES(?,?)", int(g), uid)


def _clean_perms(d):
    return json.dumps({k: bool((d or {}).get(k)) for k in core.PERMISSIONS})


def create_user(username, display_name, role="membre", perms=None, smb=True, groups=(), password=None, must_change=True):
    if not USERNAME_RE.match(username):
        raise HTTPException(400, "Identifiant invalide : minuscules, chiffres, - et _ (2 à 32 caractères).")
    if db.one("SELECT 1 FROM users WHERE username=?", username):
        raise HTTPException(409, "Cet identifiant existe déjà.")
    if role not in core.ROLES:
        raise HTTPException(400, "Rôle invalide.")
    pw = password or core.gen_password()
    core.helper("user-add", username, stdin=pw + "\n")
    if not smb:
        core.helper("user-smb", username, "off")
    uid = db.run("INSERT INTO users(username,display_name,role,perms,pw_hash,must_change,smb_enabled,created_at) "
                 "VALUES(?,?,?,?,?,?,?,?)", username, display_name or username, role, _clean_perms(perms),
                 core.hash_pw(pw), 1 if must_change else 0, 1 if smb else 0, db.now())
    _set_groups(uid, groups)
    # espace personnel
    path = f"users/{username}"
    if not db.one("SELECT 1 FROM shares WHERE path=?", path):
        db.run("INSERT INTO shares(name,path,description,kind,owner_id,smb,photos,icon,created_at) VALUES(?,?,?,?,?,?,?,?,?)",
               f"perso-{username}", path, f"Espace personnel de {display_name or username}", "personal", uid, 1, 1,
               "user", db.now())
    else:
        db.run("UPDATE shares SET owner_id=? WHERE path=?", uid, path)
    core.helper("fix-perms", path)
    core.sync_samba()
    (core.STORAGE / path / "Photos").mkdir(exist_ok=True)
    return uid, pw


@r.post("/api/admin/users")
async def user_create(req: Request, u=Depends(core.require_perm("manageUsers"))):
    d = await req.json()
    role = d.get("role", "membre")
    if role == "admin" and u["role"] != "admin":
        raise HTTPException(403, "Seul un administrateur peut créer un administrateur.")
    pw = d.get("password") or None
    if pw:
        core.validate_pw(pw)
    uid, pw = create_user(str(d.get("username", "")).strip().lower(), str(d.get("display_name", "")).strip()[:60],
                          role, d.get("perms"), bool(d.get("smb_enabled", True)), d.get("groups"), pw)
    core.audit(req, u, "compte.cree", d.get("username"), f"rôle {role}")
    return {"id": uid, "password": pw}


def _target(u, uid):
    t = db.one("SELECT * FROM users WHERE id=?", uid)
    if not t:
        raise HTTPException(404, "Compte introuvable.")
    if t["role"] == "admin" and u["role"] != "admin":
        raise HTTPException(403, "Seul un administrateur peut modifier un administrateur.")
    return t


@r.put("/api/admin/users/{uid}")
async def user_update(uid: int, req: Request, u=Depends(core.require_perm("manageUsers"))):
    t = _target(u, uid)
    d = await req.json()
    if "role" in d:
        if d["role"] not in core.ROLES or (d["role"] == "admin" and u["role"] != "admin"):
            raise HTTPException(400, "Rôle invalide.")
        if t["id"] == u["id"] and d["role"] != "admin" and t["role"] == "admin":
            raise HTTPException(400, "Tu ne peux pas retirer ton propre rôle d'administrateur.")
        db.run("UPDATE users SET role=? WHERE id=?", d["role"], uid)
    if "display_name" in d:
        db.run("UPDATE users SET display_name=? WHERE id=?", str(d["display_name"]).strip()[:60] or t["username"], uid)
    if "perms" in d:
        db.run("UPDATE users SET perms=? WHERE id=?", _clean_perms(d["perms"]), uid)
    if "smb_enabled" in d:
        core.helper("user-smb", t["username"], "on" if d["smb_enabled"] else "off")
        db.run("UPDATE users SET smb_enabled=? WHERE id=?", 1 if d["smb_enabled"] else 0, uid)
    if "disabled" in d:
        if uid == u["id"]:
            raise HTTPException(400, "Tu ne peux pas désactiver ton propre compte.")
        db.run("UPDATE users SET disabled=? WHERE id=?", 1 if d["disabled"] else 0, uid)
        core.helper("user-smb", t["username"], "off" if d["disabled"] else ("on" if t["smb_enabled"] else "off"))
        if d["disabled"]:
            db.run("DELETE FROM sessions WHERE user_id=?", uid)
    if "groups" in d:
        _set_groups(uid, d["groups"])
    core.sync_samba()
    core.audit(req, u, "compte.modifie", t["username"], json.dumps({k: v for k, v in d.items()}, ensure_ascii=False))
    return {"ok": True}


def rename_user(uid: int, new: str):
    t = db.one("SELECT * FROM users WHERE id=?", uid)
    new = (new or "").strip().lower()
    if not USERNAME_RE.match(new):
        raise HTTPException(400, "Identifiant invalide : minuscules, chiffres, - et _ (2 à 32 caractères).")
    if new == t["username"]:
        return t["username"]
    if db.one("SELECT 1 FROM users WHERE username=?", new) or db.one("SELECT 1 FROM shares WHERE path=? OR name=?", f"users/{new}", f"perso-{new}"):
        raise HTTPException(409, "Cet identifiant est déjà utilisé.")
    old = t["username"]
    core.helper("user-rename", old, new)
    db.run("UPDATE users SET username=? WHERE id=?", new, uid)
    db.run("UPDATE shares SET path=?, name=? WHERE path=?", f"users/{new}", f"perso-{new}", f"users/{old}")
    core.sync_samba()
    return old


@r.post("/api/admin/users/{uid}/rename")
async def user_rename(uid: int, req: Request, u=Depends(core.require_perm("manageUsers"))):
    t = _target(u, uid)
    new = str((await req.json()).get("username", ""))
    old = rename_user(uid, new)
    core.audit(req, u, "compte.renomme", f"{old} → {new.strip().lower()}")
    if t["id"] != u["id"]:
        core.notify([t["id"]], "Ton identifiant a changé", f"Connecte-toi désormais avec « {new.strip().lower()} ». Ton mot de passe ne change pas.", "warning", "/compte")
    return {"ok": True}


@r.post("/api/admin/users/{uid}/reset-password")
def user_reset_pw(uid: int, req: Request, u=Depends(core.require_perm("manageUsers"))):
    t = _target(u, uid)
    pw = core.gen_password()
    core.helper("user-passwd", t["username"], stdin=pw + "\n")
    db.run("UPDATE users SET pw_hash=?, must_change=1 WHERE id=?", core.hash_pw(pw), uid)
    db.run("DELETE FROM sessions WHERE user_id=?", uid)
    core.audit(req, u, "compte.mot_de_passe_reinitialise", t["username"])
    return {"password": pw}


@r.post("/api/admin/users/{uid}/reset-2fa")
def user_reset_2fa(uid: int, req: Request, u=Depends(core.require_perm("manageUsers"))):
    t = _target(u, uid)
    db.run("DELETE FROM totp_devices WHERE user_id=?", uid)
    db.run("UPDATE users SET totp_enabled=0, totp_secret=NULL WHERE id=?", uid)
    core.audit(req, u, "compte.2fa_reinitialisee", t["username"])
    return {"ok": True}


@r.delete("/api/admin/users/{uid}")
def user_delete(uid: int, req: Request, u=Depends(core.require_perm("manageUsers"))):
    t = _target(u, uid)
    if uid == u["id"]:
        raise HTTPException(400, "Tu ne peux pas supprimer ton propre compte.")
    core.helper("user-del", t["username"])
    # Les fichiers sont conservés : l'espace perso devient un dossier réservé aux admins
    db.run("UPDATE shares SET kind='standard', owner_id=NULL, name=?, description=? WHERE kind='personal' AND owner_id=?",
           f"archive-{t['username']}", f"Archive de l'espace de {t['display_name']} (compte supprimé)", uid)
    db.run("DELETE FROM users WHERE id=?", uid)
    core.sync_samba()
    core.audit(req, u, "compte.supprime", t["username"])
    return {"ok": True}


# ================================================================== groupes
@r.get("/api/groups")
def groups(u=Depends(core.current_user)):
    gs = db.q("SELECT * FROM groups ORDER BY name")
    for g in gs:
        g["members"] = [m["user_id"] for m in db.q("SELECT user_id FROM group_members WHERE group_id=?", g["id"])]
    return gs


@r.post("/api/admin/groups")
async def group_create(req: Request, u=Depends(core.require_perm("manageUsers"))):
    d = await req.json()
    name = str(d.get("name", "")).strip()[:40]
    if not name:
        raise HTTPException(400, "Nom requis.")
    gid = db.run("INSERT INTO groups(name,description) VALUES(?,?)", name, str(d.get("description", ""))[:200])
    for m in d.get("members", []):
        db.run("INSERT OR IGNORE INTO group_members(group_id,user_id) VALUES(?,?)", gid, int(m))
    core.sync_samba()
    core.audit(req, u, "groupe.cree", name)
    return {"id": gid}


@r.put("/api/admin/groups/{gid}")
async def group_update(gid: int, req: Request, u=Depends(core.require_perm("manageUsers"))):
    d = await req.json()
    if "name" in d:
        db.run("UPDATE groups SET name=?, description=? WHERE id=?", str(d["name"]).strip()[:40],
               str(d.get("description", ""))[:200], gid)
    if "members" in d:
        db.run("DELETE FROM group_members WHERE group_id=?", gid)
        for m in d["members"]:
            db.run("INSERT OR IGNORE INTO group_members(group_id,user_id) VALUES(?,?)", gid, int(m))
    core.sync_samba()
    core.audit(req, u, "groupe.modifie", str(gid))
    return {"ok": True}


@r.delete("/api/admin/groups/{gid}")
def group_delete(gid: int, req: Request, u=Depends(core.require_perm("manageUsers"))):
    db.run("DELETE FROM share_perms WHERE subject_type='group' AND subject_id=?", gid)
    db.run("DELETE FROM groups WHERE id=?", gid)
    core.sync_samba()
    core.audit(req, u, "groupe.supprime", str(gid))
    return {"ok": True}


# ================================================================== dossiers partagés
def _share_out(s):
    s = dict(s)
    s["perms"] = db.q("SELECT subject_type, subject_id, level FROM share_perms WHERE share_id=?", s["id"])
    o = db.one("SELECT display_name FROM users WHERE id=?", s["owner_id"]) if s["owner_id"] else None
    s["owner_name"] = o["display_name"] if o else None
    return s


@r.get("/api/manage/shares")
def manage_shares(u=Depends(core.current_user)):
    return [_share_out(s) | {"can_manage": core.can_manage_share(u, s)}
            for s in db.q("SELECT * FROM shares ORDER BY kind, name")
            if core.can_manage_share(u, s) or core.share_level(u, s) != "none"]


def _apply_perms(sid, perms):
    db.run("DELETE FROM share_perms WHERE share_id=?", sid)
    for p in perms or []:
        if p.get("subject_type") in ("user", "group") and p.get("level") in ("read", "write"):
            db.run("INSERT OR REPLACE INTO share_perms(share_id,subject_type,subject_id,level) VALUES(?,?,?,?)",
                   sid, p["subject_type"], int(p["subject_id"]), p["level"])


@r.post("/api/manage/shares")
async def share_create(req: Request, u=Depends(core.require_member)):
    d = await req.json()
    name = str(d.get("name", "")).strip()
    if not SHARE_NAME_RE.match(name):
        raise HTTPException(400, "Nom invalide : lettres, chiffres, espaces, - et _ (41 caractères max).")
    if db.one("SELECT 1 FROM shares WHERE lower(name)=lower(?)", name):
        raise HTTPException(409, "Un dossier partagé porte déjà ce nom.")
    power = core.user_perms(u).get("manageShares")
    if power and d.get("path"):
        path = str(d["path"]).strip().strip("/")
    else:
        path = "partages/" + re.sub(r"[^A-Za-z0-9_-]+", "-", name).strip("-").lower()
    if not PATH_RE.match(path) or ".." in path.split("/") or path.split("/")[0].startswith("."):
        raise HTTPException(400, "Chemin invalide.")
    if db.one("SELECT 1 FROM shares WHERE path=?", path):
        raise HTTPException(409, "Ce dossier est déjà partagé.")
    kind = "timemachine" if (d.get("kind") == "timemachine" and power) else "standard"
    sid = db.run("INSERT INTO shares(name,path,description,kind,owner_id,smb,photos,tm_size_gb,icon,created_at) "
                 "VALUES(?,?,?,?,?,?,?,?,?,?)", name, path, str(d.get("description", ""))[:200], kind, u["id"],
                 1 if d.get("smb", True) else 0, 1 if d.get("photos") else 0, int(d.get("tm_size_gb") or 1000),
                 str(d.get("icon") or "folder")[:30], db.now())
    _apply_perms(sid, d.get("perms"))
    core.helper("fix-perms", path)
    core.sync_samba()
    core.audit(req, u, "partage.cree", name, path)
    return {"id": sid}


@r.put("/api/manage/shares/{sid}")
async def share_update(sid: int, req: Request, u=Depends(core.current_user)):
    s = core.get_share(sid)
    if not core.can_manage_share(u, s):
        raise HTTPException(403, "Tu ne peux pas modifier ce dossier partagé.")
    d = await req.json()
    if "name" in d and d["name"] != s["name"]:
        if not SHARE_NAME_RE.match(d["name"]) or db.one("SELECT 1 FROM shares WHERE lower(name)=lower(?) AND id<>?", d["name"], sid):
            raise HTTPException(400, "Nom invalide ou déjà utilisé.")
        db.run("UPDATE shares SET name=? WHERE id=?", d["name"], sid)
    for k in ("description", "icon"):
        if k in d:
            db.run(f"UPDATE shares SET {k}=? WHERE id=?", str(d[k])[:200], sid)
    for k in ("smb", "photos"):
        if k in d:
            db.run(f"UPDATE shares SET {k}=? WHERE id=?", 1 if d[k] else 0, sid)
    if "tm_size_gb" in d:
        db.run("UPDATE shares SET tm_size_gb=? WHERE id=?", max(50, int(d["tm_size_gb"])), sid)
    if "owner_id" in d and u["role"] == "admin" and s["kind"] != "personal":
        db.run("UPDATE shares SET owner_id=? WHERE id=?", d["owner_id"], sid)
    if "perms" in d:
        _apply_perms(sid, d["perms"])
    core.sync_samba()
    if d.get("photos"):
        threading.Thread(target=jobs.index_photos, daemon=True).start()
    core.audit(req, u, "partage.modifie", s["name"], json.dumps(d, ensure_ascii=False)[:900])
    return {"ok": True}


@r.delete("/api/manage/shares/{sid}")
def share_delete(sid: int, req: Request, u=Depends(core.current_user)):
    s = core.get_share(sid)
    if not core.can_manage_share(u, s) or s["kind"] == "personal":
        raise HTTPException(403, "Impossible de retirer ce partage.")
    db.run("DELETE FROM shares WHERE id=?", sid)
    core.sync_samba()
    core.audit(req, u, "partage.retire", s["name"], "fichiers conservés dans " + s["path"])
    return {"ok": True, "kept_path": s["path"]}


# ================================================================== supervision
@r.get("/api/admin/overview")
def overview(u=Depends(core.require_perm("viewMonitoring"))):
    st = jobs.STATE.copy()
    st["alerts"] = db.q("SELECT * FROM alerts ORDER BY active DESC, updated DESC LIMIT 50")
    st["snapshot"] = jobs.snapshot_state()
    return st


@r.post("/api/admin/refresh")
def refresh(u=Depends(core.require_perm("viewMonitoring"))):
    jobs.collect(smart=True)
    return {"ok": True}


# ================================================================== sauvegardes
def _admin_internal(req, u):
    if u["role"] != "admin" or not core.is_internal(req):
        raise HTTPException(403, "Réservé aux administrateurs, depuis la maison.")


@r.post("/api/admin/discord-test")
def discord_test(req: Request, u=Depends(core.current_user)):
    _admin_internal(req, u)
    if not db.get_setting("discord_webhook"):
        raise HTTPException(400, "Aucun webhook Discord enregistré.")
    core.discord("Test de notification", f"Envoyé depuis Arche par {u['display_name'] or u['username']}.", "info")
    return {"ok": True}


@r.get("/api/admin/snapshots")
def snapshots(u=Depends(core.require_perm("manageBackups"))):
    dates = sorted([d for d in os.listdir(core.SNAPSHOTS) if len(d) == 10], reverse=True) if core.SNAPSHOTS.exists() else []
    return {"dates": dates, "state": jobs.snapshot_state(), "excluded": ["medias", "backups/timemachine", "corbeilles"],
            "system": jobs.sysbackup_state()}


@r.post("/api/admin/snapshots/run")
def snapshot_run(req: Request, u=Depends(core.require_perm("manageBackups"))):
    core.helper("snapshot")
    core.audit(req, u, "snapshot.lance")
    return {"ok": True}


@r.get("/api/admin/github")
def github(u=Depends(core.require_perm("manageBackups"))):
    cfg = db.get_setting("github") or {}
    return {"owners": cfg.get("owners", []), "enabled": cfg.get("enabled", False), "has_token": bool(cfg.get("token")),
            "repos": db.q("SELECT * FROM github_repos ORDER BY full_name"), "running": jobs.GITHUB_RUNNING.is_set()}


@r.put("/api/admin/github")
async def github_set(req: Request, u=Depends(core.require_perm("manageBackups"))):
    d = await req.json()
    cfg = db.get_setting("github") or {}
    if "token" in d and d["token"] != "":
        cfg["token"] = str(d["token"]).strip()
    if d.get("clear_token"):
        cfg["token"] = ""
    if "owners" in d:
        cfg["owners"] = [o.strip() for o in d["owners"] if re.match(r"^[A-Za-z0-9-]{1,39}$", o.strip())]
    if "enabled" in d:
        cfg["enabled"] = bool(d["enabled"])
    db.set_setting("github", cfg)
    core.audit(req, u, "github.config", ",".join(cfg.get("owners", [])))
    return {"ok": True}


@r.post("/api/admin/github/sync")
def github_sync(req: Request, u=Depends(core.require_perm("manageBackups"))):
    if not jobs.GITHUB_RUNNING.is_set():
        threading.Thread(target=jobs.github_backup, daemon=True).start()
    core.audit(req, u, "github.sync")
    return {"ok": True}


# ================================================================== docker
@r.get("/api/admin/docker")
def docker_ps(u=Depends(core.require_perm("manageDocker"))):
    out = core.helper("docker", "ps", raw=True)
    try:
        return json.loads(out or "[]")
    except json.JSONDecodeError:
        return []


@r.post("/api/admin/docker/{cid}/{action}")
def docker_action(cid: str, action: str, req: Request, u=Depends(core.require_perm("manageDocker"))):
    if action not in ("start", "stop", "restart"):
        raise HTTPException(400, "Action inconnue.")
    core.helper("docker", action, cid)
    core.audit(req, u, f"docker.{action}", cid)
    return {"ok": True}


@r.get("/api/admin/docker/{cid}/logs")
def docker_logs(cid: str, u=Depends(core.require_perm("manageDocker"))):
    return {"logs": core.helper("docker", "logs", cid, raw=True)}


# ================================================================== audit & réglages
@r.get("/api/admin/audit")
def audit_log(q: str = "", before: int = 0, u=Depends(core.require_perm("viewLogs"))):
    sql = "SELECT * FROM audit WHERE id < ?"
    args = [before or 2**62]
    if q:
        sql += " AND (username LIKE ? OR action LIKE ? OR target LIKE ? OR detail LIKE ?)"
        args += [f"%{q}%"] * 4
    return db.q(sql + " ORDER BY id DESC LIMIT 200", *args)


@r.get("/api/admin/settings")
def settings(u=Depends(core.require_perm("manageUsers"))):
    return {"app_name": db.get_setting("app_name"), "require_2fa_admin": db.get_setting("require_2fa_admin"),
            "public_url": db.get_setting("public_url") or "",
            "discord_webhook": bool(db.get_setting("discord_webhook")),
            "permissions": core.PERMISSIONS, "roles": core.ROLES}


@r.put("/api/admin/settings")
async def settings_set(req: Request, u=Depends(core.current_user)):
    if u["role"] != "admin" or not core.is_internal(req):
        raise HTTPException(403, "Réservé aux administrateurs.")
    d = await req.json()
    if "app_name" in d:
        db.set_setting("app_name", str(d["app_name"]).strip()[:30] or "Arche")
    if "require_2fa_admin" in d:
        db.set_setting("require_2fa_admin", bool(d["require_2fa_admin"]))
    if "public_url" in d:
        url = str(d["public_url"]).strip().rstrip("/")
        if url and not url.startswith("https://"):
            raise HTTPException(400, "L'adresse publique doit commencer par https://")
        db.set_setting("public_url", url)
    if "discord_webhook" in d:
        url = str(d["discord_webhook"] or "").strip()
        if url and not re.match(r"^https://(discord|discordapp)\.com/api/webhooks/\d+/[\w-]+$", url):
            raise HTTPException(400, "Ce n'est pas une adresse de webhook Discord valide.")
        db.set_setting("discord_webhook", url)
        d["discord_webhook"] = "défini" if url else "retiré"
    core.audit(req, u, "reglages.modifies", "", json.dumps(d, ensure_ascii=False))
    return {"ok": True}

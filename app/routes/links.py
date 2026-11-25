"""Liens de partage (accessibles depuis le réseau local et le VPN)."""
import hashlib
import hmac
import os
import secrets
from pathlib import Path
from urllib.parse import quote

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from fastapi.responses import FileResponse

from .. import core, db, media

r = APIRouter()


@r.post("/api/links")
async def create(req: Request, u=Depends(core.current_user)):
    d = await req.json()
    s, _ = core.access(u, d["share"], "read")
    p = core.safe_path(s, d.get("path", ""))
    days = int(d.get("expires_days") or 0)
    pw = str(d.get("password") or "")
    token = secrets.token_urlsafe(12)
    lid = db.run("INSERT INTO links(token,share_id,relpath,created_by,created_at,expires_at,pw_hash) VALUES(?,?,?,?,?,?,?)",
                 token, s["id"], str(p.relative_to(core.share_root(s).resolve())), u["id"], db.now(),
                 db.now() + days * 86400 if days > 0 else None, core.hash_pw(pw) if pw else None)
    core.audit(req, u, "lien.cree", s["name"], d.get("path", ""))
    return {"id": lid, "token": token, "url": f"/s/{token}"}


@r.get("/api/links")
def mine(u=Depends(core.current_user)):
    sql = ("SELECT l.*, s.name share_name, us.display_name author FROM links l JOIN shares s ON s.id=l.share_id "
           "LEFT JOIN users us ON us.id=l.created_by WHERE l.kind='share'")
    rows = db.q(sql + " ORDER BY l.id DESC") if u["role"] == "admin" else \
        db.q(sql + " AND l.created_by=? ORDER BY l.id DESC", u["id"])
    for x in rows:
        x["has_password"] = bool(x.pop("pw_hash"))
        x["expired"] = bool(x["expires_at"] and x["expires_at"] < db.now())
    return rows


@r.delete("/api/links/{lid}")
def revoke(lid: int, req: Request, u=Depends(core.current_user)):
    l = db.one("SELECT * FROM links WHERE id=?", lid)
    if not l or (l["created_by"] != u["id"] and u["role"] != "admin"):
        raise HTTPException(404, "Lien introuvable.")
    db.run("DELETE FROM links WHERE id=?", lid)
    core.audit(req, u, "lien.supprime", str(lid))
    return {"ok": True}


# ------------------------------------------------------------------ accès public
def _cookie_name(token):
    return "nas_link_" + hashlib.sha256(token.encode()).hexdigest()[:12]


def _sig(token, l):
    key = (l["pw_hash"] or "").encode()
    return hmac.new(key, token.encode(), hashlib.sha256).hexdigest()


def _link(req: Request, token: str):
    l = db.one("SELECT * FROM links WHERE token=?", token)
    if not l or (l["expires_at"] and l["expires_at"] < db.now()):
        raise HTTPException(404, "Ce lien n'existe pas ou a expiré.")
    if l["pw_hash"] and not hmac.compare_digest(req.cookies.get(_cookie_name(token), ""), _sig(token, l)):
        raise HTTPException(401, "password_required")
    s = core.get_share(l["share_id"])
    base = core.safe_path(s, l["relpath"])
    return l, s, base


def _sub(base: Path, rel: str) -> Path:
    if not rel:
        return base
    p = (base / rel).resolve()
    if p != base and base not in p.parents:
        raise HTTPException(400, "Chemin invalide.")
    if not p.exists():
        raise HTTPException(404, "Introuvable.")
    return p


@r.post("/api/public/{token}/auth")
async def pub_auth(token: str, req: Request, resp: Response):
    core.rate_check(f"link:{core.client_ip(req)}", limit=10)
    l = db.one("SELECT * FROM links WHERE token=?", token)
    pw = str((await req.json()).get("password", ""))
    if not l or not l["pw_hash"] or not core.check_pw(l["pw_hash"], pw):
        core.rate_fail(f"link:{core.client_ip(req)}")
        raise HTTPException(401, "Mot de passe incorrect.")
    resp.set_cookie(_cookie_name(token), _sig(token, l), httponly=True, samesite="lax",
                    secure=core.is_https(req), max_age=86400 * 7, path="/")
    return {"ok": True}


@r.get("/api/public/{token}")
def pub_info(token: str, req: Request, path: str = ""):
    l, s, base = _link(req, token)
    p = _sub(base, path)
    author = db.one("SELECT display_name FROM users WHERE id=?", l["created_by"])
    info = {"name": l["title"] or base.name or s["name"], "author": author["display_name"] if author else "",
            "expires_at": l["expires_at"], "dir": p.is_dir(), "path": str(p.relative_to(base)) if p != base else "",
            "kind": l["kind"], "message": l["message"], "allow_upload": bool(l["allow_upload"]), "created_at": l["created_at"]}
    if l["kind"] == "transfer" and p == base:
        allf = [f for f in base.rglob("*") if f.is_file()]
        info["total_size"], info["total_count"] = sum(f.stat().st_size for f in allf), len(allf)
    if p.is_dir() and not l["allow_upload"]:
        items = []
        for de in sorted(os.scandir(p), key=lambda d: (not d.is_dir(), d.name.lower())):
            if de.name.startswith("."):
                continue
            st = de.stat()
            items.append({"name": de.name, "dir": de.is_dir(), "size": 0 if de.is_dir() else st.st_size,
                          "kind": "folder" if de.is_dir() else media.kind(de.name),
                          "path": str(Path(de.path).relative_to(base))})
        info["items"] = items
    elif p.is_dir():
        info["items"] = []
    else:
        info.update({"size": p.stat().st_size, "kind": media.kind(p.name)})
    return info


@r.get("/api/public/{token}/raw")
def pub_raw(token: str, req: Request, path: str = "", dl: int = 0):
    l, s, base = _link(req, token)
    if l["allow_upload"]:
        raise HTTPException(403, "Lien de dépôt uniquement.")
    p = _sub(base, path)
    if p.is_dir():
        raise HTTPException(400, "Dossier.")
    if dl:
        db.run("UPDATE links SET downloads=downloads+1 WHERE id=?", l["id"])
    return core.file_response(p, bool(dl), cache="no-store")


@r.get("/api/public/{token}/thumb")
def pub_thumb(token: str, req: Request, path: str = ""):
    l, s, base = _link(req, token)
    if l["allow_upload"]:
        raise HTTPException(403)
    t = media.thumb(_sub(base, path))
    if not t:
        raise HTTPException(404)
    return FileResponse(t, media_type="image/webp")

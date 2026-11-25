"""Fonctions « Drive » : favoris, récents, recherche globale, zip, transferts (WeTransfer) et demandes de fichiers."""
import os
import secrets
import shutil
import time
from pathlib import Path
from urllib.parse import quote

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import StreamingResponse

from .. import core, db, media
from .files import entry, stream_to, visible_shares, chunk_paths, CHUNK_DIR
from .links import _link, _sub

r = APIRouter()
TRANSFER_PATH = "transferts"


def transfer_share():
    s = db.one("SELECT * FROM shares WHERE kind='system' AND path=?", TRANSFER_PATH)
    if not s:
        sid = db.run("INSERT INTO shares(name,path,description,kind,smb,photos,icon,created_at) VALUES(?,?,?,?,?,?,?,?)",
                     "_transferts", TRANSFER_PATH, "Transferts (interne)", "system", 0, 0, "send", db.now())
        core.helper("fix-perms", TRANSFER_PATH)
        s = db.one("SELECT * FROM shares WHERE id=?", sid)
    return s


def _enrich(s, p: Path, root: Path):
    e = entry(p, root)
    if e:
        e.update(share=s["id"], share_name=s["name"], share_kind=s["kind"], share_owner=s["owner_id"])
    return e


# ------------------------------------------------------------------ favoris
@r.get("/api/favorites")
def favorites(u=Depends(core.current_user)):
    out = []
    for f in db.q("SELECT * FROM favorites WHERE user_id=? ORDER BY created_at DESC", u["id"]):
        s = db.one("SELECT * FROM shares WHERE id=?", f["share_id"])
        if not s or core.share_level(u, s) == "none":
            continue
        root = core.share_root(s).resolve()
        p = root / f["relpath"] if f["relpath"] else root
        if p.exists():
            e = _enrich(s, p, root)
            if not f["relpath"]:
                e["name"], e["path"] = s["name"], ""
            out.append(e)
    return out


@r.post("/api/favorites")
async def favorite_set(req: Request, u=Depends(core.current_user)):
    d = await req.json()
    s, _ = core.access(u, d["share"])
    p = core.safe_path(s, d.get("path", ""))
    rel = str(p.relative_to(core.share_root(s).resolve())) if p != core.share_root(s).resolve() else ""
    if d.get("on", True):
        db.run("INSERT OR IGNORE INTO favorites(user_id,share_id,relpath,created_at) VALUES(?,?,?,?)", u["id"], s["id"], rel, db.now())
    else:
        db.run("DELETE FROM favorites WHERE user_id=? AND share_id=? AND relpath=?", u["id"], s["id"], rel)
    return {"ok": True}


@r.get("/api/favorites/keys")
def favorite_keys(u=Depends(core.current_user)):
    return [f"{f['share_id']}:{f['relpath']}" for f in db.q("SELECT share_id, relpath FROM favorites WHERE user_id=?", u["id"])]


# ------------------------------------------------------------------ récents
@r.get("/api/recent")
def recent(limit: int = 40, everyone: int = 0, u=Depends(core.current_user)):
    rows = db.q("SELECT a.*, us.display_name who FROM activity a LEFT JOIN users us ON us.id=a.user_id " +
                ("" if everyone else "WHERE a.user_id=? ") + "ORDER BY a.ts DESC LIMIT 600",
                *([] if everyone else [u["id"]]))
    seen, out, cache = set(), [], {}
    for a in rows:
        key = (a["share_id"], a["relpath"])
        if key in seen:
            continue
        seen.add(key)
        s = cache.get(a["share_id"])
        if s is None:
            s = db.one("SELECT * FROM shares WHERE id=?", a["share_id"]) or {}
            cache[a["share_id"]] = s
        if not s or s.get("kind") == "system" or core.share_level(u, s) == "none":
            continue
        if s["kind"] == "personal" and s["owner_id"] != u["id"]:
            continue
        root = core.share_root(s).resolve()
        p = root / a["relpath"]
        if not p.exists() or p.is_dir() and a["action"] == "upload":
            continue
        e = _enrich(s, p, root)
        if e:
            e.update(action=a["action"], at=a["ts"], who=a["who"])
            out.append(e)
        if len(out) >= limit:
            break
    return out


# ------------------------------------------------------------------ recherche globale
@r.get("/api/search")
def search_all(q: str, u=Depends(core.current_user)):
    q = q.lower().strip()
    if len(q) < 2:
        return []
    res, t0 = [], time.time()
    for s in visible_shares(u):
        if s["kind"] in ("timemachine", "system"):
            continue
        root = core.share_root(s).resolve()
        for dirpath, dirs, files in os.walk(root):
            dirs[:] = [d for d in dirs if not d.startswith(".")]
            for n in dirs + files:
                if q in n.lower() and not n.startswith("."):
                    e = _enrich(s, Path(dirpath) / n, root)
                    if e:
                        res.append(e)
            if len(res) >= 150 or time.time() - t0 > 6:
                break
        if len(res) >= 150 or time.time() - t0 > 6:
            break
    res.sort(key=lambda e: (not e["name"].lower().startswith(q), not e["dir"], -e["mtime"]))
    return res[:150]


# ------------------------------------------------------------------ zip
@r.get("/api/files/zip")
def zip_download(share: int, paths: str = "", u=Depends(core.current_user)):
    s, _ = core.access(u, share)
    rels = [p for p in paths.split("|") if p] or [""]
    items = []
    for rel in rels:
        p = core.safe_path(s, rel)
        items.append((p, p.name or s["name"]))
    name = (items[0][1] if len(items) == 1 else s["name"]) + ".zip"
    return StreamingResponse(core.zip_stream(items), media_type="application/zip",
                             headers={"Content-Disposition": f"attachment; filename*=UTF-8''{quote(name)}"})


@r.get("/api/public/{token}/zip")
def public_zip(token: str, req: Request, path: str = ""):
    l, s, base = _link(req, token)
    p = _sub(base, path)
    db.run("UPDATE links SET downloads=downloads+1 WHERE id=?", l["id"])
    name = (l["title"] or p.name or "fichiers") + ".zip"
    items = [(p, "")] if p.is_dir() else [(p, p.name)]
    return StreamingResponse(core.zip_stream(items), media_type="application/zip",
                             headers={"Content-Disposition": f"attachment; filename*=UTF-8''{quote(name)}"})


# ------------------------------------------------------------------ transferts (style WeTransfer)
def _transfer_out(l):
    s = core.get_share(l["share_id"])
    d = core.share_root(s) / l["relpath"]
    files = [f for f in d.rglob("*") if f.is_file()] if d.is_dir() else []
    return {"id": l["id"], "token": l["token"], "url": f"/s/{l['token']}", "title": l["title"], "message": l["message"],
            "created_at": l["created_at"], "expires_at": l["expires_at"], "downloads": l["downloads"],
            "has_password": bool(l["pw_hash"]), "expired": bool(l["expires_at"] and l["expires_at"] < db.now()),
            "count": len(files), "size": sum(f.stat().st_size for f in files),
            "files": [{"name": f.name, "size": f.stat().st_size, "kind": media.kind(f.name)} for f in files[:50]]}


@r.post("/api/transfers")
async def transfer_create(req: Request, u=Depends(core.current_user)):
    d = await req.json()
    s = transfer_share()
    days = max(1, min(int(d.get("expires_days") or 7), 90))
    folder = f"{u['username']}-{time.strftime('%Y%m%d-%H%M%S')}-{secrets.token_hex(3)}"
    core.helper("fix-perms", f"{TRANSFER_PATH}/{folder}")
    pw = str(d.get("password") or "")
    token = secrets.token_urlsafe(12)
    lid = db.run("INSERT INTO links(token,share_id,relpath,created_by,created_at,expires_at,pw_hash,kind,title,message) "
                 "VALUES(?,?,?,?,?,?,?,?,?,?)", token, s["id"], folder, u["id"], db.now(), db.now() + days * 86400,
                 core.hash_pw(pw) if pw else None, "transfer", str(d.get("title") or "")[:120], str(d.get("message") or "")[:2000])
    core.audit(req, u, "transfert.cree", d.get("title") or folder)
    return {"id": lid, "token": token, "url": f"/s/{token}"}


def _my_transfer(u, lid):
    l = db.one("SELECT * FROM links WHERE id=? AND kind='transfer'", lid)
    if not l or (l["created_by"] != u["id"] and u["role"] != "admin"):
        raise HTTPException(404, "Transfert introuvable.")
    return l


@r.put("/api/transfers/{lid}/upload")
async def transfer_upload(lid: int, name: str, req: Request, u=Depends(core.current_user)):
    l = _my_transfer(u, lid)
    s = core.get_share(l["share_id"])
    d = core.share_root(s) / l["relpath"]
    parts = [core.valid_name(x) for x in name.split("/") if x]
    target = d
    for p in parts[:-1]:
        target = target / p
        target.mkdir(exist_ok=True)
    dest = core.unique_path(target / parts[-1])
    tmp, n = await stream_to(req, dest, owner=f"u{u['id']}")
    os.chmod(tmp, 0o660)
    os.replace(tmp, dest)
    return {"ok": True, "size": n}


@r.get("/api/transfers")
def transfers(u=Depends(core.current_user)):
    return [_transfer_out(l) for l in db.q("SELECT * FROM links WHERE kind='transfer' AND created_by=? ORDER BY id DESC", u["id"])]


@r.delete("/api/transfers/{lid}")
def transfer_delete(lid: int, req: Request, u=Depends(core.current_user)):
    l = _my_transfer(u, lid)
    s = core.get_share(l["share_id"])
    shutil.rmtree(core.share_root(s) / l["relpath"], ignore_errors=True)
    db.run("DELETE FROM links WHERE id=?", lid)
    core.audit(req, u, "transfert.supprime", l["title"])
    return {"ok": True}


def cleanup_transfers():
    """Supprime les transferts expirés depuis plus d'un jour (appelé par le planificateur)."""
    for l in db.q("SELECT * FROM links WHERE kind='transfer' AND expires_at < ?", db.now() - 86400):
        s = db.one("SELECT * FROM shares WHERE id=?", l["share_id"])
        if s:
            shutil.rmtree(core.share_root(s) / l["relpath"], ignore_errors=True)
        db.run("DELETE FROM links WHERE id=?", l["id"])


# ------------------------------------------------------------------ demandes de fichiers
@r.post("/api/requests")
async def request_create(req: Request, u=Depends(core.current_user)):
    d = await req.json()
    s, _ = core.access(u, d["share"], "write")
    p = core.safe_path(s, d.get("path", ""))
    if not p.is_dir():
        raise HTTPException(400, "Choisis un dossier.")
    days = int(d.get("expires_days") or 0)
    token = secrets.token_urlsafe(12)
    lid = db.run("INSERT INTO links(token,share_id,relpath,created_by,created_at,expires_at,kind,title,message,allow_upload) "
                 "VALUES(?,?,?,?,?,?,?,?,?,1)", token, s["id"], str(p.relative_to(core.share_root(s).resolve())) if p != core.share_root(s).resolve() else "",
                 u["id"], db.now(), db.now() + days * 86400 if days > 0 else None, "request",
                 str(d.get("title") or p.name)[:120], str(d.get("message") or "")[:2000])
    core.audit(req, u, "demande.creee", s["name"], d.get("path", ""))
    return {"id": lid, "token": token, "url": f"/s/{token}"}


@r.get("/api/requests")
def requests_list(u=Depends(core.current_user)):
    rows = db.q("SELECT l.*, s.name share_name FROM links l JOIN shares s ON s.id=l.share_id WHERE l.kind='request' AND l.created_by=? "
                "ORDER BY l.id DESC", u["id"])
    for x in rows:
        x.pop("pw_hash", None)
        x["expired"] = bool(x["expires_at"] and x["expires_at"] < db.now())
    return rows


@r.put("/api/public/{token}/upload")
async def public_upload(token: str, name: str, req: Request, sender: str = ""):
    core.rate_check(f"pubup:{core.client_ip(req)}", limit=2000, window=3600)
    l, s, base = _link(req, token)
    if not l["allow_upload"]:
        raise HTTPException(403, "Ce lien ne permet pas d'envoyer des fichiers.")
    who = "".join(c for c in sender.strip()[:40] if c.isalnum() or c in " -_'") or "Anonyme"
    folder = base / f"Reçu de {who} - {time.strftime('%Y-%m-%d')}"
    folder.mkdir(exist_ok=True)
    parts = [core.valid_name(x) for x in name.split("/") if x]
    target = folder
    for p in parts[:-1]:
        target = target / p
        target.mkdir(exist_ok=True)
    dest = core.unique_path(target / parts[-1])
    tmp, n = await stream_to(req, dest, owner=f"l{l['id']}")
    os.chmod(tmp, 0o660)
    os.replace(tmp, dest)
    db.run("UPDATE links SET uploads=uploads+1 WHERE id=?", l["id"])
    core.log_activity(None, s, dest.relative_to(core.share_root(s).resolve()), "received")
    return {"ok": True}


@r.post("/api/public/{token}/done")
async def public_done(token: str, req: Request):
    l, s, base = _link(req, token)
    d = await req.json()
    who = str(d.get("sender") or "Quelqu'un")[:40]
    core.notify([l["created_by"]], f"{who} t'a envoyé {int(d.get('count') or 0)} fichier(s)",
                f"Dans « {l['title'] or s['name']} »", "success", f"/fichiers?s={s['id']}&p={quote(l['relpath'])}")
    return {"ok": True}


@r.get("/api/storage")
def storage(u=Depends(core.current_user)):
    st = os.statvfs(core.STORAGE)
    total, free = st.f_blocks * st.f_frsize, st.f_bavail * st.f_frsize
    return {"total": total, "free": free, "used": total - free}


# ------------------------------------------------------------------ envoi par morceaux (reprise possible)
MAX_CHUNK = 95 * 1024 * 1024


@r.put("/api/chunks/{uid}")
async def chunk_put(uid: str, req: Request, offset: int = 0, token: str = ""):
    if req.headers.get("x-nas") != "1":
        raise HTTPException(403, "Requête refusée.")
    if token:
        l, s, base = _link(req, token)
        if not l["allow_upload"]:
            raise HTTPException(403, "Envoi non autorisé.")
        core.rate_check(f"pubchunk:{core.client_ip(req)}", limit=20000, window=3600)
        owner = f"l{l['id']}"
    else:
        u = core.current_user(req)
        owner = f"u{u['id']}"
    part, own = chunk_paths(uid)
    CHUNK_DIR.mkdir(parents=True, exist_ok=True)
    if own.exists() and own.read_text() != owner:
        raise HTTPException(403, "Envoi d'un autre utilisateur.")
    if not own.exists():
        own.write_text(owner)
    size = part.stat().st_size if part.exists() else 0
    if offset != size:  # le client reprend à la bonne position
        return {"ok": False, "size": size}
    n = 0
    with open(part, "ab") as f:
        async for c in req.stream():
            n += len(c)
            if n > MAX_CHUNK:
                raise HTTPException(413, "Morceau trop gros.")
            f.write(c)
    return {"ok": True, "size": size + n}


@r.get("/api/chunks/{uid}")
def chunk_status(uid: str):
    part, _ = chunk_paths(uid)
    return {"size": part.stat().st_size if part.exists() else 0}


def cleanup_chunks():
    if CHUNK_DIR.exists():
        for f in CHUNK_DIR.iterdir():
            if time.time() - f.stat().st_mtime > 86400:
                f.unlink(missing_ok=True)

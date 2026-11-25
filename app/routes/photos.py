"""Photos : timeline, carte, sauvegarde depuis le téléphone, albums partagés."""
import hashlib
import os
import time
from datetime import datetime
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import FileResponse

from .. import video, core, db, media
from .files import stream_to

r = APIRouter()


def photo_shares(u):
    """Partages photo lisibles par l'utilisateur."""
    out = []
    for s in db.q("SELECT * FROM shares WHERE photos=1"):
        if s["kind"] == "personal" and s["owner_id"] != u["id"]:
            continue
        if core.share_level(u, s) != "none":
            out.append(s)
    return out


def _photo_access(u, pid: int):
    p = db.one("SELECT * FROM photos WHERE id=?", pid)
    if not p:
        raise HTTPException(404, "Photo introuvable.")
    s = core.get_share(p["share_id"])
    ok = (s["kind"] != "personal" or s["owner_id"] == u["id"] or u["role"] == "admin") and \
        core.share_level(u, s) != "none"
    if not ok:  # accès accordé par un album partagé
        ok = db.one("SELECT 1 FROM album_photos ap JOIN albums a ON a.id=ap.album_id "
                    "LEFT JOIN album_members m ON m.album_id=a.id AND m.user_id=? "
                    "WHERE ap.photo_id=? AND (a.owner_id=? OR m.user_id IS NOT NULL) LIMIT 1", u["id"], pid, u["id"])
    if not ok:
        raise HTTPException(403, "Accès refusé.")
    return p, s


def _row(p, shares_by_id):
    s = shares_by_id.get(p["share_id"])
    return {"id": p["id"], "taken_at": p["taken_at"], "w": p["width"], "h": p["height"], "video": bool(p["is_video"]),
            "lat": p["lat"], "lon": p["lon"], "share": p["share_id"], "share_name": s["name"] if s else "",
            "path": p["relpath"], "name": os.path.basename(p["relpath"]), "size": p["size"]}


@r.get("/api/photos/timeline")
def timeline(before: int = 0, limit: int = 300, share: int = 0, u=Depends(core.current_user)):
    shares = photo_shares(u)
    if share:
        shares = [s for s in shares if s["id"] == share]
    if not shares:
        return {"items": [], "shares": []}
    ids = [s["id"] for s in shares]
    marks = ",".join("?" * len(ids))
    rows = db.q(f"SELECT * FROM photos WHERE share_id IN ({marks}) AND taken_at < ? ORDER BY taken_at DESC LIMIT ?",
                *ids, before or 2**62, min(limit, 1000))
    by = {s["id"]: s for s in shares}
    return {"items": [_row(p, by) for p in rows],
            "shares": [{"id": s["id"], "name": s["name"]} for s in shares],
            "total": db.one(f"SELECT COUNT(*) n FROM photos WHERE share_id IN ({marks})", *ids)["n"]}


@r.get("/api/photos/map")
def photo_map(u=Depends(core.current_user)):
    shares = photo_shares(u)
    if not shares:
        return []
    ids = [s["id"] for s in shares]
    marks = ",".join("?" * len(ids))
    return db.q(f"SELECT id, lat, lon, taken_at, is_video video FROM photos WHERE share_id IN ({marks}) "
                f"AND lat IS NOT NULL ORDER BY taken_at DESC LIMIT 20000", *ids)


@r.get("/api/photos/{pid}/thumb")
def photo_thumb(pid: int, size: int = 320, u=Depends(core.current_user)):
    p, s = _photo_access(u, pid)
    t = media.thumb(core.share_root(s) / p["relpath"], 1280 if size > 400 else 320)
    if not t:
        raise HTTPException(404)
    return FileResponse(t, media_type="image/webp", headers={"Cache-Control": "private, max-age=604800"})


@r.get("/api/photos/{pid}/raw")
def photo_raw(pid: int, dl: int = 0, u=Depends(core.current_user)):
    p, s = _photo_access(u, pid)
    return core.file_response(core.share_root(s) / p["relpath"], bool(dl))


@r.get("/api/photos/{pid}/play")
def photo_play(pid: int, hevc: int = 0, u=Depends(core.current_user)):
    """Comment lire cette vidéo dans le navigateur : l'original, ou une copie H.264 (préparée si besoin)."""
    p, s = _photo_access(u, pid)
    st = video.status(core.share_root(s) / p["relpath"], bool(hevc))
    st["url"] = f"/api/photos/{pid}/raw" if st["mode"] == "native" else f"/api/photos/{pid}/web"
    return st


@r.get("/api/photos/{pid}/web")
def photo_web(pid: int, u=Depends(core.current_user)):
    p, s = _photo_access(u, pid)
    f = video.web_file(core.share_root(s) / p["relpath"])
    if not f:
        raise HTTPException(404, "Vidéo en cours de préparation.")
    return FileResponse(f, media_type="video/mp4", headers={"Cache-Control": "private, max-age=86400"})


@r.put("/api/photos/backup")
async def backup(req: Request, name: str, mtime: int = 0, album: str = "", u=Depends(core.current_user)):
    """Sauvegarde depuis le téléphone → <perso>/Photos/AAAA/MM (appareil photo) ou <perso>/Photos/<album>/AAAA/MM
    (captures, WhatsApp…), en ignorant les doublons."""
    share = db.one("SELECT * FROM shares WHERE kind='personal' AND owner_id=?", u["id"])
    if not share:
        raise HTTPException(400, "Pas d'espace personnel.")
    name = core.valid_name(os.path.basename(name))
    ts = mtime / 1000 if mtime > 10**11 else (mtime or time.time())
    dt = datetime.fromtimestamp(ts)
    album = album.strip()
    sub = [] if not album or album.lower() in ("camera", "appareil photo", "dcim", "100andro") else [core.valid_name(album[:60])]
    folder = core.share_root(share) / "Photos" / Path(*sub) / f"{dt:%Y}" / f"{dt:%m}"
    folder.mkdir(parents=True, exist_ok=True)
    dest = folder / name
    tmp, n = await stream_to(req, dest, owner=f"u{u['id']}")
    h = hashlib.sha1()
    with open(tmp, "rb") as f:
        while b := f.read(1 << 20):
            h.update(b)
    sha = h.hexdigest()
    dup = db.one("SELECT p.id FROM photos p JOIN shares s ON s.id=p.share_id WHERE p.sha1=? AND "
                 "(s.owner_id=? OR s.kind!='personal') LIMIT 1", sha, u["id"])
    if dup:
        tmp.unlink()
        return {"ok": True, "duplicate": True}
    if dest.exists():
        if hashlib.sha1(dest.read_bytes()).hexdigest() == sha:
            tmp.unlink()
            return {"ok": True, "duplicate": True}
        dest = core.unique_path(dest)
    os.chmod(tmp, 0o660)
    os.replace(tmp, dest)
    os.utime(dest, (ts, ts))
    from ..jobs import index_file
    index_file(share, dest, sha)
    return {"ok": True, "duplicate": False, "path": str(dest.relative_to(core.share_root(share)))}


@r.post("/api/photos/check")
async def check(req: Request, u=Depends(core.current_user)):
    """Le téléphone envoie (nom, taille) : on répond ceux déjà sauvegardés pour ne pas les renvoyer."""
    items = (await req.json()).get("items", [])[:5000]
    share = db.one("SELECT * FROM shares WHERE kind='personal' AND owner_id=?", u["id"])
    if not share:
        return {"known": []}
    known = set()
    rows = db.q("SELECT relpath, size FROM photos WHERE share_id=?", share["id"])
    have = {(os.path.basename(r["relpath"]), r["size"]) for r in rows}
    for i, it in enumerate(items):
        if (str(it.get("name")), int(it.get("size", -1))) in have:
            known.add(i)
    return {"known": sorted(known)}


# ------------------------------------------------------------------ albums
def _album(u, aid, manage=False):
    a = db.one("SELECT * FROM albums WHERE id=?", aid)
    if not a:
        raise HTTPException(404, "Album introuvable.")
    member = db.one("SELECT 1 FROM album_members WHERE album_id=? AND user_id=?", aid, u["id"])
    if a["owner_id"] != u["id"] and u["role"] != "admin" and (manage or not member):
        raise HTTPException(403, "Accès refusé.")
    return a


@r.get("/api/albums")
def albums(u=Depends(core.current_user)):
    rows = db.q("SELECT a.*, us.display_name owner_name, (SELECT COUNT(*) FROM album_photos WHERE album_id=a.id) n, "
                "(SELECT photo_id FROM album_photos WHERE album_id=a.id ORDER BY added_at DESC LIMIT 1) last_photo "
                "FROM albums a JOIN users us ON us.id=a.owner_id WHERE a.owner_id=? OR a.id IN "
                "(SELECT album_id FROM album_members WHERE user_id=?) ORDER BY a.created_at DESC", u["id"], u["id"])
    for a in rows:
        a["members"] = [m["user_id"] for m in db.q("SELECT user_id FROM album_members WHERE album_id=?", a["id"])]
        a["mine"] = a["owner_id"] == u["id"]
    return rows


@r.post("/api/albums")
async def album_create(req: Request, u=Depends(core.current_user)):
    d = await req.json()
    name = str(d.get("name", "")).strip()[:100]
    if not name:
        raise HTTPException(400, "Donne un nom à l'album.")
    aid = db.run("INSERT INTO albums(name,owner_id,created_at) VALUES(?,?,?)", name, u["id"], db.now())
    for m in d.get("members", []):
        db.run("INSERT OR IGNORE INTO album_members(album_id,user_id) VALUES(?,?)", aid, int(m))
    others = {int(m) for m in d.get("members", [])} - {u["id"]}
    if others:
        core.notify(others, "Nouvel album partagé", f"{u['display_name']} partage l'album « {name} » avec toi.",
                    "info", f"/albums/{aid}")
    if d.get("photos"):
        await _add(u, aid, d["photos"])
    return {"id": aid}


async def _add(u, aid, photo_ids):
    for pid in photo_ids:
        _photo_access(u, int(pid))
        db.run("INSERT OR IGNORE INTO album_photos(album_id,photo_id,added_at) VALUES(?,?,?)", aid, int(pid), db.now())


@r.get("/api/albums/{aid}")
def album_get(aid: int, u=Depends(core.current_user)):
    a = _album(u, aid)
    rows = db.q("SELECT p.* FROM photos p JOIN album_photos ap ON ap.photo_id=p.id WHERE ap.album_id=? "
                "ORDER BY p.taken_at DESC", aid)
    by = {s["id"]: s for s in db.q("SELECT * FROM shares")}
    a["items"] = [_row(p, by) for p in rows]
    a["members"] = [m["user_id"] for m in db.q("SELECT user_id FROM album_members WHERE album_id=?", aid)]
    a["mine"] = a["owner_id"] == u["id"] or u["role"] == "admin"
    return a


@r.post("/api/albums/{aid}/photos")
async def album_add(aid: int, req: Request, u=Depends(core.current_user)):
    _album(u, aid)
    await _add(u, aid, (await req.json()).get("photos", []))
    return {"ok": True}


@r.post("/api/albums/{aid}/remove")
async def album_remove(aid: int, req: Request, u=Depends(core.current_user)):
    _album(u, aid, manage=True)
    for pid in (await req.json()).get("photos", []):
        db.run("DELETE FROM album_photos WHERE album_id=? AND photo_id=?", aid, int(pid))
    return {"ok": True}


@r.put("/api/albums/{aid}")
async def album_update(aid: int, req: Request, u=Depends(core.current_user)):
    _album(u, aid, manage=True)
    d = await req.json()
    if "name" in d:
        db.run("UPDATE albums SET name=? WHERE id=?", str(d["name"]).strip()[:100] or "Album", aid)
    if "members" in d:
        before = {m["user_id"] for m in db.q("SELECT user_id FROM album_members WHERE album_id=?", aid)}
        db.run("DELETE FROM album_members WHERE album_id=?", aid)
        for m in d["members"]:
            db.run("INSERT OR IGNORE INTO album_members(album_id,user_id) VALUES(?,?)", aid, int(m))
        added = {int(m) for m in d["members"]} - before - {u["id"]}
        if added:
            name = db.one("SELECT name FROM albums WHERE id=?", aid)["name"]
            core.notify(added, "Nouvel album partagé", f"{u['display_name']} partage l'album « {name} » avec toi.",
                        "info", f"/albums/{aid}")
    return {"ok": True}


@r.delete("/api/albums/{aid}")
def album_delete(aid: int, u=Depends(core.current_user)):
    _album(u, aid, manage=True)
    db.run("DELETE FROM albums WHERE id=?", aid)
    return {"ok": True}


@r.get("/api/people")
def people(u=Depends(core.current_user)):
    """Liste simple des comptes (pour partager un album, un dossier…)."""
    return db.q("SELECT id, username, display_name, role FROM users WHERE disabled=0 ORDER BY display_name")

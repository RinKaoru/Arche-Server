"""Fichiers : navigation, envoi, téléchargement, aperçu, corbeille, versions (snapshots)."""
from urllib.parse import urlencode
import os
import shutil
import time
from pathlib import Path
from urllib.parse import quote

import aiofiles
from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import FileResponse

from .. import video, core, db, media

r = APIRouter()


def entry(p: Path, root: Path):
    try:
        st = p.stat()
    except OSError:
        return None
    is_dir = p.is_dir()
    return {"name": p.name, "path": str(p.relative_to(root)), "dir": is_dir,
            "size": 0 if is_dir else st.st_size, "mtime": int(st.st_mtime),
            "kind": "folder" if is_dir else media.kind(p.name)}


def visible_shares(u):
    out = []
    for s in db.q("SELECT * FROM shares ORDER BY kind='personal' DESC, name"):
        if s["kind"] == "system" or (s["kind"] == "timemachine" and u["role"] != "admin"):
            continue
        if s["kind"] == "personal" and s["owner_id"] != u["id"] and u["role"] != "admin":
            continue
        lvl = core.share_level(u, s)
        if lvl != "none":
            out.append({**s, "level": lvl, "can_manage": core.can_manage_share(u, s)})
    return out


@r.get("/api/shares")
def my_shares(u=Depends(core.current_user)):
    shares = visible_shares(u)
    for s in shares:
        try:
            st = os.statvfs(core.share_root(s))
            s["free"] = st.f_bavail * st.f_frsize
        except OSError:
            s["free"] = None
    return shares


@r.get("/api/files/list")
def list_dir(share: int, path: str = "", u=Depends(core.current_user)):
    s, lvl = core.access(u, share)
    p = core.safe_path(s, path)
    if not p.is_dir():
        raise HTTPException(400, "Ce n'est pas un dossier.")
    root = core.share_root(s).resolve()
    items = []
    with os.scandir(p) as it:
        for de in it:
            if de.name.startswith(".") or de.name in ("lost+found", "@eaDir", "#recycle"):
                continue
            e = entry(Path(de.path), root)
            if e:
                items.append(e)
    items.sort(key=lambda e: (not e["dir"], e["name"].lower()))
    return {"share": {"id": s["id"], "name": s["name"], "level": lvl, "kind": s["kind"], "owner_id": s["owner_id"]},
            "path": str(p.relative_to(root)) if p != root else "", "items": items}


@r.get("/api/files/search")
def search(share: int, q: str, u=Depends(core.current_user)):
    s, _ = core.access(u, share)
    root = core.share_root(s).resolve()
    q = q.lower().strip()
    if len(q) < 2:
        return []
    res, t0 = [], time.time()
    for dirpath, dirs, files in os.walk(root):
        dirs[:] = [d for d in dirs if not d.startswith(".")]
        for n in dirs + files:
            if q in n.lower():
                e = entry(Path(dirpath) / n, root)
                if e:
                    res.append(e)
        if len(res) >= 200 or time.time() - t0 > 8:
            break
    return res


@r.get("/api/files/raw")
def raw(share: int, path: str, dl: int = 0, u=Depends(core.current_user)):
    s, _ = core.access(u, share)
    p = core.safe_path(s, path)
    if p.is_dir():
        raise HTTPException(400, "Impossible de télécharger un dossier directement.")
    return core.file_response(p, bool(dl))


@r.get("/api/files/play")
def play(share: int, path: str, hevc: int = 0, u=Depends(core.current_user)):
    s, _ = core.access(u, share)
    p = core.safe_path(s, path)
    st = video.status(p, bool(hevc))
    st["url"] = ("/api/files/raw?" if st["mode"] == "native" else "/api/files/web?") + urlencode({"share": share, "path": path})
    return st


@r.get("/api/files/web")
def web(share: int, path: str, u=Depends(core.current_user)):
    s, _ = core.access(u, share)
    f = video.web_file(core.safe_path(s, path))
    if not f:
        raise HTTPException(404, "Vidéo en cours de préparation.")
    return FileResponse(f, media_type="video/mp4", headers={"Cache-Control": "private, max-age=86400"})


@r.get("/api/files/thumb")
def thumb(share: int, path: str, size: int = 320, u=Depends(core.current_user)):
    s, _ = core.access(u, share)
    p = core.safe_path(s, path)
    t = media.thumb(p, 1280 if size > 400 else 320)
    if not t:
        raise HTTPException(404, "Pas d'aperçu.")
    return FileResponse(t, media_type="image/webp", headers={"Cache-Control": "private, max-age=604800"})


@r.get("/api/files/text")
def text(share: int, path: str, u=Depends(core.current_user)):
    s, _ = core.access(u, share)
    p = core.safe_path(s, path)
    with open(p, "rb") as f:
        data = f.read(512 * 1024)
    return {"text": data.decode("utf-8", errors="replace"), "truncated": p.stat().st_size > len(data)}


CHUNK_DIR = core.STORAGE / ".nas" / "tmp" / "chunks"


def chunk_paths(uid: str):
    if not (16 <= len(uid) <= 64) or not all(c.isalnum() or c in "-_" for c in uid):
        raise HTTPException(400, "Identifiant d'envoi invalide.")
    return CHUNK_DIR / f"{uid}.part", CHUNK_DIR / f"{uid}.owner"


async def stream_to(req: Request, dest: Path, size_hint: int | None = None, owner: str | None = None):
    """Écrit le corps brut de la requête dans un fichier temporaire (ou reprend un envoi par morceaux), à renommer ensuite."""
    tmp = dest.with_name(f".{dest.name}.upload-{os.getpid()}-{time.time_ns()}")
    uid = req.query_params.get("chunk")
    if uid:  # finalisation d'un envoi découpé (proxy Cloudflare limité à 100 Mo par requête)
        part, own = chunk_paths(uid)
        if not part.exists() or not own.exists() or own.read_text() != str(owner):
            raise HTTPException(404, "Envoi introuvable ou expiré.")
        n = part.stat().st_size
        if str(n) != req.query_params.get("total", ""):
            raise HTTPException(400, "Envoi incomplet.")
        os.replace(part, tmp)
        own.unlink(missing_ok=True)
        return tmp, n
    written = 0
    try:
        async with aiofiles.open(tmp, "wb") as f:
            async for chunk in req.stream():
                await f.write(chunk)
                written += len(chunk)
        if size_hint is not None and written != size_hint:
            raise HTTPException(400, "Envoi interrompu.")
        return tmp, written
    except BaseException:
        tmp.unlink(missing_ok=True)
        raise


@r.put("/api/files/upload")
async def upload(req: Request, share: int, path: str, name: str, overwrite: int = 0, mtime: int = 0,
                 u=Depends(core.current_user)):
    s, _ = core.access(u, share, "write")
    folder = core.safe_path(s, path)
    if not folder.is_dir():
        raise HTTPException(400, "Dossier de destination invalide.")
    # sous-dossiers (envoi d'un dossier entier) : name peut contenir des "/"
    parts = [core.valid_name(x) for x in name.split("/") if x]
    if not parts:
        raise HTTPException(400, "Nom invalide.")
    target_dir = folder
    for d in parts[:-1]:
        target_dir = target_dir / d
        target_dir.mkdir(exist_ok=True)
    dest = target_dir / parts[-1]
    if dest.exists() and not overwrite:
        dest = core.unique_path(dest)
    cl = req.headers.get("content-length")
    tmp, n = await stream_to(req, dest, None if req.query_params.get("chunk") else (int(cl) if cl and cl.isdigit() else None), owner=f"u{u['id']}")
    os.chmod(tmp, 0o660)
    if dest.exists() and overwrite:
        _to_trash(u, s, dest)
    os.replace(tmp, dest)
    if mtime > 0:
        os.utime(dest, (mtime / 1000, mtime / 1000) if mtime > 10**11 else (mtime, mtime))
    core.log_activity(u, s, dest.relative_to(core.share_root(s).resolve()), "upload")
    return {"ok": True, "name": dest.name, "size": n}


@r.post("/api/files/mkdir")
async def mkdir(req: Request, u=Depends(core.current_user)):
    d = await req.json()
    s, _ = core.access(u, d["share"], "write")
    parent = core.safe_path(s, d.get("path", ""))
    p = parent / core.valid_name(d["name"])
    if p.exists():
        raise HTTPException(409, "Un élément porte déjà ce nom.")
    p.mkdir(mode=0o2770)
    core.log_activity(u, s, p.relative_to(core.share_root(s).resolve()), "mkdir")
    return {"ok": True}


@r.post("/api/files/rename")
async def rename(req: Request, u=Depends(core.current_user)):
    d = await req.json()
    s, _ = core.access(u, d["share"], "write")
    p = core.safe_path(s, d["path"])
    if p == core.share_root(s).resolve():
        raise HTTPException(400, "Impossible de renommer la racine.")
    new = p.with_name(core.valid_name(d["name"]))
    if new.exists():
        raise HTTPException(409, "Un élément porte déjà ce nom.")
    p.rename(new)
    core.log_activity(u, s, new.relative_to(core.share_root(s).resolve()), "rename")
    db.run("UPDATE favorites SET relpath=? WHERE share_id=? AND relpath=?", str(new.relative_to(core.share_root(s).resolve())),
           s["id"], str(p.relative_to(core.share_root(s).resolve())))
    return {"ok": True}


@r.post("/api/files/move")
async def move(req: Request, u=Depends(core.current_user)):
    """Déplacer ou copier (copy=true) vers un autre dossier, éventuellement d'un autre partage."""
    d = await req.json()
    src_s, _ = core.access(u, d["share"], "read" if d.get("copy") else "write")
    dst_s, _ = core.access(u, d["dest_share"], "write")
    dest = core.safe_path(dst_s, d.get("dest_path", ""))
    if not dest.is_dir():
        raise HTTPException(400, "Destination invalide.")
    done = 0
    for rel in d.get("paths", []):
        p = core.safe_path(src_s, rel)
        if p == core.share_root(src_s).resolve():
            continue
        if p.is_dir() and (dest == p or p in dest.parents):
            raise HTTPException(400, "Impossible de déplacer un dossier dans lui-même.")
        target = core.unique_path(dest / p.name)
        if d.get("copy"):
            (shutil.copytree if p.is_dir() else shutil.copy2)(p, target)
        else:
            shutil.move(str(p), str(target))
        core.log_activity(u, dst_s, target.relative_to(core.share_root(dst_s).resolve()), "copy" if d.get("copy") else "move")
        done += 1
    return {"ok": True, "count": done}


def _to_trash(u, share, p: Path):
    root = core.share_root(share).resolve()
    rel = p.relative_to(root)
    t = root / core.TRASH_DIR / u["username"] / rel
    t.parent.mkdir(parents=True, exist_ok=True)
    if t.exists():
        t = t.with_name(f"{t.name}.{time.strftime('%Y%m%d-%H%M%S')}")
    os.rename(p, t)
    os.utime(t, None) if t.is_file() else None


@r.post("/api/files/delete")
async def delete(req: Request, u=Depends(core.current_user)):
    d = await req.json()
    s, _ = core.access(u, d["share"], "write")
    n = 0
    for rel in d.get("paths", []):
        p = core.safe_path(s, rel)
        if p == core.share_root(s).resolve():
            continue
        _to_trash(u, s, p)
        n += 1
    core.audit(req, u, "fichiers.corbeille", s["name"], f"{n} élément(s)")
    return {"ok": True, "count": n}


# ------------------------------------------------------------------ versions (snapshots)
@r.get("/api/files/versions")
def versions(share: int, path: str, u=Depends(core.current_user)):
    s, _ = core.access(u, share)
    p = core.safe_path(s, path, must_exist=False)
    rel = p.relative_to(core.share_root(s).resolve())
    out = []
    if core.SNAPSHOTS.exists():
        for snap in sorted(os.listdir(core.SNAPSHOTS), reverse=True):
            if len(snap) != 10:
                continue
            sp = core.SNAPSHOTS / snap / s["path"] / rel
            try:
                st = sp.stat()
                out.append({"date": snap, "size": st.st_size, "mtime": int(st.st_mtime), "dir": sp.is_dir()})
            except OSError:
                continue
    return out


@r.post("/api/files/restore-version")
async def restore_version(req: Request, u=Depends(core.current_user)):
    d = await req.json()
    s, _ = core.access(u, d["share"], "write")
    snap = str(d["date"])
    if len(snap) != 10 or not snap.replace("-", "").isdigit():
        raise HTTPException(400, "Version invalide.")
    p = core.safe_path(s, d["path"], must_exist=False)
    rel = p.relative_to(core.share_root(s).resolve())
    src = core.SNAPSHOTS / snap / s["path"] / rel
    if not src.exists():
        raise HTTPException(404, "Version introuvable.")
    stem, suf = (p.stem, p.suffix) if src.is_file() else (p.name, "")
    target = core.unique_path(p.with_name(f"{stem} (version du {snap}){suf}"))
    if not p.parent.exists():
        p.parent.mkdir(parents=True)
    (shutil.copytree if src.is_dir() else shutil.copy2)(src, target)
    core.log_activity(u, s, target.relative_to(core.share_root(s).resolve()), "restore")
    core.audit(req, u, "version.restauree", s["name"], f"{rel} @ {snap}")
    return {"ok": True, "name": target.name}


# ------------------------------------------------------------------ corbeille
@r.get("/api/trash")
def trash_list(u=Depends(core.current_user)):
    """Contenu des corbeilles (web + Samba) de tous les partages où j'ai l'écriture."""
    out = []
    for s in visible_shares(u):
        if s["level"] != "write" or s["kind"] == "timemachine":
            continue
        troot = core.share_root(s) / core.TRASH_DIR
        if not troot.is_dir():
            continue
        for who in sorted(os.listdir(troot)):
            base = troot / who
            if not base.is_dir():
                continue
            for dirpath, dirs, files in os.walk(base):
                for f in files:
                    fp = Path(dirpath) / f
                    try:
                        st = fp.lstat()
                    except OSError:
                        continue
                    out.append({"share": s["id"], "share_name": s["name"], "by": who,
                                "item": str(fp.relative_to(troot)), "orig": str(fp.relative_to(base)),
                                "size": st.st_size, "deleted_at": int(st.st_ctime)})
                if len(out) > 5000:
                    break
    out.sort(key=lambda x: -x["deleted_at"])
    return out


def _trash_item(u, share_id, item: str):
    s, _ = core.access(u, share_id, "write")
    troot = (core.share_root(s) / core.TRASH_DIR).resolve()
    p = (troot / item).resolve()
    if troot not in p.parents or not p.exists():
        raise HTTPException(404, "Élément introuvable dans la corbeille.")
    return s, troot, p


def _prune_empty(troot: Path, start: Path):
    d = start
    while d != troot and troot in d.parents:
        try:
            d.rmdir()
        except OSError:
            break
        d = d.parent


@r.post("/api/trash/restore")
async def trash_restore(req: Request, u=Depends(core.current_user)):
    d = await req.json()
    n = 0
    for it in d.get("items", []):
        s, troot, p = _trash_item(u, it["share"], it["item"])
        orig = Path(*Path(it["item"]).parts[1:])
        dest = core.share_root(s).resolve() / orig
        dest.parent.mkdir(parents=True, exist_ok=True)
        os.rename(p, core.unique_path(dest))
        _prune_empty(troot, p.parent)
        n += 1
    core.audit(req, u, "corbeille.restauration", "", f"{n} élément(s)")
    return {"ok": True, "count": n}


@r.post("/api/trash/delete")
async def trash_delete(req: Request, u=Depends(core.current_user)):
    d = await req.json()
    n = 0
    for it in d.get("items", []):
        s, troot, p = _trash_item(u, it["share"], it["item"])
        shutil.rmtree(p) if p.is_dir() else p.unlink()
        _prune_empty(troot, p.parent)
        n += 1
    core.audit(req, u, "corbeille.suppression_definitive", "", f"{n} élément(s)")
    return {"ok": True, "count": n}


@r.post("/api/trash/empty")
async def trash_empty(req: Request, u=Depends(core.current_user)):
    d = await req.json()
    shares = [s for s in visible_shares(u) if s["level"] == "write"]
    if d.get("share"):
        shares = [s for s in shares if s["id"] == int(d["share"])]
    for s in shares:
        t = core.share_root(s) / core.TRASH_DIR
        if t.is_dir():
            shutil.rmtree(t, ignore_errors=True)
    core.audit(req, u, "corbeille.videe", ",".join(s["name"] for s in shares))
    return {"ok": True}

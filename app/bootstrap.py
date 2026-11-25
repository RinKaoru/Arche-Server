"""Premier démarrage : crée le compte administrateur et les dossiers de départ. Idempotent.

Usage, une fois après l'installation :
    ARCHE_ADMIN_USER=alice ARCHE_ADMIN_NAME=Alice python -m app.bootstrap
Sans variables, le compte s'appelle « admin ». Le mot de passe initial est écrit dans
/var/lib/nas/identifiants-initiaux.txt : il faut le changer à la première connexion.
"""
import os

from . import core, db
from .routes.admin import create_user

db.init()
creds = []
ADMIN = os.environ.get("ARCHE_ADMIN_USER", "admin")
ADMIN_NAME = os.environ.get("ARCHE_ADMIN_NAME", ADMIN.capitalize())


def user(username, display, role, smb=True, perms=None):
    u = db.one("SELECT id FROM users WHERE username=?", username)
    if u:
        return u["id"]
    uid, pw = create_user(username, display, role, perms, smb)
    creds.append((username, display, role, pw))
    return uid


def group(name, desc, members):
    g = db.one("SELECT id FROM groups WHERE name=?", name)
    gid = g["id"] if g else db.run("INSERT INTO groups(name,description) VALUES(?,?)", name, desc)
    for m in members:
        db.run("INSERT OR IGNORE INTO group_members(group_id,user_id) VALUES(?,?)", gid, m)
    return gid


def share(name, path, desc, icon, perms, kind="standard", photos=0, smb=1, owner=None, tm=1000):
    s = db.one("SELECT id FROM shares WHERE path=?", path)
    if s:
        return s["id"]
    sid = db.run("INSERT INTO shares(name,path,description,kind,owner_id,smb,photos,tm_size_gb,icon,created_at) "
                 "VALUES(?,?,?,?,?,?,?,?,?,?)", name, path, desc, kind, owner, smb, photos, tm, icon, db.now())
    for st, sid_, lvl in perms:
        db.run("INSERT OR IGNORE INTO share_perms VALUES(?,?,?,?)", sid, st, sid_, lvl)
    core.helper("fix-perms", path)
    return sid


admin_id = user(ADMIN, ADMIN_NAME, "admin")
famille = group("Famille", "Les membres de la famille", [admin_id])

share("Famille", "famille", "Documents communs de la famille", "house", [("group", famille, "write")], photos=1)
share("Photos", "photos", "Photos et vidéos", "image", [("group", famille, "write")], photos=1)
share("Medias", "medias", "Films, séries et musique", "film", [("group", famille, "write")])
share("Projets", "projets", "Projets personnels", "code", [])
share("Partages", "partages", "Dossiers partagés créés par chacun", "share-2", [("group", famille, "read")])
share("Sauvegardes", "backups", "Sauvegardes", "archive", [])
core.sync_samba()

if creds:
    with open("/var/lib/nas/identifiants-initiaux.txt", "a") as f:
        for c in creds:
            f.write(f"{c[0]:<14} {c[1]:<14} {c[2]:<8} {c[3]}\n")
print("bootstrap OK")

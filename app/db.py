"""Base SQLite + schéma + petites aides."""
import json
import sqlite3
import threading
import time
from contextlib import contextmanager

DB_PATH = "/var/lib/nas/nas.db"
_local = threading.local()

SCHEMA = """
PRAGMA journal_mode=WAL;
CREATE TABLE IF NOT EXISTS users(
  id INTEGER PRIMARY KEY, username TEXT UNIQUE NOT NULL, display_name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'membre', perms TEXT NOT NULL DEFAULT '{}',
  pw_hash TEXT NOT NULL, must_change INTEGER NOT NULL DEFAULT 1,
  totp_secret TEXT, totp_enabled INTEGER NOT NULL DEFAULT 0,
  smb_enabled INTEGER NOT NULL DEFAULT 1, disabled INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL, last_login INTEGER, prefs TEXT NOT NULL DEFAULT '{}');
CREATE TABLE IF NOT EXISTS groups(
  id INTEGER PRIMARY KEY, name TEXT UNIQUE NOT NULL, description TEXT NOT NULL DEFAULT '');
CREATE TABLE IF NOT EXISTS group_members(
  group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, PRIMARY KEY(group_id,user_id));
CREATE TABLE IF NOT EXISTS shares(
  id INTEGER PRIMARY KEY, name TEXT UNIQUE NOT NULL, path TEXT UNIQUE NOT NULL,
  description TEXT NOT NULL DEFAULT '', kind TEXT NOT NULL DEFAULT 'standard',
  owner_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  smb INTEGER NOT NULL DEFAULT 1, photos INTEGER NOT NULL DEFAULT 0, tm_size_gb INTEGER NOT NULL DEFAULT 1000,
  icon TEXT NOT NULL DEFAULT 'folder', created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS share_perms(
  share_id INTEGER NOT NULL REFERENCES shares(id) ON DELETE CASCADE,
  subject_type TEXT NOT NULL, subject_id INTEGER NOT NULL, level TEXT NOT NULL,
  PRIMARY KEY(share_id, subject_type, subject_id));
CREATE TABLE IF NOT EXISTS sessions(
  token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created INTEGER NOT NULL, expires INTEGER NOT NULL, last_seen INTEGER NOT NULL, ip TEXT, ua TEXT);
CREATE TABLE IF NOT EXISTS links(
  id INTEGER PRIMARY KEY, token TEXT UNIQUE NOT NULL, share_id INTEGER NOT NULL REFERENCES shares(id) ON DELETE CASCADE,
  relpath TEXT NOT NULL, created_by INTEGER REFERENCES users(id) ON DELETE CASCADE, created_at INTEGER NOT NULL,
  expires_at INTEGER, pw_hash TEXT, downloads INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS photos(
  id INTEGER PRIMARY KEY, share_id INTEGER NOT NULL REFERENCES shares(id) ON DELETE CASCADE,
  relpath TEXT NOT NULL, taken_at INTEGER NOT NULL, mtime INTEGER NOT NULL, size INTEGER NOT NULL,
  width INTEGER, height INTEGER, is_video INTEGER NOT NULL DEFAULT 0, lat REAL, lon REAL,
  sha1 TEXT, seen INTEGER NOT NULL DEFAULT 0, UNIQUE(share_id, relpath));
CREATE INDEX IF NOT EXISTS photos_taken ON photos(taken_at DESC);
CREATE INDEX IF NOT EXISTS photos_sha ON photos(sha1);
CREATE TABLE IF NOT EXISTS albums(
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL, cover_photo_id INTEGER);
CREATE TABLE IF NOT EXISTS album_photos(
  album_id INTEGER NOT NULL REFERENCES albums(id) ON DELETE CASCADE,
  photo_id INTEGER NOT NULL REFERENCES photos(id) ON DELETE CASCADE, added_at INTEGER NOT NULL,
  PRIMARY KEY(album_id, photo_id));
CREATE TABLE IF NOT EXISTS album_members(
  album_id INTEGER NOT NULL REFERENCES albums(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, PRIMARY KEY(album_id, user_id));
CREATE TABLE IF NOT EXISTS notifications(
  id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  level TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '', link TEXT,
  created_at INTEGER NOT NULL, read INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS push_subs(
  id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint TEXT UNIQUE NOT NULL, p256dh TEXT NOT NULL, auth TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS alerts(
  key TEXT PRIMARY KEY, level TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL,
  active INTEGER NOT NULL, since INTEGER NOT NULL, updated INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS audit(
  id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, user_id INTEGER, username TEXT, action TEXT NOT NULL,
  target TEXT NOT NULL DEFAULT '', detail TEXT NOT NULL DEFAULT '', ip TEXT);
CREATE INDEX IF NOT EXISTS audit_ts ON audit(ts DESC);
CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS github_repos(
  full_name TEXT PRIMARY KEY, private INTEGER, last_sync INTEGER, status TEXT, detail TEXT, size INTEGER);
CREATE TABLE IF NOT EXISTS favorites(user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  share_id INTEGER NOT NULL REFERENCES shares(id) ON DELETE CASCADE, relpath TEXT NOT NULL, created_at INTEGER NOT NULL,
  PRIMARY KEY(user_id, share_id, relpath));
CREATE TABLE IF NOT EXISTS activity(id INTEGER PRIMARY KEY, user_id INTEGER, share_id INTEGER, relpath TEXT NOT NULL,
  action TEXT NOT NULL, ts INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS activity_user ON activity(user_id, ts DESC);
CREATE TABLE IF NOT EXISTS totp_devices(id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL, secret TEXT NOT NULL, created_at INTEGER NOT NULL, last_used INTEGER);
CREATE TABLE IF NOT EXISTS usage(user_id INTEGER NOT NULL, page TEXT NOT NULL, last_used INTEGER NOT NULL,
  PRIMARY KEY(user_id, page));
"""

DEFAULT_SETTINGS = {
    "app_name": "Arche",
    "require_2fa_admin": True,
    "public_url": "",  # vide = adresse du navigateur (ou Réglages)
    "github": {"token": "", "owners": [], "enabled": False},
}


def conn() -> sqlite3.Connection:
    c = getattr(_local, "c", None)
    if c is None:
        c = sqlite3.connect(DB_PATH, timeout=30, isolation_level=None)
        c.row_factory = sqlite3.Row
        c.execute("PRAGMA foreign_keys=ON")
        c.execute("PRAGMA busy_timeout=30000")
        _local.c = c
    return c


MIGRATIONS = [
    "ALTER TABLE links ADD COLUMN kind TEXT NOT NULL DEFAULT 'share'",
    "ALTER TABLE links ADD COLUMN title TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE links ADD COLUMN message TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE links ADD COLUMN allow_upload INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE links ADD COLUMN uploads INTEGER NOT NULL DEFAULT 0",
]


def init():
    c = conn()
    c.executescript(SCHEMA)
    cols = {r["name"] for r in c.execute("PRAGMA table_info(links)").fetchall()}
    for m in MIGRATIONS:
        col = m.split("ADD COLUMN ")[1].split()[0]
        if col not in cols:
            c.execute(m)
    # 2FA : migration de l'ancien secret unique vers la liste d'appareils
    for u in c.execute("SELECT id, totp_secret FROM users WHERE totp_enabled=1 AND totp_secret IS NOT NULL").fetchall():
        if not c.execute("SELECT 1 FROM totp_devices WHERE user_id=?", (u["id"],)).fetchone():
            c.execute("INSERT INTO totp_devices(user_id,name,secret,created_at) VALUES(?,?,?,?)",
                      (u["id"], "Appareil principal", u["totp_secret"], int(time.time())))
            c.execute("UPDATE users SET totp_secret=NULL WHERE id=?", (u["id"],))
    for k, v in DEFAULT_SETTINGS.items():
        c.execute("INSERT OR IGNORE INTO settings(key,value) VALUES(?,?)", (k, json.dumps(v)))


def q(sql, *args):
    return [dict(r) for r in conn().execute(sql, args).fetchall()]


def one(sql, *args):
    r = conn().execute(sql, args).fetchone()
    return dict(r) if r else None


def run(sql, *args):
    cur = conn().execute(sql, args)
    return cur.lastrowid


@contextmanager
def tx():
    c = conn()
    c.execute("BEGIN IMMEDIATE")
    try:
        yield c
        c.execute("COMMIT")
    except Exception:
        c.execute("ROLLBACK")
        raise


def get_setting(key):
    r = one("SELECT value FROM settings WHERE key=?", key)
    return json.loads(r["value"]) if r else DEFAULT_SETTINGS.get(key)


def set_setting(key, value):
    run("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        key, json.dumps(value))


def now() -> int:
    return int(time.time())

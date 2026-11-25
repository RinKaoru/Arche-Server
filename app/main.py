"""App NAS — point d'entrée FastAPI."""
import logging
import re
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.exceptions import HTTPException
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from . import db, jobs
from .routes import admin, auth, drive, files, links, mobile, photos, sync

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")
STATIC = Path(__file__).resolve().parent.parent / "static"

app = FastAPI(title="NAS", docs_url=None, redoc_url=None, openapi_url=None)
for m in (auth, drive, files, links, photos, admin, sync, mobile):
    app.include_router(m.r)


@app.on_event("startup")
def startup():
    db.init()
    jobs.start()


@app.middleware("http")
async def security_headers(req: Request, call_next):
    from .core import banned_ips, client_ip
    if client_ip(req) in banned_ips():
        return JSONResponse({"detail": "Trop de tentatives : accès bloqué temporairement."}, status_code=403)
    resp = await call_next(req)
    resp.headers.setdefault("X-Content-Type-Options", "nosniff")
    resp.headers.setdefault("Referrer-Policy", "same-origin")
    resp.headers.setdefault("X-Frame-Options", "SAMEORIGIN")
    resp.headers.setdefault("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()")
    resp.headers.setdefault("Cross-Origin-Opener-Policy", "same-origin")
    if req.url.path.startswith("/api/"):
        resp.headers.setdefault("Cache-Control", "no-store")
    elif req.url.path.startswith("/static/") and not req.url.path.startswith(("/static/vendor/", "/static/icons/")):
        # scripts / styles de l'app : toujours revérifiés (réponse 304 si inchangés), sinon le navigateur peut mélanger
        # une ancienne version d'un module avec la nouvelle feuille de style
        resp.headers["Cache-Control"] = "no-cache"
    elif "text/html" in resp.headers.get("content-type", ""):
        resp.headers.setdefault("Content-Security-Policy", CSP)
    return resp


CSP = ("default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
       "img-src 'self' data: blob: https://*.basemaps.cartocdn.com; media-src 'self' blob:; font-src 'self'; "
       "connect-src 'self'; frame-src 'self'; worker-src 'self'; manifest-src 'self'; object-src 'none'; "
       "base-uri 'self'; form-action 'self'; frame-ancestors 'self'")


@app.get("/manifest.webmanifest")
def manifest():
    name = db.get_setting("app_name")
    return JSONResponse({
        "name": name, "short_name": name, "start_url": "/", "scope": "/", "display": "standalone",
        "background_color": "#09090B", "theme_color": "#09090B", "lang": "fr",
        "description": "Le NAS de la famille",
        "icons": [{"src": "/static/icons/icon-192.png", "sizes": "192x192", "type": "image/png"},
                  {"src": "/static/icons/icon-512.png", "sizes": "512x512", "type": "image/png"},
                  {"src": "/static/icons/icon-maskable.png", "sizes": "512x512", "type": "image/png", "purpose": "maskable"}],
        "shortcuts": [{"name": "Fichiers", "url": "/fichiers"}, {"name": "Photos", "url": "/photos"},
                      {"name": "Sauvegarder mes photos", "url": "/photos?backup=1"}],
    }, media_type="application/manifest+json")


@app.get("/sw.js")
def sw():
    return FileResponse(STATIC / "sw.js", media_type="text/javascript", headers={"Cache-Control": "no-cache"})


app.mount("/static", StaticFiles(directory=STATIC), name="static")


APP_ROUTES = re.compile(r"^/(|fichiers|partages|recents|favoris|photos|albums(/\d+)?|transferts|liens|notifications|corbeille|compte|guide|synchro"
                        r"|admin(/(disques|reseau|comptes|partages|snapshots|github|docker|audit|reglages))?|s/[A-Za-z0-9_-]{6,64})/?$")


@app.exception_handler(404)
async def spa(req: Request, exc):
    # Seules les vraies pages de l'app renvoient l'interface ; tout le reste (robots : /.env, /wp-admin…) = 404 sec.
    if req.method == "GET" and APP_ROUTES.match(req.url.path):
        return FileResponse(STATIC / "index.html", headers={"Cache-Control": "no-cache"})
    detail = exc.detail if isinstance(exc, HTTPException) else "Introuvable."
    return JSONResponse({"detail": detail}, status_code=404)

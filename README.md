# Arche — a family NAS you run yourself

**Arche** turns a home computer with a few disks into a private family cloud: shared folders,
photo library with automatic phone backup, file sharing links, Windows/Mac network drives,
daily snapshots, two-factor authentication and a Discord alert channel. It is a single
FastAPI server with a plain JavaScript web app (no build step), designed to feel like the
consumer cloud services your family already knows.

> Français : **Arche** est un NAS familial auto-hébergé : dossiers partagés, sauvegarde automatique
> des photos du téléphone, liens de partage, lecteurs réseau Windows/Mac, snapshots quotidiens,
> double authentification et alertes Discord. Voir la section [Français](#français) plus bas.

> **Status: early.** The server runs in daily use, but there is no one-command installer yet.
> Installing it today means following the manual steps below. Contributions and feedback are welcome.

## Features
- Files, shared folders and per-user / per-group permissions
- Photo library by date and albums; the Android app backs up phone photos and videos
- Share links and upload links, with optional expiry
- Samba shares for Windows and Mac (including Time Machine)
- Trash, file versions from daily snapshots (hard links, no duplicated data)
- Two-factor authentication (TOTP), audit log, rate limiting, automatic IP bans
- Alerts for disks, RAID, storage, services and backups; optional Discord notifications
- Optional: GitHub repository backup, Docker project view, Tailscale and Syncthing status

## Architecture
| Part | Where | Notes |
|------|-------|-------|
| API + web app | `app/`, `static/` | FastAPI + SQLite; vanilla JS modules served as-is |
| Root helper | `nas-helper` (called through `sudo`) | Does the operations that need root: users, Samba, snapshots, permissions |
| Android app | separate repository, `arche-android` | WebView + background photo backup |
| Reverse proxy | Caddy (recommended) | HTTPS; forwards `X-Nas-Edge` for requests that came through a CDN |

## Requirements
- Debian 12 or 13 (other systemd-based distributions should work, untested)
- Python 3.13 with a virtual environment
- Samba, Caddy, smartmontools, mdadm (if you use RAID), systemd timers
- A storage directory (default `/srv/storage`) on a disk or RAID array

## Installation (manual, for now)

The `deploy/` folder holds the pieces that run outside the app:

| Path | Goes to | What it does |
|------|---------|--------------|
| `deploy/sbin/nas-helper` | `/usr/local/sbin/nas-helper` | Root actions, whitelisted. The app calls it through sudo. |
| `deploy/sudoers/nas-helper` | `/etc/sudoers.d/nas-helper` | Lets the `nas` user run only that helper as root. |
| `deploy/sbin/nas-snapshot`, `nas-sysbackup`, `nas-alert` | `/usr/local/sbin/`, `/usr/local/bin/` | Daily snapshots, system backup, alert log |
| `deploy/systemd/*` | `/etc/systemd/system/` | App service, snapshot timer, Syncthing service |

Assumed layout: the app in `/opt/nas-app`, a `nas` system user, the data disk mounted on `/srv/storage`,
state in `/var/lib/nas`. Adjust the units if yours differ. Then run `systemctl daemon-reload` and
`python -m app.bootstrap`.

## Configuration (environment variables)
| Variable | Default | Purpose |
|----------|---------|---------|
| `ARCHE_LAN_NETS` | `10.0.0.0/8,172.16.0.0/12,192.168.0.0/16` | Networks considered "at home" (admin pages are home-only). Narrow it to your subnet, e.g. `192.168.1.0/24`. |
| `ARCHE_LAN_HOST` | empty | LAN IP of the server, given to the Android app for local access |
| `ARCHE_CONTACT_EMAIL` | `admin@example.com` | Contact address sent with push notifications (VAPID) |
| `ARCHE_ADMIN_USER` | `admin` | Login of the first administrator, created by `python -m app.bootstrap` |
| `ARCHE_ADMIN_NAME` | same as the login | Display name of the first administrator |

The public address (`https://your-domain`) is set in the admin settings.

## First start
```sh
python -m app.bootstrap        # creates the admin account and the starting folders (idempotent)
```
The initial password is written to `/var/lib/nas/identifiants-initiaux.txt`. Change it at the first login
and delete that file.

## Security notes
- Admin pages and API keys are reachable only from the home network. Remote access should go through
  HTTPS plus two-factor authentication, or through a VPN.
- `nas-helper` runs as root through a narrow `sudo` rule (`deploy/sudoers/nas-helper`). Review it before you install it.
- Never commit `.env` files, keys or the `identifiants-*.txt` file. `.gitignore` covers the usual ones.

## Roadmap
- One-command installer and a guide for Debian
- Full English interface (the interface is currently French)
- Configuration through a single file instead of environment variables

## Licence
GNU AGPL-3.0 (see `LICENSE`). If you run a modified Arche for other people over a network,
you must publish your changes under the same licence.

---

## Français

**Arche** transforme un ordinateur de la maison et quelques disques en cloud familial privé :
dossiers partagés, photos avec sauvegarde automatique du téléphone, liens de partage, lecteurs
réseau Windows et Mac, snapshots quotidiens, double authentification et alertes Discord.

**État : début.** Le serveur tourne au quotidien, mais il n'y a pas encore d'installateur en une commande :
il faut suivre les étapes manuelles. Les retours et contributions sont bienvenus.

Configuration : voir le tableau ci-dessus (`ARCHE_LAN_NETS`, `ARCHE_ADMIN_USER`…). Premier démarrage :
`python -m app.bootstrap`, puis changer le mot de passe initial. Les administrateurs ne sont accessibles
que depuis le réseau de la maison ; pour l'accès distant, passe par HTTPS et la double authentification, ou par un VPN.

Licence : AGPL-3.0.

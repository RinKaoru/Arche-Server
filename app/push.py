"""Notifications push Web (PWA) via VAPID."""
import base64
import json
import logging
import os

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec
from pywebpush import webpush, WebPushException

from . import db

KEY_PATH = "/var/lib/nas/push/vapid_private.pem"
log = logging.getLogger("nas.push")


def _load():
    if not os.path.exists(KEY_PATH):
        key = ec.generate_private_key(ec.SECP256R1())
        pem = key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
                                serialization.NoEncryption())
        os.makedirs(os.path.dirname(KEY_PATH), exist_ok=True)
        with open(KEY_PATH, "wb") as f:
            f.write(pem)
        os.chmod(KEY_PATH, 0o600)
    with open(KEY_PATH, "rb") as f:
        return serialization.load_pem_private_key(f.read(), None)


def public_key() -> str:
    pub = _load().public_key().public_bytes(serialization.Encoding.X962,
                                            serialization.PublicFormat.UncompressedPoint)
    return base64.urlsafe_b64encode(pub).decode().rstrip("=")


def send_to_users(user_ids, title, body="", link=None):
    if not user_ids:
        return
    marks = ",".join("?" * len(user_ids))
    subs = db.q(f"SELECT * FROM push_subs WHERE user_id IN ({marks})", *user_ids)
    payload = json.dumps({"title": title, "body": body, "link": link or "/"})
    for s in subs:
        try:
            webpush({"endpoint": s["endpoint"], "keys": {"p256dh": s["p256dh"], "auth": s["auth"]}},
                    payload, vapid_private_key=KEY_PATH,
                    vapid_claims={"sub": "mailto:" + os.environ.get("ARCHE_CONTACT_EMAIL", "admin@example.com")}, ttl=86400)
        except WebPushException as e:
            code = getattr(e.response, "status_code", None)
            if code in (404, 410):
                db.run("DELETE FROM push_subs WHERE id=?", s["id"])
            else:
                log.warning("push échoué: %s", e)
        except Exception as e:  # noqa
            log.warning("push échoué: %s", e)

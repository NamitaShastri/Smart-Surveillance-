"""Password hashing, signed tokens and login throttling (standard library only)."""
import base64
import hashlib
import hmac
import json
import os
import secrets
import time

from fastapi import HTTPException

# Set SENTINEL_SECRET_KEY in your environment so tokens survive restarts.  EE3T_bT6Uxxv9g2RwUQTvf1L-hvUaGRCP55cin269G5tGk5uglKCKbHVK0ZSVOHD    2nd value =OkmVGyR5d9VvkonV9wykJ0d1LqoUzmHCCaQlUYMf_2FjVDYvjbRj4rq7Uep5b6WN 
SECRET_KEY = os.environ.get("SENTINEL_SECRET_KEY") or secrets.token_urlsafe(48)
if not os.environ.get("SENTINEL_SECRET_KEY"):
    print("WARNING: SENTINEL_SECRET_KEY is not set; sign-ins reset whenever the server restarts.")

# Shared secret for the YOLO pipeline (sent as the X-API-Key header).
PIPELINE_KEY = os.environ.get("SENTINEL_PIPELINE_KEY")
if not PIPELINE_KEY:
    print("WARNING: SENTINEL_PIPELINE_KEY is not set; the pipeline endpoints are open (dev mode).")

ACCESS_TTL = 12 * 60 * 60
MEDIA_TTL = 5 * 60
ITERATIONS = 600_000


def hash_password(password: str) -> str:
    salt = os.urandom(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, ITERATIONS)
    return f"pbkdf2_sha256${ITERATIONS}${salt.hex()}${digest.hex()}"


def verify_password(password: str, stored: str) -> bool:
    try:
        _, iterations, salt, digest = stored.split("$")
        candidate = hashlib.pbkdf2_hmac("sha256", password.encode(), bytes.fromhex(salt), int(iterations))
        return hmac.compare_digest(candidate.hex(), digest)
    except (ValueError, TypeError):
        return False


# Verified when the email is unknown, so response time doesn't reveal which emails exist.
DUMMY_HASH = hash_password("not-a-real-password")


def _b64(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()


def _sign(body: str) -> str:
    return _b64(hmac.new(SECRET_KEY.encode(), body.encode(), hashlib.sha256).digest())


def make_token(sub: int, scope: str = "access", ttl: int = ACCESS_TTL, **extra) -> str:
    payload = {"sub": sub, "scope": scope, "exp": int(time.time()) + ttl, **extra}
    body = _b64(json.dumps(payload, separators=(",", ":")).encode())
    return f"{body}.{_sign(body)}"


def read_token(token: str, scope: str = "access") -> dict | None:
    try:
        body, signature = token.split(".")
        if not hmac.compare_digest(signature, _sign(body)):
            return None
        payload = json.loads(base64.urlsafe_b64decode(body + "=" * (-len(body) % 4)))
        if payload.get("scope") != scope or payload["exp"] < time.time():
            return None
        return payload
    except Exception:
        return None


# ---- login throttling: 5 failures per email per 15 minutes (in memory) ----
_failures: dict[str, list[float]] = {}
WINDOW, MAX_FAILURES = 15 * 60, 5


def check_throttle(key: str) -> None:
    now = time.time()
    recent = [t for t in _failures.get(key, []) if now - t < WINDOW]
    _failures[key] = recent
    if len(recent) >= MAX_FAILURES:
        raise HTTPException(status_code=429, detail="Too many failed attempts. Try again in 15 minutes.")


def record_failure(key: str) -> None:
    _failures.setdefault(key, []).append(time.time())


def clear_failures(key: str) -> None:
    _failures.pop(key, None)
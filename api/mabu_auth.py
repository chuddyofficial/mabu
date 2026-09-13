"""
mabu_auth.py — single-admin authentication for MABU.

Design:
  - Exactly one admin account, created once during setup (setup.py).
  - Credentials stored in config/admin.json: {"username", "password_hash"}.
  - password_hash is a bcrypt hash — never plaintext, never reversible.
  - Session secret stored separately in config/session-secret.key, used to
    sign Flask's session cookie (HttpOnly, SameSite=Lax).
  - Neither config/admin.json nor config/session-secret.key should ever be
    committed to git (see .gitignore).

This module intentionally has no "forgot password" flow — if you lose the
admin password, re-run setup.py to reset it (that requires filesystem
access to the server, which is the correct recovery boundary for a
single-admin local/VPS tool).
"""

import json
import os
import secrets

import bcrypt

CONFIG_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "config")
ADMIN_FILE = os.path.join(CONFIG_DIR, "admin.json")
SESSION_SECRET_FILE = os.path.join(CONFIG_DIR, "session-secret.key")


def is_configured() -> bool:
    """True once setup.py has created an admin account."""
    return os.path.isfile(ADMIN_FILE)


def create_admin(username: str, password: str) -> None:
    if not username or not password:
        raise ValueError("username and password are required")
    if len(password) < 8:
        raise ValueError("password must be at least 8 characters")

    os.makedirs(CONFIG_DIR, exist_ok=True)
    password_hash = bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt())

    with open(ADMIN_FILE, "w", encoding="utf-8") as f:
        json.dump({"username": username, "password_hash": password_hash.decode("utf-8")}, f, indent=2)

    # Lock down permissions where the OS supports it (no-op on Windows).
    try:
        os.chmod(ADMIN_FILE, 0o600)
    except OSError:
        pass


def verify_login(username: str, password: str) -> bool:
    if not is_configured():
        return False
    with open(ADMIN_FILE, "r", encoding="utf-8") as f:
        admin = json.load(f)

    if not secrets.compare_digest(username, admin["username"]):
        return False

    return bcrypt.checkpw(password.encode("utf-8"), admin["password_hash"].encode("utf-8"))


def get_admin_username() -> str | None:
    if not is_configured():
        return None
    with open(ADMIN_FILE, "r", encoding="utf-8") as f:
        return json.load(f)["username"]


def change_password(current_password: str, new_password: str) -> None:
    if not is_configured():
        raise ValueError("No admin account configured yet")
    with open(ADMIN_FILE, "r", encoding="utf-8") as f:
        admin = json.load(f)

    if not bcrypt.checkpw(current_password.encode("utf-8"), admin["password_hash"].encode("utf-8")):
        raise ValueError("Current password is incorrect")
    if len(new_password) < 8:
        raise ValueError("password must be at least 8 characters")

    admin["password_hash"] = bcrypt.hashpw(new_password.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")
    with open(ADMIN_FILE, "w", encoding="utf-8") as f:
        json.dump(admin, f, indent=2)


def get_or_create_session_secret() -> str:
    if os.path.isfile(SESSION_SECRET_FILE):
        with open(SESSION_SECRET_FILE, "r", encoding="utf-8") as f:
            return f.read().strip()

    os.makedirs(CONFIG_DIR, exist_ok=True)
    secret = secrets.token_hex(32)
    with open(SESSION_SECRET_FILE, "w", encoding="utf-8") as f:
        f.write(secret)
    try:
        os.chmod(SESSION_SECRET_FILE, 0o600)
    except OSError:
        pass
    return secret

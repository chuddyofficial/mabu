"""
mabu_auth.py — multi-user authentication and access control for MABU.

Design:
  - Users stored in config/users.json: a list of
    {"user_id", "username", "password_hash", "role", "created", "active"}.
  - password_hash is bcrypt — never plaintext, never reversible.
  - Two roles: "admin" (manage users, full case access) and "investigator"
    (full case CRUD, no user management).
  - Session secret stored separately in config/session-secret.key.
  - Login attempts are rate-limited per username+IP to slow brute-forcing.
  - Every security-relevant action is appended to the audit log
    (config/audit.log, JSON-lines) — logins, failed logins, user changes,
    password changes.

Legacy compatibility: deployments created before multi-user support have a
single config/admin.json ({"username", "password_hash"}). On first access
here, that file is transparently migrated into config/users.json as the
sole "admin" user, and config/admin.json is renamed to admin.json.migrated
so it's not left lying around with live credentials in an old format.

There is intentionally no "forgot password" flow — recovery requires
filesystem access to the server (re-run setup.py or use the CLI reset),
which is the correct boundary for this kind of tool.
"""

import json
import os
import secrets
import time
import uuid

import bcrypt

CONFIG_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "config")
USERS_FILE = os.path.join(CONFIG_DIR, "users.json")
LEGACY_ADMIN_FILE = os.path.join(CONFIG_DIR, "admin.json")
SESSION_SECRET_FILE = os.path.join(CONFIG_DIR, "session-secret.key")
AUDIT_LOG_FILE = os.path.join(CONFIG_DIR, "audit.log")

ROLES = ("admin", "investigator")

# Login rate limiting: after MAX_ATTEMPTS failures within WINDOW_SECONDS for a
# given (username, ip) pair, further attempts are refused until the window
# elapses. In-memory only — resets on server restart, which is an acceptable
# tradeoff for a single-process deployment.
MAX_LOGIN_ATTEMPTS = 5
LOGIN_WINDOW_SECONDS = 300
_login_attempts: dict[str, list[float]] = {}


def _lock_down(path: str):
    try:
        os.chmod(path, 0o600)
    except OSError:
        pass


def _load_users() -> list[dict]:
    _migrate_legacy_admin_if_needed()
    if not os.path.isfile(USERS_FILE):
        return []
    with open(USERS_FILE, "r", encoding="utf-8") as f:
        return json.load(f)


def _save_users(users: list[dict]):
    os.makedirs(CONFIG_DIR, exist_ok=True)
    with open(USERS_FILE, "w", encoding="utf-8") as f:
        json.dump(users, f, indent=2)
    _lock_down(USERS_FILE)


def _migrate_legacy_admin_if_needed():
    if os.path.isfile(USERS_FILE) or not os.path.isfile(LEGACY_ADMIN_FILE):
        return
    with open(LEGACY_ADMIN_FILE, "r", encoding="utf-8") as f:
        legacy = json.load(f)

    users = [{
        "user_id": uuid.uuid4().hex,
        "username": legacy["username"],
        "password_hash": legacy["password_hash"],
        "role": "admin",
        "created": time.strftime("%Y-%m-%dT%H:%M:%S+00:00", time.gmtime()),
        "active": True,
    }]
    os.makedirs(CONFIG_DIR, exist_ok=True)
    with open(USERS_FILE, "w", encoding="utf-8") as f:
        json.dump(users, f, indent=2)
    _lock_down(USERS_FILE)

    os.rename(LEGACY_ADMIN_FILE, LEGACY_ADMIN_FILE + ".migrated")
    log_audit("system", "migrated_legacy_admin", f"Migrated single-admin account '{legacy['username']}' to multi-user store")


# ---------------------------------------------------------------------------
# Setup / status
# ---------------------------------------------------------------------------

def is_configured() -> bool:
    """True once at least one user account exists."""
    return len(_load_users()) > 0


def get_admin_username() -> str | None:
    """Back-compat helper: returns the first admin-role username, if any."""
    for u in _load_users():
        if u["role"] == "admin":
            return u["username"]
    return None


# ---------------------------------------------------------------------------
# User management
# ---------------------------------------------------------------------------

def create_admin(username: str, password: str) -> None:
    """Back-compat entry point used by setup.py — creates the first admin user."""
    create_user(username, password, role="admin", actor="setup")


def create_user(username: str, password: str, role: str = "investigator", actor: str | None = None) -> dict:
    if not username or not password:
        raise ValueError("username and password are required")
    if len(password) < 8:
        raise ValueError("password must be at least 8 characters")
    if role not in ROLES:
        raise ValueError(f"role must be one of {ROLES}")

    users = _load_users()
    if any(u["username"].lower() == username.lower() for u in users):
        raise ValueError(f"a user named '{username}' already exists")

    password_hash = bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")
    user = {
        "user_id": uuid.uuid4().hex,
        "username": username,
        "password_hash": password_hash,
        "role": role,
        "created": time.strftime("%Y-%m-%dT%H:%M:%S+00:00", time.gmtime()),
        "active": True,
    }
    users.append(user)
    _save_users(users)
    log_audit(actor or username, "user_created", f"{username} (role={role})")
    return {k: v for k, v in user.items() if k != "password_hash"}


def list_users() -> list[dict]:
    return [{k: v for k, v in u.items() if k != "password_hash"} for u in _load_users()]


def set_user_active(username: str, active: bool, actor: str) -> None:
    users = _load_users()
    for u in users:
        if u["username"].lower() == username.lower():
            u["active"] = active
            _save_users(users)
            log_audit(actor, "user_deactivated" if not active else "user_reactivated", username)
            return
    raise ValueError(f"no such user: {username}")


def delete_user(username: str, actor: str) -> None:
    users = _load_users()
    remaining = [u for u in users if u["username"].lower() != username.lower()]
    if len(remaining) == len(users):
        raise ValueError(f"no such user: {username}")
    if not any(u["role"] == "admin" for u in remaining):
        raise ValueError("cannot delete the last admin account")
    _save_users(remaining)
    log_audit(actor, "user_deleted", username)


def set_user_role(username: str, role: str, actor: str) -> None:
    if role not in ROLES:
        raise ValueError(f"role must be one of {ROLES}")
    users = _load_users()
    target = next((u for u in users if u["username"].lower() == username.lower()), None)
    if not target:
        raise ValueError(f"no such user: {username}")
    if target["role"] == "admin" and role != "admin":
        remaining_admins = [u for u in users if u["role"] == "admin" and u["username"].lower() != username.lower()]
        if not remaining_admins:
            raise ValueError("cannot demote the last admin account")
    target["role"] = role
    _save_users(users)
    log_audit(actor, "user_role_changed", f"{username} -> {role}")


# ---------------------------------------------------------------------------
# Login / rate limiting
# ---------------------------------------------------------------------------

def _rate_limit_key(username: str, ip: str) -> str:
    return f"{username.lower()}|{ip}"


def is_rate_limited(username: str, ip: str) -> bool:
    key = _rate_limit_key(username, ip)
    now = time.time()
    attempts = [t for t in _login_attempts.get(key, []) if now - t < LOGIN_WINDOW_SECONDS]
    _login_attempts[key] = attempts
    return len(attempts) >= MAX_LOGIN_ATTEMPTS


def _record_failed_attempt(username: str, ip: str):
    key = _rate_limit_key(username, ip)
    _login_attempts.setdefault(key, []).append(time.time())


def _clear_attempts(username: str, ip: str):
    _login_attempts.pop(_rate_limit_key(username, ip), None)


def verify_login(username: str, password: str, ip: str = "unknown") -> dict | None:
    """Returns the user dict (without password_hash) on success, else None."""
    if is_rate_limited(username, ip):
        log_audit(username, "login_rate_limited", f"ip={ip}")
        return None

    users = _load_users()
    match = next((u for u in users if secrets.compare_digest(u["username"].lower(), username.lower())), None)

    if not match or not match.get("active", True):
        _record_failed_attempt(username, ip)
        log_audit(username, "login_failed", f"ip={ip} reason={'no_such_user' if not match else 'inactive'}")
        return None

    if not bcrypt.checkpw(password.encode("utf-8"), match["password_hash"].encode("utf-8")):
        _record_failed_attempt(username, ip)
        log_audit(username, "login_failed", f"ip={ip} reason=bad_password")
        return None

    _clear_attempts(username, ip)
    match["last_login"] = time.strftime("%Y-%m-%dT%H:%M:%S+00:00", time.gmtime())
    _save_users(users)
    log_audit(username, "login_success", f"ip={ip}")
    return {k: v for k, v in match.items() if k != "password_hash"}


def change_password(username: str, current_password: str, new_password: str) -> None:
    users = _load_users()
    target = next((u for u in users if u["username"].lower() == username.lower()), None)
    if not target:
        raise ValueError("no such user")
    if not bcrypt.checkpw(current_password.encode("utf-8"), target["password_hash"].encode("utf-8")):
        raise ValueError("Current password is incorrect")
    if len(new_password) < 8:
        raise ValueError("password must be at least 8 characters")

    target["password_hash"] = bcrypt.hashpw(new_password.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")
    _save_users(users)
    log_audit(username, "password_changed", "")


def admin_reset_password(username: str, new_password: str, actor: str) -> None:
    """Admin-initiated reset, no current-password check (used for locked-out users)."""
    if len(new_password) < 8:
        raise ValueError("password must be at least 8 characters")
    users = _load_users()
    target = next((u for u in users if u["username"].lower() == username.lower()), None)
    if not target:
        raise ValueError("no such user")
    target["password_hash"] = bcrypt.hashpw(new_password.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")
    _save_users(users)
    log_audit(actor, "password_reset_by_admin", username)


# ---------------------------------------------------------------------------
# Session secret
# ---------------------------------------------------------------------------

def get_or_create_session_secret() -> str:
    if os.path.isfile(SESSION_SECRET_FILE):
        with open(SESSION_SECRET_FILE, "r", encoding="utf-8") as f:
            return f.read().strip()

    os.makedirs(CONFIG_DIR, exist_ok=True)
    secret = secrets.token_hex(32)
    with open(SESSION_SECRET_FILE, "w", encoding="utf-8") as f:
        f.write(secret)
    _lock_down(SESSION_SECRET_FILE)
    return secret


# ---------------------------------------------------------------------------
# Audit log
# ---------------------------------------------------------------------------

def log_audit(actor: str, action: str, detail: str):
    os.makedirs(CONFIG_DIR, exist_ok=True)
    entry = {
        "time": time.strftime("%Y-%m-%dT%H:%M:%S+00:00", time.gmtime()),
        "actor": actor,
        "action": action,
        "detail": detail,
    }
    with open(AUDIT_LOG_FILE, "a", encoding="utf-8") as f:
        f.write(json.dumps(entry) + "\n")


def read_audit_log(limit: int = 200) -> list[dict]:
    if not os.path.isfile(AUDIT_LOG_FILE):
        return []
    with open(AUDIT_LOG_FILE, "r", encoding="utf-8") as f:
        lines = f.readlines()
    entries = [json.loads(line) for line in lines[-limit:] if line.strip()]
    entries.reverse()
    return entries

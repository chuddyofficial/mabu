"""
mabu_csrf.py — double-submit-cookie CSRF protection for MABU's session-based API.

Since the frontend already relies on a same-site session cookie for auth,
a CSRF token is generated per-session and must be echoed back in an
X-CSRF-Token header on every state-changing request (POST/PUT/DELETE).
A cookie alone can't do this because the whole point of CSRF is that a
malicious page can trigger cookie-bearing requests to us automatically —
but it cannot read the token to also set that header, since that would
require reading response content across origins (blocked by CORS/SOP).
"""

import secrets
from functools import wraps

from flask import jsonify, request, session


def get_or_create_csrf_token() -> str:
    if "csrf_token" not in session:
        session["csrf_token"] = secrets.token_hex(24)
    return session["csrf_token"]


def rotate_csrf_token() -> str:
    """Force a fresh CSRF token, e.g. on login, so a token issued before
    authentication (or to a previous user on a shared browser) can't be
    replayed against the newly-authenticated session."""
    session["csrf_token"] = secrets.token_hex(24)
    return session["csrf_token"]


def csrf_protect(view):
    @wraps(view)
    def wrapped(*args, **kwargs):
        if request.method in ("POST", "PUT", "PATCH", "DELETE"):
            token = request.headers.get("X-CSRF-Token", "")
            expected = session.get("csrf_token", "")
            if not expected or not secrets.compare_digest(token, expected):
                return jsonify({"error": "Invalid or missing CSRF token"}), 403
        return view(*args, **kwargs)
    return wrapped

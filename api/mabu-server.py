"""
MABU Server — local/VPS Flask backend for the MABU Dashboard.

Provides:
  - Multi-user authentication (admin/investigator roles, bcrypt, rate-limited
    login, CSRF-protected session cookies, audit log)
  - Case management (multi-entry cases, status, activity log, attachments,
    tags, templates, related-case suggestions)
  - Multi-case correlation engine
  - Public-record lookups (WHOIS, DNS, handle-existence, phone metadata,
    opt-in HIBP breach check)
  - PDF report generation
  - Vault listing / search / decryption

Run `python setup.py` first to create the first admin account and generate keys.
"""

import base64
import os
import socket
from datetime import datetime, timezone
from functools import wraps

from flask import Flask, jsonify, request, session, Response
from flask_cors import CORS
from cryptography.fernet import InvalidToken

import mabu_auth
import mabu_csrf
import mabu_format as fmt
import mabu_lookups
import mabu_media
import mabu_report

VAULT_DIR = fmt.vault_dir()
os.makedirs(VAULT_DIR, exist_ok=True)

# Set MABU_PUBLIC_ORIGIN to the site's public https:// origin once deployed behind
# nginx+HTTPS (e.g. "https://mabu.example.com"). This flips on the Secure cookie
# flag and restricts CORS to that exact origin instead of the permissive local-dev
# default. Leave unset for local http://127.0.0.1 development.
PUBLIC_ORIGIN = os.environ.get("MABU_PUBLIC_ORIGIN", "").rstrip("/")

app = Flask(__name__)
app.secret_key = mabu_auth.get_or_create_session_secret()
app.config.update(
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE="Lax",
    SESSION_COOKIE_SECURE=bool(PUBLIC_ORIGIN),
    PERMANENT_SESSION_LIFETIME=60 * 60 * 12,  # 12 hours
)

if PUBLIC_ORIGIN:
    # Same-origin in production: the dashboard is served by nginx on the same
    # origin as /api/, so CORS only needs to allow that one exact origin
    # (kept mainly so the API still answers sane preflights; the frontend
    # itself no longer needs cross-origin credentials once behind nginx).
    CORS(app, supports_credentials=True, origins=[PUBLIC_ORIGIN], expose_headers=["X-CSRF-Token"])
else:
    # Local dev only: index.html is often opened via file:// or a different
    # port than the Flask API, so origins are left permissive here. This
    # branch is never used once MABU_PUBLIC_ORIGIN is set for a deployment.
    CORS(app, supports_credentials=True, expose_headers=["X-CSRF-Token"])


@app.after_request
def _set_security_headers(resp):
    resp.headers["X-Content-Type-Options"] = "nosniff"
    resp.headers["Referrer-Policy"] = "same-origin"
    resp.headers["X-Frame-Options"] = "DENY"
    resp.headers["Permissions-Policy"] = "geolocation=(), microphone=(), camera=()"
    if PUBLIC_ORIGIN:
        resp.headers["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains"
    return resp


# ---------------------------------------------------------------------------
# Auth decorators
# ---------------------------------------------------------------------------

def login_required(view):
    @wraps(view)
    def wrapped(*a, **kw):
        if not session.get("mabu_authed"):
            return jsonify({"error": "Not authenticated"}), 401
        return view(*a, **kw)
    return wrapped


def admin_required(view):
    @wraps(view)
    def wrapped(*a, **kw):
        if not session.get("mabu_authed"):
            return jsonify({"error": "Not authenticated"}), 401
        if session.get("mabu_role") != "admin":
            return jsonify({"error": "Admin role required"}), 403
        return view(*a, **kw)
    return wrapped


def get_client_ip() -> str:
    forwarded = request.headers.get("X-Forwarded-For", "")
    if forwarded:
        return forwarded.split(",")[0].strip()
    return request.remote_addr or "unknown"


# ---------------------------------------------------------------------------
# Health / auth
# ---------------------------------------------------------------------------

@app.get("/api/health")
def health():
    return jsonify({
        "status": "ok",
        "service": "mabu-server",
        "time": datetime.now(timezone.utc).isoformat(),
        "configured": mabu_auth.is_configured(),
    })


@app.get("/api/auth/status")
def auth_status():
    authed = bool(session.get("mabu_authed"))
    return jsonify({
        "configured": mabu_auth.is_configured(),
        "authenticated": authed,
        "username": session.get("mabu_username"),
        "role": session.get("mabu_role"),
        "csrf_token": mabu_csrf.get_or_create_csrf_token() if authed else None,
    })


@app.post("/api/auth/login")
def auth_login():
    if not mabu_auth.is_configured():
        return jsonify({"error": "No admin account configured. Run setup.py on the server first."}), 400

    data = request.get_json(force=True, silent=True) or {}
    username = data.get("username", "")
    password = data.get("password", "")
    ip = get_client_ip()

    if mabu_auth.is_rate_limited(username, ip):
        return jsonify({"error": "Too many failed attempts. Try again in a few minutes."}), 429

    user = mabu_auth.verify_login(username, password, ip)
    if user:
        session.clear()
        session["mabu_authed"] = True
        session["mabu_username"] = user["username"]
        session["mabu_role"] = user["role"]
        session["mabu_user_id"] = user["user_id"]
        session.permanent = True
        return jsonify({"status": "ok", "username": user["username"], "role": user["role"], "csrf_token": mabu_csrf.rotate_csrf_token()})

    return jsonify({"error": "Invalid username or password"}), 401


@app.post("/api/auth/logout")
@login_required
def auth_logout():
    mabu_auth.log_audit(session.get("mabu_username", "unknown"), "logout", "")
    session.clear()
    return jsonify({"status": "ok"})


@app.post("/api/auth/change-password")
@login_required
@mabu_csrf.csrf_protect
def auth_change_password():
    data = request.get_json(force=True, silent=True) or {}
    try:
        mabu_auth.change_password(session["mabu_username"], data.get("current_password", ""), data.get("new_password", ""))
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    return jsonify({"status": "ok"})


# ---------------------------------------------------------------------------
# User management (admin only)
# ---------------------------------------------------------------------------

@app.get("/api/users")
@admin_required
def users_list():
    return jsonify({"users": mabu_auth.list_users()})


@app.post("/api/users")
@admin_required
@mabu_csrf.csrf_protect
def users_create():
    data = request.get_json(force=True, silent=True) or {}
    try:
        user = mabu_auth.create_user(data.get("username", ""), data.get("password", ""), data.get("role", "investigator"), actor=session["mabu_username"])
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    return jsonify({"status": "ok", "user": user})


@app.post("/api/users/<username>/deactivate")
@admin_required
@mabu_csrf.csrf_protect
def users_deactivate(username):
    try:
        mabu_auth.set_user_active(username, False, session["mabu_username"])
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    return jsonify({"status": "ok"})


@app.post("/api/users/<username>/reactivate")
@admin_required
@mabu_csrf.csrf_protect
def users_reactivate(username):
    try:
        mabu_auth.set_user_active(username, True, session["mabu_username"])
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    return jsonify({"status": "ok"})


@app.post("/api/users/<username>/role")
@admin_required
@mabu_csrf.csrf_protect
def users_set_role(username):
    data = request.get_json(force=True, silent=True) or {}
    try:
        mabu_auth.set_user_role(username, data.get("role", ""), session["mabu_username"])
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    return jsonify({"status": "ok"})


@app.post("/api/users/<username>/reset-password")
@admin_required
@mabu_csrf.csrf_protect
def users_reset_password(username):
    data = request.get_json(force=True, silent=True) or {}
    try:
        mabu_auth.admin_reset_password(username, data.get("new_password", ""), session["mabu_username"])
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    return jsonify({"status": "ok"})


@app.delete("/api/users/<username>")
@admin_required
@mabu_csrf.csrf_protect
def users_delete(username):
    try:
        mabu_auth.delete_user(username, session["mabu_username"])
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    return jsonify({"status": "ok"})


@app.get("/api/audit-log")
@admin_required
def audit_log():
    limit = min(int(request.args.get("limit", 200)), 1000)
    return jsonify({"entries": mabu_auth.read_audit_log(limit)})


@app.get("/api/system/status")
@admin_required
def system_status():
    """Non-secret configuration/status info for the admin System panel.

    Deliberately excludes anything from PRESERVE list §51: no key material,
    no password hashes, no session secret, no API keys — only presence
    booleans and counts.
    """
    case_count = len([f for f in os.listdir(VAULT_DIR) if f.endswith(".mabu")]) if os.path.isdir(VAULT_DIR) else 0
    return jsonify({
        "vault_dir": VAULT_DIR,
        "vault_key_present": os.path.exists(fmt.default_key_path()),
        "case_count": case_count,
        "public_origin": PUBLIC_ORIGIN or None,
        "hibp_configured": mabu_lookups.hibp_is_configured(),
    })


# ---------------------------------------------------------------------------
# Case file helpers
# ---------------------------------------------------------------------------

def _load_case(filename: str, passphrase: str | None) -> dict:
    filepath = os.path.join(VAULT_DIR, filename)
    with open(filepath, "rb") as f:
        raw = f.read()
    return fmt.parse_mabu_file(raw, passphrase)


def _save_case(case: dict, filename: str, passphrase: str | None):
    blob = fmt.build_mabu_file(case, passphrase)
    with open(os.path.join(VAULT_DIR, filename), "wb") as f:
        f.write(blob)


def _safe_filename(filename: str) -> bool:
    return bool(filename) and "/" not in filename and "\\" not in filename and ".." not in filename


def _read_case_unlocked(filepath: str) -> dict | None:
    """Try decrypting with the default vault key only, for listing purposes."""
    try:
        with open(filepath, "rb") as f:
            data = f.read()
        return fmt.parse_mabu_file(data, None)
    except Exception:
        return None


# ---------------------------------------------------------------------------
# Email domain check
# ---------------------------------------------------------------------------

@app.get("/api/email/domain-check")
@login_required
def email_domain_check():
    domain = request.args.get("domain", "").strip()
    if not domain:
        return jsonify({"error": "domain is required"}), 400

    try:
        infos = socket.getaddrinfo(domain, None)
        addr = infos[0][4][0] if infos else None
        return jsonify({"resolves": True, "detail": addr})
    except socket.gaierror:
        return jsonify({"resolves": False, "detail": "DNS resolution failed"})


# ---------------------------------------------------------------------------
# Case templates
# ---------------------------------------------------------------------------

@app.get("/api/templates")
@login_required
def templates_list():
    return jsonify({"templates": fmt.list_templates()})


@app.get("/api/templates/<template_id>")
@login_required
def templates_get(template_id):
    return jsonify(fmt.get_template(template_id))


# ---------------------------------------------------------------------------
# Related-case suggestions (before saving a new case)
# ---------------------------------------------------------------------------

@app.post("/api/cases/related")
@login_required
def cases_related():
    data = request.get_json(force=True, silent=True) or {}
    draft_ids = fmt.draft_identifiers(
        emails=data.get("emails", []),
        phones=data.get("phones", []),
        usernames=data.get("usernames", []),
        names=data.get("names", []),
        ips=data.get("ips", []),
    )
    if not draft_ids:
        return jsonify({"related": []})

    all_cases = []
    for fname in sorted(os.listdir(VAULT_DIR)):
        if not fname.endswith(".mabu"):
            continue
        case = _read_case_unlocked(os.path.join(VAULT_DIR, fname))
        if case:
            all_cases.append({"filename": fname, **case})

    related = fmt.find_related_cases(draft_ids, all_cases)
    return jsonify({"related": related})


# ---------------------------------------------------------------------------
# Case management
# ---------------------------------------------------------------------------

@app.post("/api/cases/create")
@login_required
@mabu_csrf.csrf_protect
def cases_create():
    data = request.get_json(force=True, silent=True) or {}
    title = data.get("title", "Untitled Case")
    investigator = data.get("investigator") or session.get("mabu_username", "Unknown")
    tags = data.get("tags", [])
    passphrase = data.get("passphrase") or None

    case = fmt.new_case(title, investigator, tags)

    first_entry_summary = data.get("summary", "")
    first_entry_findings = data.get("findings", "")
    first_entry_emails = data.get("emails", [])
    first_entry_phones = data.get("phones", [])
    first_entry_usernames = data.get("usernames", [])
    first_entry_names = data.get("names", [])
    first_entry_ips = data.get("ips", [])
    first_entry_sources = data.get("sources", [])

    # Create a first entry whenever there's ANY content to preserve — text or
    # identifiers. Gating this on summary/findings alone silently dropped any
    # identifiers submitted with an otherwise-blank first entry.
    has_content = any([
        first_entry_summary, first_entry_findings, first_entry_emails,
        first_entry_phones, first_entry_usernames, first_entry_names,
        first_entry_ips, first_entry_sources,
    ])
    if has_content:
        entry = fmt.new_entry(
            author=investigator,
            summary=first_entry_summary,
            findings=first_entry_findings,
            emails=first_entry_emails,
            phones=first_entry_phones,
            usernames=first_entry_usernames,
            names=first_entry_names,
            ips=first_entry_ips,
            sources=first_entry_sources,
        )
        fmt.add_entry(case, entry)

    filename = fmt.mabu_filename_for(case["title"])
    _save_case(case, filename, passphrase)
    mabu_auth.log_audit(session["mabu_username"], "case_created", filename)

    return jsonify({"status": "ok", "filename": filename, "case_id": case["case_id"]})


@app.post("/api/cases/<filename>/entries")
@login_required
@mabu_csrf.csrf_protect
def cases_add_entry(filename):
    if not _safe_filename(filename):
        return jsonify({"error": "Invalid filename"}), 400

    data = request.get_json(force=True, silent=True) or {}
    passphrase = data.get("passphrase") or None

    try:
        case = _load_case(filename, passphrase)
    except (InvalidToken, ValueError) as e:
        return jsonify({"error": str(e)}), 400

    attachments = []
    for att in data.get("attachments", []):
        try:
            attachments.append(fmt.new_attachment(att.get("filename", "file"), att.get("content_type", ""), att.get("data_b64", "")))
        except ValueError as e:
            return jsonify({"error": str(e)}), 400

    if len(attachments) > fmt.MAX_ATTACHMENTS_PER_ENTRY:
        return jsonify({"error": f"too many attachments (max {fmt.MAX_ATTACHMENTS_PER_ENTRY} per entry)"}), 400

    entry = fmt.new_entry(
        author=data.get("author") or session.get("mabu_username", "Unknown"),
        summary=data.get("summary", ""),
        findings=data.get("findings", ""),
        emails=data.get("emails", []),
        phones=data.get("phones", []),
        usernames=data.get("usernames", []),
        names=data.get("names", []),
        ips=data.get("ips", []),
        sources=data.get("sources", []),
        attachments=attachments,
    )
    fmt.add_entry(case, entry)
    _save_case(case, filename, passphrase)
    mabu_auth.log_audit(session["mabu_username"], "entry_added", f"{filename} / {entry['entry_id']}")

    return jsonify({"status": "ok", "entry_id": entry["entry_id"]})


@app.post("/api/cases/<filename>/status")
@login_required
@mabu_csrf.csrf_protect
def cases_set_status(filename):
    if not _safe_filename(filename):
        return jsonify({"error": "Invalid filename"}), 400

    data = request.get_json(force=True, silent=True) or {}
    passphrase = data.get("passphrase") or None
    status = data.get("status", "")

    try:
        case = _load_case(filename, passphrase)
        fmt.set_status(case, status, session.get("mabu_username", "Unknown"))
        _save_case(case, filename, passphrase)
    except (InvalidToken, ValueError) as e:
        return jsonify({"error": str(e)}), 400

    mabu_auth.log_audit(session["mabu_username"], "status_changed", f"{filename} -> {status}")
    return jsonify({"status": "ok"})


@app.post("/api/cases/<filename>/tags")
@login_required
@mabu_csrf.csrf_protect
def cases_set_tags(filename):
    if not _safe_filename(filename):
        return jsonify({"error": "Invalid filename"}), 400

    data = request.get_json(force=True, silent=True) or {}
    passphrase = data.get("passphrase") or None
    tags = data.get("tags", [])

    try:
        case = _load_case(filename, passphrase)
        case["tags"] = tags
        fmt.log_activity(case, "tags_updated", f"{session.get('mabu_username', 'Unknown')}: {', '.join(tags)}")
        _save_case(case, filename, passphrase)
    except (InvalidToken, ValueError) as e:
        return jsonify({"error": str(e)}), 400

    mabu_auth.log_audit(session["mabu_username"], "tags_updated", f"{filename} -> {', '.join(tags)}")
    return jsonify({"status": "ok"})


@app.delete("/api/cases/<filename>")
@login_required
@mabu_csrf.csrf_protect
def cases_delete(filename):
    """Permanently delete a .mabu case file. Irreversible — the frontend is
    responsible for a clear confirmation step before calling this. Does not
    require decrypting the file first, so a passphrase-protected case can
    still be deleted even if the passphrase has been lost."""
    if not _safe_filename(filename):
        return jsonify({"error": "Invalid filename"}), 400

    filepath = os.path.join(VAULT_DIR, filename)
    if not os.path.isfile(filepath):
        return jsonify({"error": "File not found"}), 404

    # Best-effort title lookup for a clearer audit-log entry — never blocks
    # the delete itself if the file can't be decrypted with the default key.
    title = filename
    case = _read_case_unlocked(filepath)
    if case:
        title = case.get("title", filename)

    os.remove(filepath)
    mabu_auth.log_audit(session["mabu_username"], "case_deleted", f"{filename} ({title})")
    return jsonify({"status": "ok"})


@app.get("/api/vault/list")
@login_required
def vault_list():
    tag_filter = request.args.get("tag", "").strip().lower()
    status_filter = request.args.get("status", "").strip().lower()

    files = []
    for fname in sorted(os.listdir(VAULT_DIR)):
        if not fname.endswith(".mabu"):
            continue
        filepath = os.path.join(VAULT_DIR, fname)
        case = _read_case_unlocked(filepath)
        mtime = datetime.fromtimestamp(os.path.getmtime(filepath), tz=timezone.utc).isoformat()

        if case:
            tags = case.get("tags", [])
            status = case.get("status", "open")
            if tag_filter and tag_filter not in [t.lower() for t in tags]:
                continue
            if status_filter and status_filter != status.lower():
                continue
            files.append({
                "filename": fname,
                "case_id": case.get("case_id"),
                "title": case.get("title"),
                "status": status,
                "created": case.get("created"),
                "updated": case.get("updated"),
                "investigator": case.get("investigator"),
                "tags": tags,
                "entry_count": len(case.get("entries", [])),
                "locked": False,
            })
        elif not tag_filter and not status_filter:
            files.append({
                "filename": fname,
                "case_id": None,
                "title": fname,
                "status": "unknown",
                "created": mtime,
                "updated": mtime,
                "investigator": None,
                "tags": [],
                "entry_count": None,
                "locked": True,
            })

    return jsonify({"files": files, "count": len(files)})


@app.get("/api/vault/tags")
@login_required
def vault_tags():
    tag_set = set()
    for fname in sorted(os.listdir(VAULT_DIR)):
        if not fname.endswith(".mabu"):
            continue
        case = _read_case_unlocked(os.path.join(VAULT_DIR, fname))
        if case:
            tag_set.update(t.lower() for t in case.get("tags", []))
    return jsonify({"tags": sorted(tag_set)})


@app.get("/api/vault/search")
@login_required
def vault_search():
    query = request.args.get("q", "").strip().lower()
    if not query:
        return vault_list()

    matches = []
    for fname in sorted(os.listdir(VAULT_DIR)):
        if not fname.endswith(".mabu"):
            continue
        case = _read_case_unlocked(os.path.join(VAULT_DIR, fname))
        if not case:
            continue

        if query in fmt.case_search_text(case):
            matches.append({
                "filename": fname,
                "case_id": case.get("case_id"),
                "title": case.get("title"),
                "status": case.get("status", "open"),
                "updated": case.get("updated"),
                "investigator": case.get("investigator"),
                "tags": case.get("tags", []),
                "entry_count": len(case.get("entries", [])),
                "locked": False,
            })

    return jsonify({"files": matches, "count": len(matches)})


@app.post("/api/vault/decrypt")
@login_required
def vault_decrypt():
    data = request.get_json(force=True, silent=True) or {}
    filename = data.get("filename", "")
    passphrase = data.get("passphrase") or None

    if not _safe_filename(filename):
        return jsonify({"error": "Invalid filename"}), 400

    filepath = os.path.join(VAULT_DIR, filename)
    if not os.path.isfile(filepath):
        return jsonify({"error": "File not found"}), 404

    try:
        case = _load_case(filename, passphrase)
    except InvalidToken:
        return jsonify({"error": "Decryption failed — wrong passphrase or corrupted file"}), 400
    except ValueError as e:
        return jsonify({"error": str(e)}), 400

    mabu_auth.log_audit(session["mabu_username"], "case_decrypted", filename)
    return jsonify({"status": "ok", "record": case})


# ---------------------------------------------------------------------------
# Multi-case correlation engine
# ---------------------------------------------------------------------------

@app.get("/api/correlate")
@login_required
def correlate():
    cases = []
    for fname in sorted(os.listdir(VAULT_DIR)):
        if not fname.endswith(".mabu"):
            continue
        case = _read_case_unlocked(os.path.join(VAULT_DIR, fname))
        if case:
            cases.append({"filename": fname, **case})

    nodes = []
    for c in cases:
        ids = fmt.all_identifiers(c)
        identifier_set = set()
        for key in ("emails", "usernames", "names", "ips", "phones"):
            identifier_set.update(ids.get(key, []))
        nodes.append({
            "filename": c["filename"],
            "case_id": c["case_id"],
            "title": c["title"],
            "status": c.get("status", "open"),
            "identifiers": identifier_set,
            "identifier_detail": ids,
        })

    edges = []
    for i in range(len(nodes)):
        for j in range(i + 1, len(nodes)):
            shared = nodes[i]["identifiers"] & nodes[j]["identifiers"]
            if shared:
                edges.append({
                    "from": nodes[i]["filename"],
                    "to": nodes[j]["filename"],
                    "shared": sorted(shared),
                })

    # Cluster cases into connected components (likely-same-person groups)
    parent = {n["filename"]: n["filename"] for n in nodes}

    def find(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    def union(a, b):
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[ra] = rb

    for e in edges:
        union(e["from"], e["to"])

    clusters = {}
    for n in nodes:
        root = find(n["filename"])
        clusters.setdefault(root, []).append(n["filename"])

    cluster_list = [
        {"filenames": v, "size": len(v)}
        for v in clusters.values() if len(v) > 1
    ]

    response_nodes = [
        {
            "filename": n["filename"],
            "case_id": n["case_id"],
            "title": n["title"],
            "status": n["status"],
            "identifiers": sorted(n["identifiers"]),
            "identifier_detail": n["identifier_detail"],
        }
        for n in nodes
    ]

    return jsonify({
        "nodes": response_nodes,
        "edges": edges,
        "clusters": cluster_list,
    })


# ---------------------------------------------------------------------------
# Public-record lookups
# ---------------------------------------------------------------------------

@app.get("/api/lookup/whois")
@login_required
def lookup_whois():
    domain = request.args.get("domain", "").strip()
    if not domain:
        return jsonify({"error": "domain is required"}), 400
    return jsonify(mabu_lookups.whois_lookup(domain))


@app.get("/api/lookup/dns")
@login_required
def lookup_dns():
    domain = request.args.get("domain", "").strip()
    if not domain:
        return jsonify({"error": "domain is required"}), 400
    return jsonify(mabu_lookups.dns_lookup(domain))


@app.get("/api/lookup/handle")
@login_required
def lookup_handle():
    username = request.args.get("username", "").strip()
    if not username:
        return jsonify({"error": "username is required"}), 400
    return jsonify(mabu_lookups.handle_check_all(username))


@app.get("/api/lookup/phone")
@login_required
def lookup_phone():
    number = request.args.get("number", "").strip()
    region = request.args.get("region", "US").strip().upper()
    if not number:
        return jsonify({"error": "number is required"}), 400
    return jsonify(mabu_lookups.phone_lookup(number, region))


@app.get("/api/lookup/breach")
@login_required
def lookup_breach():
    email = request.args.get("email", "").strip()
    if not email:
        return jsonify({"error": "email is required"}), 400
    return jsonify(mabu_lookups.hibp_breach_check(email))


@app.get("/api/lookup/breach-status")
@login_required
def lookup_breach_status():
    return jsonify({"configured": mabu_lookups.hibp_is_configured()})


@app.post("/api/lookup/image-metadata")
@login_required
@mabu_csrf.csrf_protect
def lookup_image_metadata():
    data = request.get_json(force=True, silent=True) or {}
    data_b64 = data.get("data_b64", "")
    if not data_b64:
        return jsonify({"error": "data_b64 is required"}), 400
    return jsonify(mabu_media.extract_metadata_from_b64(data_b64))


# ---------------------------------------------------------------------------
# Attachments
# ---------------------------------------------------------------------------

@app.post("/api/cases/<filename>/attachments/<entry_id>/<attachment_id>")
@login_required
def get_attachment(filename, entry_id, attachment_id):
    """Fetch a single attachment's raw bytes for download/preview."""
    if not _safe_filename(filename):
        return jsonify({"error": "Invalid filename"}), 400

    data = request.get_json(force=True, silent=True) or {}
    passphrase = data.get("passphrase") or None

    try:
        case = _load_case(filename, passphrase)
    except (InvalidToken, ValueError) as e:
        return jsonify({"error": str(e)}), 400

    for entry in case.get("entries", []):
        if entry["entry_id"] != entry_id:
            continue
        for att in entry.get("attachments", []):
            if att["attachment_id"] == attachment_id:
                raw = base64.b64decode(att["data_b64"])
                mabu_auth.log_audit(session["mabu_username"], "attachment_downloaded", f"{filename} / {entry_id} / {att['filename']}")
                return Response(
                    raw,
                    mimetype=att.get("content_type", "application/octet-stream"),
                    headers={
                        "Content-Disposition": f"attachment; filename=\"{att['filename']}\"",
                        "X-Content-Type-Options": "nosniff",
                    },
                )

    return jsonify({"error": "Attachment not found"}), 404


# ---------------------------------------------------------------------------
# Reporting
# ---------------------------------------------------------------------------

@app.post("/api/report/case")
@login_required
def report_case():
    data = request.get_json(force=True, silent=True) or {}
    filename = data.get("filename", "")
    passphrase = data.get("passphrase") or None

    if not _safe_filename(filename):
        return jsonify({"error": "Invalid filename"}), 400

    try:
        case = _load_case(filename, passphrase)
    except InvalidToken:
        return jsonify({"error": "Decryption failed — wrong passphrase or corrupted file"}), 400
    except ValueError as e:
        return jsonify({"error": str(e)}), 400

    pdf_bytes = mabu_report.build_case_report_pdf(case)
    safe_title = "".join(c if c.isalnum() or c in ("-", "_") else "_" for c in case.get("title", "case"))
    mabu_auth.log_audit(session["mabu_username"], "report_generated", f"case: {filename}")
    return Response(
        pdf_bytes,
        mimetype="application/pdf",
        headers={
            "Content-Disposition": f"attachment; filename=\"{safe_title}_report.pdf\"",
            "X-Content-Type-Options": "nosniff",
        },
    )


@app.post("/api/report/cluster")
@login_required
def report_cluster():
    data = request.get_json(force=True, silent=True) or {}
    filenames = data.get("filenames", [])
    passphrase = data.get("passphrase") or None

    cases = []
    for filename in filenames:
        if not _safe_filename(filename):
            continue
        try:
            cases.append(_load_case(filename, passphrase))
        except (InvalidToken, ValueError):
            continue

    if not cases:
        return jsonify({"error": "No decryptable cases found for the given filenames"}), 400

    pdf_bytes = mabu_report.build_cluster_report_pdf(cases)
    mabu_auth.log_audit(session["mabu_username"], "report_generated", f"cluster: {', '.join(filenames)}")
    return Response(
        pdf_bytes,
        mimetype="application/pdf",
        headers={
            "Content-Disposition": "attachment; filename=\"mabu_cluster_report.pdf\"",
            "X-Content-Type-Options": "nosniff",
        },
    )


if __name__ == "__main__":
    if not mabu_auth.is_configured():
        print("=" * 60)
        print("  No admin account configured yet.")
        print("  Run this first:  python setup.py")
        print("=" * 60)

    debug_mode = not PUBLIC_ORIGIN
    print("=" * 60)
    print("  MABU Server starting")
    print(f"  Vault directory: {VAULT_DIR}")
    print("  Listening on http://127.0.0.1:5057")
    print(f"  Debug mode: {'ON (local dev only)' if debug_mode else 'OFF (public origin configured)'}")
    print("=" * 60)
    app.run(host="127.0.0.1", port=5057, debug=debug_mode)

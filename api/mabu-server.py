"""
MABU Server — local/VPS Flask backend for the MABU Dashboard.

Provides:
  - Authentication (single admin account, bcrypt + server-side session)
  - Case management (multi-entry cases, status, activity log)
  - Multi-case correlation engine
  - Public-record lookups (WHOIS, DNS, handle-existence checks)
  - PDF report generation
  - Vault listing / search / decryption

Run `python setup.py` first to create the admin account and generate keys.
"""

import os
import socket
from datetime import datetime, timezone
from functools import wraps

from flask import Flask, jsonify, request, session
from flask_cors import CORS
from cryptography.fernet import InvalidToken

import mabu_auth
import mabu_format as fmt
import mabu_lookups
import mabu_report

VAULT_DIR = fmt.vault_dir()
os.makedirs(VAULT_DIR, exist_ok=True)

app = Flask(__name__)
app.secret_key = mabu_auth.get_or_create_session_secret()
app.config.update(
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE="Lax",
    # SESSION_COOKIE_SECURE should be True once served over HTTPS (see README deployment notes)
)
CORS(app, supports_credentials=True)


# ---------------------------------------------------------------------------
# Auth
# ---------------------------------------------------------------------------

def login_required(view):
    @wraps(view)
    def wrapped(*a, **kw):
        if not session.get("mabu_authed"):
            return jsonify({"error": "Not authenticated"}), 401
        return view(*a, **kw)
    return wrapped


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
    return jsonify({
        "configured": mabu_auth.is_configured(),
        "authenticated": bool(session.get("mabu_authed")),
        "username": session.get("mabu_username"),
    })


@app.post("/api/auth/login")
def auth_login():
    if not mabu_auth.is_configured():
        return jsonify({"error": "No admin account configured. Run setup.py on the server first."}), 400

    data = request.get_json(force=True, silent=True) or {}
    username = data.get("username", "")
    password = data.get("password", "")

    if mabu_auth.verify_login(username, password):
        session["mabu_authed"] = True
        session["mabu_username"] = username
        session.permanent = True
        return jsonify({"status": "ok", "username": username})

    return jsonify({"error": "Invalid username or password"}), 401


@app.post("/api/auth/logout")
def auth_logout():
    session.clear()
    return jsonify({"status": "ok"})


@app.post("/api/auth/change-password")
@login_required
def auth_change_password():
    data = request.get_json(force=True, silent=True) or {}
    try:
        mabu_auth.change_password(data.get("current_password", ""), data.get("new_password", ""))
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    return jsonify({"status": "ok"})


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
# Email domain check (kept from v1)
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
# Case management
# ---------------------------------------------------------------------------

@app.post("/api/cases/create")
@login_required
def cases_create():
    data = request.get_json(force=True, silent=True) or {}
    title = data.get("title", "Untitled Case")
    investigator = data.get("investigator") or session.get("mabu_username", "Unknown")
    tags = data.get("tags", [])
    passphrase = data.get("passphrase") or None

    case = fmt.new_case(title, investigator, tags)

    first_entry_summary = data.get("summary", "")
    first_entry_findings = data.get("findings", "")
    if first_entry_summary or first_entry_findings:
        entry = fmt.new_entry(
            author=investigator,
            summary=first_entry_summary,
            findings=first_entry_findings,
            emails=data.get("emails", []),
            phones=data.get("phones", []),
            usernames=data.get("usernames", []),
            names=data.get("names", []),
            ips=data.get("ips", []),
            sources=data.get("sources", []),
        )
        fmt.add_entry(case, entry)

    filename = fmt.mabu_filename_for(case["title"])
    _save_case(case, filename, passphrase)

    return jsonify({"status": "ok", "filename": filename, "case_id": case["case_id"]})


@app.post("/api/cases/<filename>/entries")
@login_required
def cases_add_entry(filename):
    if not _safe_filename(filename):
        return jsonify({"error": "Invalid filename"}), 400

    data = request.get_json(force=True, silent=True) or {}
    passphrase = data.get("passphrase") or None

    try:
        case = _load_case(filename, passphrase)
    except (InvalidToken, ValueError) as e:
        return jsonify({"error": str(e)}), 400

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
    )
    fmt.add_entry(case, entry)
    _save_case(case, filename, passphrase)

    return jsonify({"status": "ok", "entry_id": entry["entry_id"]})


@app.post("/api/cases/<filename>/status")
@login_required
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

    return jsonify({"status": "ok"})


@app.get("/api/vault/list")
@login_required
def vault_list():
    files = []
    for fname in sorted(os.listdir(VAULT_DIR)):
        if not fname.endswith(".mabu"):
            continue
        filepath = os.path.join(VAULT_DIR, fname)
        case = _read_case_unlocked(filepath)
        mtime = datetime.fromtimestamp(os.path.getmtime(filepath), tz=timezone.utc).isoformat()

        if case:
            files.append({
                "filename": fname,
                "case_id": case.get("case_id"),
                "title": case.get("title"),
                "status": case.get("status", "open"),
                "created": case.get("created"),
                "updated": case.get("updated"),
                "investigator": case.get("investigator"),
                "tags": case.get("tags", []),
                "entry_count": len(case.get("entries", [])),
                "locked": False,
            })
        else:
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
    from flask import Response
    safe_title = "".join(c if c.isalnum() or c in ("-", "_") else "_" for c in case.get("title", "case"))
    return Response(
        pdf_bytes,
        mimetype="application/pdf",
        headers={"Content-Disposition": f"attachment; filename={safe_title}_report.pdf"},
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
    from flask import Response
    return Response(
        pdf_bytes,
        mimetype="application/pdf",
        headers={"Content-Disposition": "attachment; filename=mabu_cluster_report.pdf"},
    )


if __name__ == "__main__":
    if not mabu_auth.is_configured():
        print("=" * 60)
        print("  No admin account configured yet.")
        print("  Run this first:  python setup.py")
        print("=" * 60)

    print("=" * 60)
    print("  MABU Server starting")
    print(f"  Vault directory: {VAULT_DIR}")
    print("  Listening on http://127.0.0.1:5057")
    print("=" * 60)
    app.run(host="127.0.0.1", port=5057, debug=True)

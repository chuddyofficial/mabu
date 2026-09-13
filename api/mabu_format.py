"""
mabu_format.py — shared .mabu file format (v2 case schema) + crypto helpers.

Used by mabu-server.py, mabu-reader.py, mabu-open.py, and migrate_vault.py so
the binary layout and encryption logic live in exactly one place.

Binary layout (unchanged since v1):
    [4 bytes]  magic b"MABU"
    [1 byte]   format version (2)
    [8 bytes]  encrypted payload length (big-endian)
    [N bytes]  Fernet-encrypted JSON payload
    [32 bytes] SHA-256 checksum of the encrypted payload

v2 JSON payload (a "case"):
{
  "schema": 2,
  "case_id": "uuid4 hex",
  "title": str,
  "status": "open" | "closed" | "cold",
  "investigator": str,
  "created": iso8601,
  "updated": iso8601,
  "tags": [str],
  "entries": [
    {
      "entry_id": "uuid4 hex",
      "date": iso8601,
      "author": str,
      "summary": str,
      "findings": str,
      "emails": [str], "phones": [str], "usernames": [str],
      "names": [str], "ips": [str], "sources": [str]
    },
    ...
  ],
  "activity_log": [
    {"date": iso8601, "action": str, "detail": str}
  ]
}

v1 JSON payload (legacy, single-note) is still parseable; callers should run
it through upgrade_v1_to_v2() before use.
"""

import base64
import hashlib
import json
import os
import uuid
from datetime import datetime, timezone

from cryptography.fernet import Fernet, InvalidToken

MABU_MAGIC = b"MABU"
MABU_VERSION_LEGACY = 1
MABU_VERSION = 2

CASE_STATUSES = ("open", "closed", "cold")


# ---------------------------------------------------------------------------
# Key management
# ---------------------------------------------------------------------------

def base_dir() -> str:
    return os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def vault_dir() -> str:
    return os.path.join(base_dir(), "vault", "mabu-files")


def default_key_path() -> str:
    return os.path.join(base_dir(), "vault", ".mabu-default-key")


def get_default_key(create_if_missing: bool = True) -> bytes | None:
    path = default_key_path()
    if os.path.exists(path):
        with open(path, "rb") as f:
            return f.read().strip()
    if not create_if_missing:
        return None
    key = Fernet.generate_key()
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as f:
        f.write(key)
    return key


def derive_key_from_passphrase(passphrase: str) -> bytes:
    digest = hashlib.sha256(passphrase.encode("utf-8")).digest()
    return base64.urlsafe_b64encode(digest)


def get_fernet(passphrase: str | None) -> Fernet:
    if passphrase:
        return Fernet(derive_key_from_passphrase(passphrase))
    return Fernet(get_default_key())


# ---------------------------------------------------------------------------
# Binary container
# ---------------------------------------------------------------------------

def build_mabu_file(record: dict, passphrase: str | None, version: int = MABU_VERSION) -> bytes:
    fernet = get_fernet(passphrase)
    payload = json.dumps(record, ensure_ascii=False).encode("utf-8")
    token = fernet.encrypt(payload)
    checksum = hashlib.sha256(token).digest()

    out = bytearray()
    out += MABU_MAGIC
    out += bytes([version])
    out += len(token).to_bytes(8, "big")
    out += token
    out += checksum
    return bytes(out)


def parse_mabu_file_raw(data: bytes, key: bytes) -> tuple[dict, int]:
    """Returns (record, version) without upgrading the schema."""
    if data[:4] != MABU_MAGIC:
        raise ValueError("Not a valid MABU file (bad magic header)")

    version = data[4]
    if version not in (MABU_VERSION_LEGACY, MABU_VERSION):
        raise ValueError(f"Unsupported MABU file version: {version}")

    token_len = int.from_bytes(data[5:13], "big")
    token = data[13:13 + token_len]
    checksum_stored = data[13 + token_len:13 + token_len + 32]

    if hashlib.sha256(token).digest() != checksum_stored:
        raise ValueError("Checksum mismatch — file may be corrupted")

    payload = Fernet(key).decrypt(token)
    return json.loads(payload.decode("utf-8")), version


def parse_mabu_file(data: bytes, passphrase: str | None) -> dict:
    """Parse and auto-upgrade to v2 schema. Raises InvalidToken / ValueError."""
    fernet_key = derive_key_from_passphrase(passphrase) if passphrase else get_default_key()
    record, version = parse_mabu_file_raw(data, fernet_key)
    if version == MABU_VERSION_LEGACY:
        record = upgrade_v1_to_v2(record)
    return record


def mabu_filename_for(title: str) -> str:
    safe = "".join(c if c.isalnum() or c in ("-", "_") else "_" for c in title.strip()) or "case"
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    return f"{safe}-{stamp}.mabu"


# ---------------------------------------------------------------------------
# v1 -> v2 upgrade
# ---------------------------------------------------------------------------

def upgrade_v1_to_v2(old: dict) -> dict:
    """Wrap a legacy single-note record into a v2 case with one entry."""
    now = old.get("date") or datetime.now(timezone.utc).isoformat()
    entry = {
        "entry_id": uuid.uuid4().hex,
        "date": now,
        "author": old.get("investigator", "Unknown"),
        "summary": old.get("summary", ""),
        "findings": old.get("findings", ""),
        "emails": old.get("emails", []),
        "phones": old.get("phones", []),
        "usernames": old.get("usernames", []),
        "names": old.get("names", []),
        "ips": old.get("ips", []),
        "sources": old.get("sources", []),
    }
    return {
        "schema": 2,
        "case_id": uuid.uuid4().hex,
        "title": old.get("title", "Untitled Case"),
        "status": "open",
        "investigator": old.get("investigator", "Unknown"),
        "created": now,
        "updated": now,
        "tags": old.get("tags", []),
        "entries": [entry],
        "activity_log": [
            {"date": now, "action": "migrated", "detail": "Upgraded from legacy v1 note format"}
        ],
    }


def new_case(title: str, investigator: str, tags: list[str]) -> dict:
    now = datetime.now(timezone.utc).isoformat()
    return {
        "schema": 2,
        "case_id": uuid.uuid4().hex,
        "title": title or "Untitled Case",
        "status": "open",
        "investigator": investigator or "Unknown",
        "created": now,
        "updated": now,
        "tags": tags or [],
        "entries": [],
        "activity_log": [
            {"date": now, "action": "created", "detail": f"Case created by {investigator or 'Unknown'}"}
        ],
    }


MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024  # 8 MB per file, generous for screenshots/small PDFs
MAX_ATTACHMENTS_PER_ENTRY = 10


def new_entry(author: str, summary: str, findings: str, emails=None, phones=None,
              usernames=None, names=None, ips=None, sources=None, attachments=None) -> dict:
    return {
        "entry_id": uuid.uuid4().hex,
        "date": datetime.now(timezone.utc).isoformat(),
        "author": author or "Unknown",
        "summary": summary or "",
        "findings": findings or "",
        "emails": emails or [],
        "phones": phones or [],
        "usernames": usernames or [],
        "names": names or [],
        "ips": ips or [],
        "sources": sources or [],
        "attachments": attachments or [],
    }


def new_attachment(filename: str, content_type: str, data_b64: str) -> dict:
    """An attachment stored inline as base64 inside the encrypted entry.

    Kept inside the .mabu file (rather than as separate files on disk) so the
    whole case — including evidence files — stays under one Fernet-encrypted
    container with one passphrase/key.
    """
    raw_len = (len(data_b64) * 3) // 4
    if raw_len > MAX_ATTACHMENT_BYTES:
        raise ValueError(f"attachment exceeds the {MAX_ATTACHMENT_BYTES // (1024*1024)} MB limit")
    safe_name = "".join(c if c.isalnum() or c in ("-", "_", ".") else "_" for c in filename.strip()) or "file"
    return {
        "attachment_id": uuid.uuid4().hex,
        "filename": safe_name,
        "content_type": content_type or "application/octet-stream",
        "data_b64": data_b64,
        "added": datetime.now(timezone.utc).isoformat(),
    }


def add_entry(case: dict, entry: dict) -> dict:
    case["entries"].append(entry)
    case["updated"] = entry["date"]
    case["activity_log"].append({
        "date": entry["date"],
        "action": "entry_added",
        "detail": f"New entry by {entry['author']}: {entry['summary'][:80]}",
    })
    return case


def set_status(case: dict, status: str, actor: str) -> dict:
    if status not in CASE_STATUSES:
        raise ValueError(f"Invalid status: {status}")
    now = datetime.now(timezone.utc).isoformat()
    old_status = case.get("status")
    case["status"] = status
    case["updated"] = now
    case["activity_log"].append({
        "date": now,
        "action": "status_change",
        "detail": f"{actor}: {old_status} -> {status}",
    })
    return case


def log_activity(case: dict, action: str, detail: str) -> dict:
    now = datetime.now(timezone.utc).isoformat()
    case["updated"] = now
    case["activity_log"].append({"date": now, "action": action, "detail": detail})
    return case


def all_identifiers(case: dict) -> dict:
    """Aggregate identifier lists across all entries in a case, deduplicated."""
    agg = {"emails": set(), "phones": set(), "usernames": set(), "names": set(), "ips": set()}
    for entry in case.get("entries", []):
        for key in agg:
            for v in entry.get(key, []):
                if v:
                    agg[key].add(v.strip().lower())
    return {k: sorted(v) for k, v in agg.items()}


def case_search_text(case: dict) -> str:
    parts = [case.get("title", ""), " ".join(case.get("tags", []))]
    for entry in case.get("entries", []):
        parts.append(entry.get("summary", ""))
        parts.append(entry.get("findings", ""))
        for key in ("emails", "usernames", "names", "ips", "phones"):
            parts.append(" ".join(entry.get(key, [])))
    return " ".join(parts).lower()


# ---------------------------------------------------------------------------
# Case templates
# ---------------------------------------------------------------------------

CASE_TEMPLATES = {
    "blank": {
        "label": "Blank case",
        "tags": [],
        "summary": "",
        "findings": "",
    },
    "phishing": {
        "label": "Phishing investigation",
        "tags": ["phishing"],
        "summary": "Phishing attempt reported involving domain/sender: ",
        "findings": (
            "Sender/domain:\n"
            "Delivery method (email/SMS/DM):\n"
            "Payload (link/attachment):\n"
            "Impersonated brand or person:\n"
            "Evidence collected:\n"
        ),
    },
    "impersonation": {
        "label": "Account impersonation",
        "tags": ["impersonation"],
        "summary": "Impersonation account identified: ",
        "findings": (
            "Platform:\n"
            "Impersonated identity:\n"
            "Account creation date (if known):\n"
            "Content posted:\n"
            "Reported to platform (Y/N):\n"
        ),
    },
    "harassment": {
        "label": "Harassment / abuse tracking",
        "tags": ["harassment"],
        "summary": "Harassment campaign involving: ",
        "findings": (
            "Platform(s) involved:\n"
            "Timeline of incidents:\n"
            "Associated accounts/handles:\n"
            "Evidence preserved (screenshots/logs):\n"
        ),
    },
    "fraud": {
        "label": "Fraud / scam tracking",
        "tags": ["fraud"],
        "summary": "Suspected fraud/scam involving: ",
        "findings": (
            "Scheme type:\n"
            "Payment method(s) used:\n"
            "Associated accounts/wallets:\n"
            "Victims/reports identified:\n"
        ),
    },
}


def get_template(template_id: str) -> dict:
    return CASE_TEMPLATES.get(template_id, CASE_TEMPLATES["blank"])


def list_templates() -> list[dict]:
    return [{"id": k, "label": v["label"]} for k, v in CASE_TEMPLATES.items()]


# ---------------------------------------------------------------------------
# Related-case suggestions
# ---------------------------------------------------------------------------

def draft_identifiers(emails=None, phones=None, usernames=None, names=None, ips=None) -> set:
    ids = set()
    for group in (emails, phones, usernames, names, ips):
        for v in (group or []):
            if v:
                ids.add(v.strip().lower())
    return ids


def find_related_cases(draft_ids: set, all_cases: list[dict]) -> list[dict]:
    """all_cases: list of {"filename": ..., **case_dict}. Returns matches with shared identifiers."""
    related = []
    for case in all_cases:
        case_ids = set()
        for entry in case.get("entries", []):
            for key in ("emails", "phones", "usernames", "names", "ips"):
                case_ids.update(v.strip().lower() for v in entry.get(key, []) if v)
        shared = draft_ids & case_ids
        if shared:
            related.append({
                "filename": case.get("filename"),
                "title": case.get("title"),
                "shared": sorted(shared),
            })
    return related

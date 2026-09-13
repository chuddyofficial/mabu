#!/usr/bin/env python3
"""
MABU File Reader — professional CLI for viewing, exporting, and searching
.mabu encrypted research files.

Usage:
    python mabu-reader.py -f case.mabu                  View a MABU file
    python mabu-reader.py -f case.mabu -p mypassphrase   View with passphrase
    python mabu-reader.py -d ./vault/                    List vault contents
    python mabu-reader.py --search "keyword"             Search MABU files
    python mabu-reader.py -f case.mabu -o report.txt     Export to report
    python mabu-reader.py -f case.mabu -o report.json    Export to JSON

This tool only decrypts .mabu files created by the MABU Dashboard. All
operations are local — nothing is transmitted anywhere.
"""

import argparse
import base64
import hashlib
import json
import os
import sys
import textwrap
from datetime import datetime, timezone

try:
    from cryptography.fernet import Fernet, InvalidToken
except ImportError:
    print("ERROR: the 'cryptography' package is required. Install with:")
    print("    pip install cryptography")
    sys.exit(1)

# ---------------------------------------------------------------------------
# ANSI colors
# ---------------------------------------------------------------------------


class C:
    RESET = "\033[0m"
    BOLD = "\033[1m"
    DIM = "\033[2m"
    BLUE = "\033[38;5;69m"
    PURPLE = "\033[38;5;135m"
    CYAN = "\033[38;5;80m"
    GREEN = "\033[38;5;78m"
    YELLOW = "\033[38;5;221m"
    RED = "\033[38;5;203m"
    GRAY = "\033[38;5;244m"


def _supports_color() -> bool:
    if os.environ.get("NO_COLOR"):
        return False
    if sys.platform == "win32":
        # Enable ANSI on modern Windows terminals
        try:
            import ctypes

            kernel32 = ctypes.windll.kernel32
            kernel32.SetConsoleMode(kernel32.GetStdHandle(-11), 7)
            return True
        except Exception:
            return False
    return sys.stdout.isatty()


USE_COLOR = _supports_color()


def c(text: str, *codes: str) -> str:
    if not USE_COLOR:
        return text
    return "".join(codes) + text + C.RESET


def banner():
    print(c("┌" + "─" * 58 + "┐", C.PURPLE))
    print(c("│", C.PURPLE) + c("  MABU FILE READER".ljust(58), C.BOLD, C.BLUE) + c("│", C.PURPLE))
    print(c("│", C.PURPLE) + c("  Local OSINT Research Vault CLI".ljust(58), C.GRAY) + c("│", C.PURPLE))
    print(c("└" + "─" * 58 + "┘", C.PURPLE))


# ---------------------------------------------------------------------------
# MABU file format (must match api/mabu-server.py)
# ---------------------------------------------------------------------------

MABU_MAGIC = b"MABU"
MABU_VERSION = 1


def default_key_path() -> str:
    base_dir = os.path.dirname(os.path.abspath(__file__))
    return os.path.join(base_dir, "vault", ".mabu-default-key")


def get_default_key() -> bytes:
    path = default_key_path()
    if os.path.exists(path):
        with open(path, "rb") as f:
            return f.read().strip()
    raise FileNotFoundError(
        "No default vault key found at vault/.mabu-default-key. "
        "Either supply --passphrase, or generate a research entry via the "
        "dashboard first so the default key exists."
    )


def derive_key_from_passphrase(passphrase: str) -> bytes:
    digest = hashlib.sha256(passphrase.encode("utf-8")).digest()
    return base64.urlsafe_b64encode(digest)


def get_fernet(passphrase: str | None) -> Fernet:
    if passphrase:
        return Fernet(derive_key_from_passphrase(passphrase))
    return Fernet(get_default_key())


def parse_mabu_file(data: bytes, passphrase: str | None) -> dict:
    if data[:4] != MABU_MAGIC:
        raise ValueError("Not a valid MABU file (bad magic header)")

    version = data[4]
    if version != MABU_VERSION:
        raise ValueError(f"Unsupported MABU file version: {version}")

    token_len = int.from_bytes(data[5:13], "big")
    token = data[13:13 + token_len]
    checksum_stored = data[13 + token_len:13 + token_len + 32]

    checksum_actual = hashlib.sha256(token).digest()
    if checksum_actual != checksum_stored:
        raise ValueError("Checksum mismatch — file may be corrupted")

    fernet = get_fernet(passphrase)
    try:
        payload = fernet.decrypt(token)
    except InvalidToken:
        raise ValueError("Decryption failed — wrong passphrase or corrupted file")

    return json.loads(payload.decode("utf-8"))


def read_mabu_file(path: str, passphrase: str | None) -> dict:
    with open(path, "rb") as f:
        data = f.read()
    return parse_mabu_file(data, passphrase)


# ---------------------------------------------------------------------------
# Rendering
# ---------------------------------------------------------------------------


def wrap(text: str, width: int = 70, indent: str = "    ") -> str:
    if not text:
        return indent + c("(none)", C.GRAY)
    lines = textwrap.wrap(text, width=width) or [""]
    return "\n".join(indent + line for line in lines)


def render_record(record: dict, source_file: str):
    print()
    print(c("═" * 60, C.BLUE))
    print(c(" " + record.get("title", "Untitled"), C.BOLD, C.CYAN))
    print(c("═" * 60, C.BLUE))
    print(f"{c('File:', C.GRAY)} {source_file}")
    print(f"{c('Date:', C.GRAY)} {record.get('date', '–')}")
    print(f"{c('Investigator:', C.GRAY)} {record.get('investigator', '–')}")

    tags = record.get("tags", [])
    if tags:
        tag_str = "  ".join(c(f"#{t}", C.PURPLE) for t in tags)
        print(f"{c('Tags:', C.GRAY)} {tag_str}")

    print()
    print(c(" SUMMARY", C.BOLD, C.YELLOW))
    print(wrap(record.get("summary", "")))

    print()
    print(c(" FINDINGS", C.BOLD, C.YELLOW))
    print(wrap(record.get("findings", "")))

    print()
    print(c(" IDENTIFIERS", C.BOLD, C.YELLOW))
    print_table([
        ("Emails", record.get("emails", [])),
        ("Phones", record.get("phones", [])),
        ("Usernames", record.get("usernames", [])),
        ("Names / Aliases", record.get("names", [])),
        ("IP Addresses", record.get("ips", [])),
    ])

    sources = record.get("sources", [])
    print()
    print(c(" SOURCES", C.BOLD, C.YELLOW))
    if sources:
        for s in sources:
            print(f"    {c('•', C.BLUE)} {s}")
    else:
        print("    " + c("(none)", C.GRAY))
    print()


def print_table(rows):
    label_width = max(len(label) for label, _ in rows) + 2
    for label, values in rows:
        value_str = ", ".join(values) if values else c("(none)", C.GRAY)
        print(f"    {c(label.ljust(label_width), C.GREEN)} {value_str}")


def print_vault_table(entries):
    """entries: list of dicts with filename, title, date, investigator, tags, locked"""
    if not entries:
        print(c("  No .mabu files found.", C.GRAY))
        return

    col_file = max(len("FILE"), max(len(e["filename"]) for e in entries)) + 2
    col_title = max(len("TITLE"), max(len(str(e.get("title") or "")) for e in entries)) + 2
    col_date = max(len("DATE"), max(len(str(e.get("date") or "")[:19]) for e in entries)) + 2
    col_inv = max(len("INVESTIGATOR"), max(len(str(e.get("investigator") or "")) for e in entries)) + 2

    header = (
        c("FILE".ljust(col_file), C.BOLD, C.BLUE)
        + c("TITLE".ljust(col_title), C.BOLD, C.BLUE)
        + c("DATE".ljust(col_date), C.BOLD, C.BLUE)
        + c("INVESTIGATOR".ljust(col_inv), C.BOLD, C.BLUE)
        + c("TAGS", C.BOLD, C.BLUE)
    )
    print(header)
    print(c("─" * (col_file + col_title + col_date + col_inv + 20), C.GRAY))

    for e in entries:
        lock = c(" 🔒", C.RED) if e.get("locked") else ""
        title = str(e.get("title") or "(locked)")
        date = str(e.get("date") or "")[:19]
        inv = str(e.get("investigator") or "–")
        tags = ", ".join(e.get("tags") or []) or "–"
        print(
            e["filename"].ljust(col_file)
            + title.ljust(col_title)
            + date.ljust(col_date)
            + inv.ljust(col_inv)
            + tags
            + lock
        )


# ---------------------------------------------------------------------------
# Commands
# ---------------------------------------------------------------------------


def cmd_view_file(path: str, passphrase: str | None, output: str | None):
    if not os.path.isfile(path):
        print(c(f"ERROR: file not found: {path}", C.RED))
        sys.exit(1)

    try:
        record = read_mabu_file(path, passphrase)
    except Exception as e:
        print(c(f"ERROR: {e}", C.RED))
        sys.exit(1)

    if output:
        export_record(record, path, output)
    else:
        render_record(record, os.path.basename(path))


def export_record(record: dict, source_path: str, output_path: str):
    ext = os.path.splitext(output_path)[1].lower()

    if ext == ".json":
        with open(output_path, "w", encoding="utf-8") as f:
            json.dump(record, f, indent=2, ensure_ascii=False)
    else:
        lines = []
        lines.append("=" * 60)
        lines.append(f"MABU RESEARCH REPORT — {record.get('title', 'Untitled')}")
        lines.append("=" * 60)
        lines.append(f"Source file:   {os.path.basename(source_path)}")
        lines.append(f"Date:          {record.get('date', '–')}")
        lines.append(f"Investigator:  {record.get('investigator', '–')}")
        lines.append(f"Tags:          {', '.join(record.get('tags', [])) or '–'}")
        lines.append("")
        lines.append("SUMMARY")
        lines.append("-" * 60)
        lines.append(record.get("summary", "") or "(none)")
        lines.append("")
        lines.append("FINDINGS")
        lines.append("-" * 60)
        lines.append(record.get("findings", "") or "(none)")
        lines.append("")
        lines.append("IDENTIFIERS")
        lines.append("-" * 60)
        for label, key in [
            ("Emails", "emails"),
            ("Phones", "phones"),
            ("Usernames", "usernames"),
            ("Names / Aliases", "names"),
            ("IP Addresses", "ips"),
        ]:
            values = record.get(key, [])
            lines.append(f"{label}: {', '.join(values) if values else '(none)'}")
        lines.append("")
        lines.append("SOURCES")
        lines.append("-" * 60)
        sources = record.get("sources", [])
        if sources:
            for s in sources:
                lines.append(f"- {s}")
        else:
            lines.append("(none)")
        lines.append("")
        lines.append(f"Generated by mabu-reader.py on {datetime.now(timezone.utc).isoformat()}")

        with open(output_path, "w", encoding="utf-8") as f:
            f.write("\n".join(lines))

    print(c(f"Exported to {output_path}", C.GREEN))


def scan_vault_dir(directory: str):
    """Return list of metadata dicts for all .mabu files, using default key only."""
    entries = []
    if not os.path.isdir(directory):
        return entries

    for fname in sorted(os.listdir(directory)):
        if not fname.endswith(".mabu"):
            continue
        path = os.path.join(directory, fname)
        try:
            record = read_mabu_file(path, None)
            entries.append({
                "filename": fname,
                "path": path,
                "title": record.get("title"),
                "date": record.get("date"),
                "investigator": record.get("investigator"),
                "tags": record.get("tags", []),
                "record": record,
                "locked": False,
            })
        except Exception:
            entries.append({
                "filename": fname,
                "path": path,
                "title": None,
                "date": None,
                "investigator": None,
                "tags": [],
                "record": None,
                "locked": True,
            })
    return entries


def cmd_list_dir(directory: str):
    entries = scan_vault_dir(directory)
    print(c(f"\n  Vault: {directory}", C.BOLD, C.CYAN))
    print(c(f"  {len(entries)} .mabu file(s) found\n", C.GRAY))
    print_vault_table(entries)
    locked_count = sum(1 for e in entries if e["locked"])
    if locked_count:
        print()
        print(c(f"  {locked_count} file(s) are passphrase-protected and could not be previewed.", C.YELLOW))
        print(c("  Use -f <file> -p <passphrase> to view them individually.", C.GRAY))
    print()


def cmd_search(keyword: str, directory: str):
    entries = scan_vault_dir(directory)
    keyword_lower = keyword.lower()
    matches = []

    for e in entries:
        if e["locked"] or not e["record"]:
            continue
        record = e["record"]
        haystack = " ".join([
            record.get("title", "") or "",
            record.get("summary", "") or "",
            record.get("findings", "") or "",
            " ".join(record.get("tags", [])),
            " ".join(record.get("emails", [])),
            " ".join(record.get("usernames", [])),
            " ".join(record.get("names", [])),
            " ".join(record.get("ips", [])),
        ]).lower()

        if keyword_lower in haystack:
            matches.append(e)

    print(c(f"\n  Search results for '{keyword}' in {directory}", C.BOLD, C.CYAN))
    print(c(f"  {len(matches)} match(es)\n", C.GRAY))
    print_vault_table(matches)
    print()


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------


def main():
    parser = argparse.ArgumentParser(
        prog="mabu-reader.py",
        description="MABU File Reader — CLI for viewing, exporting, and searching .mabu research files.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=textwrap.dedent(
            """
            Examples:
              python mabu-reader.py -f case.mabu
              python mabu-reader.py -f case.mabu -p mypassphrase
              python mabu-reader.py -d ./vault/mabu-files/
              python mabu-reader.py --search "phishing"
              python mabu-reader.py -f case.mabu -o report.txt
              python mabu-reader.py -f case.mabu -o report.json
            """
        ),
    )
    parser.add_argument("-f", "--file", help="Path to a single .mabu file to view")
    parser.add_argument("-d", "--dir", help="List all .mabu files in a vault directory")
    parser.add_argument("--search", metavar="KEYWORD", help="Search vault contents for a keyword")
    parser.add_argument(
        "--vault",
        default=os.path.join(os.path.dirname(os.path.abspath(__file__)), "vault", "mabu-files"),
        help="Vault directory to use with -d/--search (default: ./vault/mabu-files)",
    )
    parser.add_argument("-p", "--passphrase", help="Passphrase to decrypt the file (omit to use default vault key)")
    parser.add_argument("-o", "--output", help="Export decrypted content to a file (.txt report or .json)")
    parser.add_argument("--no-banner", action="store_true", help="Suppress the MABU banner")

    args = parser.parse_args()

    if not args.no_banner:
        banner()

    if args.file:
        cmd_view_file(args.file, args.passphrase, args.output)
    elif args.dir:
        cmd_list_dir(args.dir)
    elif args.search:
        cmd_search(args.search, args.vault)
    else:
        parser.print_help()


if __name__ == "__main__":
    main()

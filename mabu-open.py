#!/usr/bin/env python3
"""
mabu-open.py — standalone MABU Reader desktop app.

A self-contained GUI (PySide6) for opening .mabu files: browse for a file,
enter a passphrase if the file needs one, and view the decrypted contents
in a custom-styled reader box. No terminal / command prompt involved.

Run:
    python mabu-open.py
(or double-click it — on Windows, running via pythonw.exe hides the console
entirely; see README for a one-click .vbs/.bat launcher.)
"""

import base64
import hashlib
import json
import os
import sys

from cryptography.fernet import Fernet, InvalidToken

from PySide6.QtCore import Qt
from PySide6.QtGui import QFont, QColor, QPalette
from PySide6.QtWidgets import (
    QApplication, QWidget, QVBoxLayout, QHBoxLayout, QLabel, QLineEdit,
    QPushButton, QFileDialog, QTextEdit, QMessageBox, QFrame,
)

MABU_MAGIC = b"MABU"
# Container versions this reader understands (matches api/mabu_format.py).
MABU_SUPPORTED_VERSIONS = (1, 2)

# Same palette as the web dashboard (css/mabu-styles.css).
MABU_BG = "#0A111B"
MABU_PANEL = "#111B29"
MABU_INPUT_BG = "#0C1520"
MABU_BORDER = "#2A3D57"
MABU_TEXT = "#E4EAF2"
MABU_TEXT_DIM = "#A7B4C6"
MABU_TEXT_FAINT = "#6E7F98"
MABU_PRIMARY = "#4D8DF7"
MABU_PRIMARY_HOVER = "#6AA2FF"
MABU_GOLD = "#C8A24A"
MABU_GREEN = "#3DBE8B"
MABU_RED = "#E5534B"
MABU_AMBER = "#E5A93B"


# ---------------------------------------------------------------------------
# .mabu format (matches api/mabu-server.py exactly)
# ---------------------------------------------------------------------------

def base_dir() -> str:
    return os.path.dirname(os.path.abspath(__file__))


def default_vault_dir() -> str:
    return os.path.join(base_dir(), "vault", "mabu-files")


def default_key_path() -> str:
    return os.path.join(base_dir(), "vault", ".mabu-default-key")


def get_default_key() -> bytes | None:
    path = default_key_path()
    if os.path.exists(path):
        with open(path, "rb") as f:
            return f.read().strip()
    return None


def derive_key_from_passphrase(passphrase: str) -> bytes:
    digest = hashlib.sha256(passphrase.encode("utf-8")).digest()
    return base64.urlsafe_b64encode(digest)


def parse_mabu_file(data: bytes, key: bytes) -> dict:
    if data[:4] != MABU_MAGIC:
        raise ValueError("Not a valid MABU file (bad magic header)")

    version = data[4]
    if version not in MABU_SUPPORTED_VERSIONS:
        raise ValueError(f"Unsupported MABU file version: {version}")

    token_len = int.from_bytes(data[5:13], "big")
    token = data[13:13 + token_len]
    checksum_stored = data[13 + token_len:13 + token_len + 32]

    if hashlib.sha256(token).digest() != checksum_stored:
        raise ValueError("Checksum mismatch — file may be corrupted")

    payload = Fernet(key).decrypt(token)
    return json.loads(payload.decode("utf-8"))


def decrypt_mabu_file(path: str, passphrase: str | None) -> dict:
    """Try the given passphrase if provided, otherwise the default vault key."""
    with open(path, "rb") as f:
        data = f.read()

    if passphrase:
        key = derive_key_from_passphrase(passphrase)
        return parse_mabu_file(data, key)

    default_key = get_default_key()
    if not default_key:
        raise ValueError("No default vault key found and no passphrase given.")
    return parse_mabu_file(data, default_key)


# ---------------------------------------------------------------------------
# GUI
# ---------------------------------------------------------------------------

MABU_STYLESHEET = f"""
QWidget {{
    background-color: {MABU_BG};
    color: {MABU_TEXT};
    font-family: "IBM Plex Sans", "Segoe UI", "Helvetica Neue", Arial, sans-serif;
    font-size: 13px;
}}

QLabel#titleLabel {{
    color: {MABU_TEXT};
    font-size: 18px;
    font-weight: 600;
    letter-spacing: 5px;
}}

QLabel#subLabel {{
    color: {MABU_GOLD};
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 2px;
}}

QLabel[class="fieldLabel"] {{
    color: {MABU_TEXT_DIM};
    font-size: 12px;
    font-weight: 500;
}}

QLabel[class="sectionLabel"] {{
    color: {MABU_TEXT_DIM};
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 2px;
}}

QFrame#panel {{
    background-color: {MABU_PANEL};
    border: 1px solid #1E2D42;
    border-radius: 10px;
}}

QFrame#panel QLabel {{
    background-color: transparent;
}}

QLineEdit {{
    background-color: {MABU_INPUT_BG};
    border: 1px solid {MABU_BORDER};
    border-radius: 6px;
    padding: 8px 10px;
    color: {MABU_TEXT};
    selection-background-color: {MABU_PRIMARY};
    selection-color: #ffffff;
}}

QLineEdit:focus {{
    border: 1px solid {MABU_PRIMARY};
}}

QPushButton {{
    background-color: {MABU_PRIMARY};
    border: 1px solid {MABU_PRIMARY};
    border-radius: 6px;
    color: #ffffff;
    padding: 9px 18px;
    font-weight: 500;
}}

QPushButton:hover {{
    background-color: {MABU_PRIMARY_HOVER};
    border: 1px solid {MABU_PRIMARY_HOVER};
}}

QPushButton:pressed {{
    background-color: #3B78E2;
}}

QPushButton#browseBtn {{
    background-color: #142132;
    border: 1px solid {MABU_BORDER};
    color: {MABU_TEXT};
    padding: 8px 14px;
}}

QPushButton#browseBtn:hover {{
    background-color: #1A2A3F;
    border: 1px solid #3A5272;
}}

QTextEdit#readerBox {{
    background-color: #0D1622;
    border: 1px solid #1E2D42;
    border-radius: 10px;
    color: #C9D6E8;
    padding: 14px;
    font-size: 12px;
}}

QLabel#statusLabel {{
    font-size: 12px;
}}

QScrollBar:vertical {{
    background: transparent;
    width: 10px;
}}

QScrollBar::handle:vertical {{
    background: {MABU_BORDER};
    border-radius: 4px;
    min-height: 24px;
}}

QScrollBar::handle:vertical:hover {{
    background: #3A5272;
}}
"""


class MabuReaderApp(QWidget):
    def __init__(self):
        super().__init__()
        self.setWindowTitle("MABU Reader")
        self.resize(760, 640)
        self.setStyleSheet(MABU_STYLESHEET)
        self._build_ui()

    def _build_ui(self):
        root = QVBoxLayout(self)
        root.setContentsMargins(24, 22, 24, 22)
        root.setSpacing(16)

        # Header
        header = QVBoxLayout()
        title = QLabel("MABU")
        title.setObjectName("titleLabel")
        sub = QLabel("CASE READER  ·  OFFLINE, NO NETWORK ACCESS")
        sub.setObjectName("subLabel")
        header.addWidget(title)
        header.addWidget(sub)
        root.addLayout(header)

        # File selection panel
        file_panel = QFrame()
        file_panel.setObjectName("panel")
        file_layout = QVBoxLayout(file_panel)
        file_layout.setContentsMargins(18, 16, 18, 16)
        file_layout.setSpacing(10)

        file_label = QLabel("Case file (.mabu)")
        file_label.setProperty("class", "fieldLabel")
        file_layout.addWidget(file_label)

        file_row = QHBoxLayout()
        self.file_input = QLineEdit()
        self.file_input.setPlaceholderText("No file selected")
        self.file_input.setReadOnly(True)
        browse_btn = QPushButton("Browse…")
        browse_btn.setObjectName("browseBtn")
        browse_btn.clicked.connect(self.on_browse)
        file_row.addWidget(self.file_input, 1)
        file_row.addWidget(browse_btn)
        file_layout.addLayout(file_row)

        pass_label = QLabel("Passphrase (leave blank to use the vault key)")
        pass_label.setProperty("class", "fieldLabel")
        file_layout.addWidget(pass_label)

        self.passphrase_input = QLineEdit()
        self.passphrase_input.setPlaceholderText("Optional")
        self.passphrase_input.setEchoMode(QLineEdit.EchoMode.Password)
        self.passphrase_input.returnPressed.connect(self.on_decrypt)
        file_layout.addWidget(self.passphrase_input)

        action_row = QHBoxLayout()
        decrypt_btn = QPushButton("Decrypt and view")
        decrypt_btn.clicked.connect(self.on_decrypt)
        self.status_label = QLabel("")
        self.status_label.setObjectName("statusLabel")
        action_row.addWidget(decrypt_btn)
        action_row.addWidget(self.status_label, 1)
        file_layout.addLayout(action_row)

        root.addWidget(file_panel)

        # Reader output panel
        reader_label = QLabel("CONTENTS")
        reader_label.setProperty("class", "sectionLabel")
        root.addWidget(reader_label)

        self.reader_box = QTextEdit()
        self.reader_box.setObjectName("readerBox")
        self.reader_box.setReadOnly(True)
        self.reader_box.setPlainText("Nothing decrypted yet.")
        mono = QFont("IBM Plex Mono")
        mono.setStyleHint(QFont.StyleHint.Monospace)
        self.reader_box.setFont(mono)
        root.addWidget(self.reader_box, 1)

    def on_browse(self):
        start_dir = default_vault_dir()
        if not os.path.isdir(start_dir):
            start_dir = base_dir()
        path, _ = QFileDialog.getOpenFileName(
            self, "Select a .mabu file", start_dir, "MABU files (*.mabu);;All files (*.*)"
        )
        if path:
            self.file_input.setText(path)
            self.status_label.setText("")

    def set_status(self, text: str, color: str):
        self.status_label.setText(text)
        self.status_label.setStyleSheet(f"color: {color};")

    def on_decrypt(self):
        path = self.file_input.text().strip()
        if not path:
            self.set_status("Select a case file first.", MABU_AMBER)
            return
        if not os.path.isfile(path):
            self.set_status("File not found.", MABU_RED)
            return

        passphrase = self.passphrase_input.text() or None

        self.set_status("Decrypting…", MABU_TEXT_DIM)
        QApplication.processEvents()

        try:
            record = decrypt_mabu_file(path, passphrase)
        except InvalidToken:
            self.set_status("Wrong passphrase, or the file is corrupted.", MABU_RED)
            self.reader_box.setPlainText("decryption failed. check the passphrase and try again.")
            return
        except ValueError as e:
            self.set_status(f"Could not open file: {e}", MABU_RED)
            self.reader_box.setPlainText(str(e))
            return
        except Exception as e:
            self.set_status(f"Unexpected error: {e}", MABU_RED)
            return

        self.set_status("Decrypted.", MABU_GREEN)
        self.reader_box.setPlainText(self._format_record(path, record))

    @staticmethod
    def _format_record(path: str, record: dict) -> str:
        """Plain-text view of a case. Handles schema 2 (cases with entries)
        and legacy schema 1 (one flat note)."""
        rule = "─" * 64

        def val(value):
            if isinstance(value, list):
                value = ", ".join(str(v) for v in value if v)
            return value if value not in (None, "") else "—"

        def field(label, value):
            return f"  {label:<15}{val(value)}"

        def when(value):
            return (value or "")[:19].replace("T", " ") or "—"

        lines = [
            str(record.get("title") or "Untitled case"),
            rule,
            field("File", os.path.basename(path)),
            field("Case ID", record.get("case_id")),
            field("Status", str(record.get("status") or "").capitalize()),
            field("Investigator", record.get("investigator")),
            field("Created (UTC)", when(record.get("created") or record.get("date"))),
            field("Updated (UTC)", when(record.get("updated"))),
            field("Tags", record.get("tags", [])),
        ]

        # Schema 1 files are a single flat note; present them as one entry.
        entries = record.get("entries")
        if entries is None:
            entries = [record]

        for i, e in enumerate(entries, start=1):
            lines += [
                "",
                f"ENTRY {i}  ·  {when(e.get('date'))} UTC  ·  {e.get('author') or record.get('investigator') or 'Unknown author'}",
                rule,
                "  Summary",
                f"    {val(e.get('summary'))}",
                "  Findings",
            ]
            lines += [f"    {ln}" for ln in str(val(e.get("findings"))).splitlines()] or ["    —"]
            lines += [
                field("Emails", e.get("emails", [])),
                field("Phones", e.get("phones", [])),
                field("Usernames", e.get("usernames", [])),
                field("Names", e.get("names", [])),
                field("IP addresses", e.get("ips", [])),
            ]
            for src in e.get("sources", []) or []:
                lines.append(f"  Source         {src}")
            attachments = e.get("attachments") or []
            if attachments:
                lines.append(field("Attachments", [a.get("filename", "") for a in attachments]))

        return "\n".join(lines)

def main():
    app = QApplication(sys.argv)
    app.setStyle("Fusion")

    palette = QPalette()
    palette.setColor(QPalette.ColorRole.Window, QColor(MABU_BG))
    palette.setColor(QPalette.ColorRole.WindowText, QColor(MABU_TEXT))
    palette.setColor(QPalette.ColorRole.Base, QColor(MABU_INPUT_BG))
    palette.setColor(QPalette.ColorRole.Text, QColor(MABU_TEXT))
    palette.setColor(QPalette.ColorRole.Highlight, QColor(MABU_PRIMARY))
    app.setPalette(palette)

    window = MabuReaderApp()
    window.show()
    sys.exit(app.exec())


if __name__ == "__main__":
    main()

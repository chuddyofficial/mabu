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
MABU_VERSION = 1

MABU_GREEN = "#00ff66"
MABU_GREEN_BRIGHT = "#5dffa0"
MABU_GREEN_DIM = "#0e5c28"
MABU_BORDER = "#1f7a38"
MABU_BG = "#030905"
MABU_PANEL = "#050f08"
MABU_INPUT_BG = "#010601"
MABU_TEXT = "#baffc9"
MABU_TEXT_DIM = "#6fbf8a"
MABU_RED = "#ff3b5c"
MABU_AMBER = "#ffb000"


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
    if version != MABU_VERSION:
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
    font-family: "Cascadia Code", "Consolas", monospace;
    font-size: 12.5px;
}}

QLabel#titleLabel {{
    color: {MABU_GREEN};
    font-size: 20px;
    font-weight: 700;
    letter-spacing: 2px;
}}

QLabel#subLabel {{
    color: {MABU_TEXT_DIM};
    font-size: 11px;
}}

QLabel.fieldLabel {{
    color: {MABU_TEXT_DIM};
    font-size: 11px;
    font-weight: 600;
}}

QFrame#panel {{
    background-color: {MABU_PANEL};
    border: 1px solid {MABU_BORDER};
    border-radius: 6px;
}}

QLineEdit {{
    background-color: {MABU_INPUT_BG};
    border: 1px solid {MABU_BORDER};
    border-radius: 4px;
    padding: 8px 10px;
    color: {MABU_TEXT};
    selection-background-color: {MABU_GREEN};
    selection-color: #000000;
}}

QLineEdit:focus {{
    border: 1px solid {MABU_GREEN};
}}

QPushButton {{
    background-color: transparent;
    border: 1px solid {MABU_GREEN_DIM};
    border-radius: 4px;
    color: {MABU_GREEN};
    padding: 9px 18px;
    font-weight: 600;
}}

QPushButton:hover {{
    background-color: rgba(0, 255, 102, 0.10);
    border: 1px solid {MABU_GREEN};
}}

QPushButton:pressed {{
    background-color: rgba(0, 255, 102, 0.18);
}}

QPushButton#browseBtn {{
    border: 1px solid {MABU_BORDER};
    color: {MABU_TEXT_DIM};
    padding: 8px 14px;
}}

QPushButton#browseBtn:hover {{
    border: 1px solid {MABU_GREEN_DIM};
    color: {MABU_GREEN};
}}

QTextEdit#readerBox {{
    background-color: #010601;
    border: 1px solid {MABU_BORDER};
    border-radius: 6px;
    color: {MABU_GREEN_BRIGHT};
    padding: 12px;
    font-size: 12px;
}}

QLabel#statusLabel {{
    font-size: 11.5px;
}}

QScrollBar:vertical {{
    background: {MABU_BG};
    width: 10px;
}}

QScrollBar::handle:vertical {{
    background: {MABU_BORDER};
    border-radius: 4px;
    min-height: 24px;
}}

QScrollBar::handle:vertical:hover {{
    background: {MABU_GREEN_DIM};
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
        title = QLabel("MABU READER")
        title.setObjectName("titleLabel")
        sub = QLabel("local .mabu file viewer — no external calls")
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

        file_label = QLabel("> select .mabu file")
        file_label.setProperty("class", "fieldLabel")
        file_layout.addWidget(file_label)

        file_row = QHBoxLayout()
        self.file_input = QLineEdit()
        self.file_input.setPlaceholderText("no file selected")
        self.file_input.setReadOnly(True)
        browse_btn = QPushButton("browse...")
        browse_btn.setObjectName("browseBtn")
        browse_btn.clicked.connect(self.on_browse)
        file_row.addWidget(self.file_input, 1)
        file_row.addWidget(browse_btn)
        file_layout.addLayout(file_row)

        pass_label = QLabel("> passphrase (leave blank to use default vault key)")
        pass_label.setProperty("class", "fieldLabel")
        file_layout.addWidget(pass_label)

        self.passphrase_input = QLineEdit()
        self.passphrase_input.setPlaceholderText("passphrase (optional)")
        self.passphrase_input.setEchoMode(QLineEdit.EchoMode.Password)
        self.passphrase_input.returnPressed.connect(self.on_decrypt)
        file_layout.addWidget(self.passphrase_input)

        action_row = QHBoxLayout()
        decrypt_btn = QPushButton("decrypt_and_view()")
        decrypt_btn.clicked.connect(self.on_decrypt)
        self.status_label = QLabel("")
        self.status_label.setObjectName("statusLabel")
        action_row.addWidget(decrypt_btn)
        action_row.addWidget(self.status_label, 1)
        file_layout.addLayout(action_row)

        root.addWidget(file_panel)

        # Reader output panel
        reader_label = QLabel("> stdout")
        reader_label.setProperty("class", "fieldLabel")
        root.addWidget(reader_label)

        self.reader_box = QTextEdit()
        self.reader_box.setObjectName("readerBox")
        self.reader_box.setReadOnly(True)
        self.reader_box.setPlainText("nothing decrypted yet.")
        mono = QFont("Cascadia Code")
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
            self.set_status("select a file first.", MABU_AMBER)
            return
        if not os.path.isfile(path):
            self.set_status("file not found.", MABU_RED)
            return

        passphrase = self.passphrase_input.text() or None

        self.set_status("decrypting...", MABU_TEXT_DIM)
        QApplication.processEvents()

        try:
            record = decrypt_mabu_file(path, passphrase)
        except InvalidToken:
            self.set_status("error: wrong passphrase or corrupted file", MABU_RED)
            self.reader_box.setPlainText("decryption failed. check the passphrase and try again.")
            return
        except ValueError as e:
            self.set_status(f"error: {e}", MABU_RED)
            self.reader_box.setPlainText(str(e))
            return
        except Exception as e:
            self.set_status(f"unexpected error: {e}", MABU_RED)
            return

        self.set_status("decrypted successfully.", MABU_GREEN)
        self.reader_box.setPlainText(self._format_record(path, record))

    @staticmethod
    def _format_record(path: str, record: dict) -> str:
        def field(label, value):
            if isinstance(value, list):
                value = ", ".join(str(v) for v in value) if value else "(none)"
            return f"{label:<14} {value if value not in (None, '') else '(none)'}"

        lines = [
            "=" * 62,
            f" {record.get('title', 'Untitled')}",
            "=" * 62,
            field("file:", os.path.basename(path)),
            field("date:", record.get("date")),
            field("investigator:", record.get("investigator")),
            field("tags:", record.get("tags", [])),
            "",
            "SUMMARY",
            "-" * 62,
            record.get("summary") or "(none)",
            "",
            "FINDINGS",
            "-" * 62,
            record.get("findings") or "(none)",
            "",
            "IDENTIFIERS",
            "-" * 62,
            field("emails:", record.get("emails", [])),
            field("phones:", record.get("phones", [])),
            field("usernames:", record.get("usernames", [])),
            field("names:", record.get("names", [])),
            field("ips:", record.get("ips", [])),
            "",
            "SOURCES",
            "-" * 62,
        ]
        sources = record.get("sources", [])
        if sources:
            lines.extend(f"  - {s}" for s in sources)
        else:
            lines.append("(none)")

        return "\n".join(lines)


def main():
    app = QApplication(sys.argv)
    app.setStyle("Fusion")

    palette = QPalette()
    palette.setColor(QPalette.ColorRole.Window, QColor(MABU_BG))
    palette.setColor(QPalette.ColorRole.WindowText, QColor(MABU_TEXT))
    app.setPalette(palette)

    window = MabuReaderApp()
    window.show()
    sys.exit(app.exec())


if __name__ == "__main__":
    main()

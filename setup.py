#!/usr/bin/env python3
"""
setup.py — MABU installer / first-run configuration wizard.

Run this once after cloning the repo (locally or on the VPS) to:
  1. Verify Python dependencies are installed
  2. Generate the vault encryption key (vault/.mabu-default-key)
  3. Generate the session signing secret (config/session-secret.key)
  4. Create the first (and only) admin account, with a bcrypt-hashed password
  5. Create the vault directory structure

Safe to re-run: it will not overwrite an existing admin account or vault key
unless you pass --reset-admin / --reset-vault-key explicitly.

Usage:
    python setup.py
    python setup.py --reset-admin      # replace the admin account
"""

import argparse
import getpass
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "api"))

BANNER = r"""
  __  __    _    ____  _   _
 |  \/  |  / \  | __ )| | | |
 | |\/| | / _ \ |  _ \| | | |
 | |  | |/ ___ \| |_) | |_| |
 |_|  |_/_/   \_\____/ \___/

 MABU Installer — first-run setup
"""


def check_dependencies():
    missing = []
    for module, package in [
        ("flask", "Flask"),
        ("flask_cors", "Flask-Cors"),
        ("cryptography", "cryptography"),
        ("bcrypt", "bcrypt"),
    ]:
        try:
            __import__(module)
        except ImportError:
            missing.append(package)

    if missing:
        print("Missing required packages:", ", ".join(missing))
        print("\nInstall them with:")
        print("    pip install -r api/requirements.txt")
        sys.exit(1)


def prompt_password(prompt: str) -> str:
    while True:
        pw = getpass.getpass(prompt)
        if len(pw) < 8:
            print("  Password must be at least 8 characters. Try again.")
            continue
        confirm = getpass.getpass("Confirm password: ")
        if pw != confirm:
            print("  Passwords did not match. Try again.")
            continue
        return pw


def main():
    parser = argparse.ArgumentParser(description="MABU first-run setup wizard.")
    parser.add_argument("--reset-admin", action="store_true", help="Replace the existing admin account")
    parser.add_argument("--reset-vault-key", action="store_true", help="Generate a new vault encryption key (WARNING: makes existing default-key-encrypted .mabu files unreadable)")
    parser.add_argument("--username", help="Admin username (skips prompt; password is still prompted securely)")
    args = parser.parse_args()

    print(BANNER)
    check_dependencies()

    import mabu_auth
    import mabu_format as fmt

    # 1. Vault directory
    os.makedirs(fmt.vault_dir(), exist_ok=True)
    print(f"[1/4] Vault directory ready: {fmt.vault_dir()}")

    # 2. Vault encryption key
    if args.reset_vault_key and os.path.exists(fmt.default_key_path()):
        os.remove(fmt.default_key_path())
        print("[2/4] Existing vault key removed (--reset-vault-key).")
    if os.path.exists(fmt.default_key_path()):
        print("[2/4] Vault encryption key already exists — keeping it.")
    else:
        fmt.get_default_key()
        print("[2/4] Generated new vault encryption key.")

    # 3. Session secret
    mabu_auth.get_or_create_session_secret()
    print("[3/4] Session signing secret ready.")

    # 4. Admin account
    if mabu_auth.is_configured() and not args.reset_admin:
        existing = mabu_auth.get_admin_username()
        print(f"[4/4] Admin account already exists (username: {existing}).")
        print("       Re-run with --reset-admin to replace it.")
    else:
        print("[4/4] Create the admin account.\n")
        username = args.username or input("Admin username: ").strip()
        while not username:
            username = input("Admin username (cannot be blank): ").strip()
        password = prompt_password("Admin password (min 8 characters): ")
        mabu_auth.create_admin(username, password)
        print(f"\n       Admin account created for '{username}'.")

    print("\nSetup complete. Start the server with:")
    print("    python api/mabu-server.py")
    print("\nThen open the dashboard in your browser and log in.")


if __name__ == "__main__":
    main()

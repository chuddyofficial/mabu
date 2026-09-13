#!/usr/bin/env python3
"""
migrate_vault.py — one-time migration of legacy v1 .mabu files to the v2
case-file schema (multi-entry cases, status, activity log).

Every file is backed up to vault/mabu-files-backup-<timestamp>/ before any
file on disk is rewritten. Files already in v2 format, or protected by a
passphrase other than the default vault key, are reported and skipped
(re-run with --passphrase to handle a specific protected file).

Usage:
    python migrate_vault.py                  # migrate all default-key files
    python migrate_vault.py --dry-run         # show what would change, no writes
    python migrate_vault.py -f case.mabu -p mypass   # migrate one protected file
"""

import argparse
import os
import shutil
import sys
from datetime import datetime, timezone

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "api"))

from cryptography.fernet import InvalidToken
import mabu_format as fmt


def migrate_file(path: str, passphrase: str | None, dry_run: bool) -> str:
    with open(path, "rb") as f:
        data = f.read()

    key = fmt.derive_key_from_passphrase(passphrase) if passphrase else fmt.get_default_key()

    try:
        record, version = fmt.parse_mabu_file_raw(data, key)
    except InvalidToken:
        return "SKIPPED (wrong passphrase / not default key)"
    except ValueError as e:
        return f"SKIPPED ({e})"

    if version == fmt.MABU_VERSION:
        return "SKIPPED (already v2)"

    upgraded = fmt.upgrade_v1_to_v2(record)

    if dry_run:
        return f"WOULD MIGRATE -> case_id={upgraded['case_id']}"

    new_blob = fmt.build_mabu_file(upgraded, passphrase, version=fmt.MABU_VERSION)
    with open(path, "wb") as f:
        f.write(new_blob)

    return f"MIGRATED -> case_id={upgraded['case_id']}"


def main():
    parser = argparse.ArgumentParser(description="Migrate legacy .mabu files to v2 case schema.")
    parser.add_argument("-f", "--file", help="Migrate a single specific file instead of the whole vault")
    parser.add_argument("-p", "--passphrase", help="Passphrase for the file given with -f")
    parser.add_argument("--dry-run", action="store_true", help="Report what would happen without writing anything")
    args = parser.parse_args()

    vdir = fmt.vault_dir()

    if args.file:
        targets = [args.file]
    else:
        if not os.path.isdir(vdir):
            print(f"Vault directory not found: {vdir}")
            sys.exit(1)
        targets = [os.path.join(vdir, f) for f in sorted(os.listdir(vdir)) if f.endswith(".mabu")]

    if not targets:
        print("No .mabu files found.")
        return

    if not args.dry_run:
        stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
        backup_dir = os.path.join(vdir, f"..\\mabu-files-backup-{stamp}")
        backup_dir = os.path.normpath(backup_dir)
        os.makedirs(backup_dir, exist_ok=True)
        for path in targets:
            if os.path.isfile(path):
                shutil.copy2(path, os.path.join(backup_dir, os.path.basename(path)))
        print(f"Backed up {len(targets)} file(s) to {backup_dir}\n")

    print(f"{'DRY RUN — ' if args.dry_run else ''}Migrating {len(targets)} file(s)...\n")
    for path in targets:
        if not os.path.isfile(path):
            print(f"  {os.path.basename(path)}: NOT FOUND")
            continue
        result = migrate_file(path, args.passphrase, args.dry_run)
        print(f"  {os.path.basename(path)}: {result}")

    print("\nDone.")


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""
setup.py — MABU installer / configuration wizard.

Run this once after cloning the repo (locally or on a VPS) to fully prepare
MABU to run:

  1. Detect the environment (Windows/macOS/Linux, local vs likely-VPS)
  2. Check for and optionally auto-install missing Python dependencies
  3. Create the vault directory structure
  4. Generate the vault encryption key (vault/.mabu-default-key)
  5. Generate the session signing secret (config/session-secret.key)
  6. Create the first (and only) admin account, with a bcrypt-hashed password
  7. Optionally configure a public domain:
       - writes config/domain.txt
       - generates deploy/nginx.conf (ready to copy to /etc/nginx/sites-available/)
       - generates deploy/mabu.service (ready to copy to /etc/systemd/system/)
       - prints the exact commands to enable HTTPS with certbot
  8. Print a final summary of what's configured and what to do next

Safe to re-run: nothing destructive happens unless you explicitly pass a
--reset-* flag. Every step is independently skippable/idempotent.

Usage:
    python setup.py                              # interactive, full wizard
    python setup.py --non-interactive             # accept defaults, skip prompts (CI/scripted installs)
    python setup.py --reset-admin                 # replace the admin account
    python setup.py --reset-vault-key             # regenerate the vault encryption key (WARNING: see below)
    python setup.py --domain mabu.example.com      # (re)configure the public domain + regenerate deploy/ files
    python setup.py --skip-deps                    # don't check/install Python dependencies
    python setup.py --username admin --password-env MABU_ADMIN_PW   # fully non-interactive admin creation
"""

import argparse
import getpass
import os
import platform
import re
import subprocess
import sys

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(BASE_DIR, "api"))

CONFIG_DIR = os.path.join(BASE_DIR, "config")
DOMAIN_FILE = os.path.join(CONFIG_DIR, "domain.txt")
DEPLOY_DIR = os.path.join(BASE_DIR, "deploy")
NGINX_TEMPLATE_PATH = os.path.join(DEPLOY_DIR, "nginx.conf")
SYSTEMD_TEMPLATE_PATH = os.path.join(DEPLOY_DIR, "mabu.service")

REQUIRED_PACKAGES = [
    ("flask", "Flask>=3.0.0"),
    ("flask_cors", "Flask-Cors>=4.0.0"),
    ("cryptography", "cryptography>=42.0.0"),
    ("bcrypt", "bcrypt>=4.0.0"),
    ("whois", "python-whois>=0.9.0"),
    ("reportlab", "reportlab>=4.0.0"),
    ("phonenumbers", "phonenumbers>=8.13.0"),
    ("PIL", "Pillow>=10.0.0"),
]

BANNER = r"""
  __  __    _    ____  _   _
 |  \/  |  / \  | __ )| | | |
 | |\/| | / _ \ |  _ \| | | |
 | |  | |/ ___ \| |_) | |_| |
 |_|  |_/_/   \_\____/ \___/

 MABU Installer — configuration wizard
"""

DOMAIN_RE = re.compile(r"^(?=.{1,253}$)([a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$")


def hr(char="-", width=60):
    print(char * width)


def step(n, total, label):
    print(f"\n[{n}/{total}] {label}")


# ---------------------------------------------------------------------------
# Environment detection
# ---------------------------------------------------------------------------

def detect_environment() -> dict:
    system = platform.system()
    is_linux = system == "Linux"
    is_root = is_linux and hasattr(os, "geteuid") and os.geteuid() == 0

    likely_vps = False
    if is_linux:
        # Heuristic: no desktop session env vars typically present on a VPS.
        likely_vps = not any(os.environ.get(v) for v in ("DISPLAY", "XDG_CURRENT_DESKTOP", "WAYLAND_DISPLAY"))

    return {
        "system": system,
        "python_version": platform.python_version(),
        "is_linux": is_linux,
        "is_root": is_root,
        "likely_vps": likely_vps,
    }


# ---------------------------------------------------------------------------
# Dependency management
# ---------------------------------------------------------------------------

def check_dependencies() -> list[str]:
    missing = []
    for module, pip_spec in REQUIRED_PACKAGES:
        try:
            __import__(module)
        except ImportError:
            missing.append(pip_spec)
    return missing


def install_dependencies(pip_specs: list[str]) -> bool:
    requirements_path = os.path.join(BASE_DIR, "api", "requirements.txt")
    print(f"  Installing from {requirements_path} ...")
    result = subprocess.run(
        [sys.executable, "-m", "pip", "install", "-r", requirements_path],
        cwd=BASE_DIR,
    )
    return result.returncode == 0


# ---------------------------------------------------------------------------
# Prompts
# ---------------------------------------------------------------------------

def prompt_yes_no(prompt: str, default: bool = True) -> bool:
    suffix = "[Y/n]" if default else "[y/N]"
    while True:
        ans = input(f"{prompt} {suffix}: ").strip().lower()
        if not ans:
            return default
        if ans in ("y", "yes"):
            return True
        if ans in ("n", "no"):
            return False
        print("  Please answer y or n.")


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


def prompt_domain() -> str | None:
    while True:
        raw = input("Public domain (e.g. mabu.example.com), or blank to skip: ").strip().lower()
        if not raw:
            return None
        if not DOMAIN_RE.match(raw):
            print("  That doesn't look like a valid domain/subdomain. Try again, or leave blank to skip.")
            continue
        return raw


# ---------------------------------------------------------------------------
# Domain / deployment file generation
# ---------------------------------------------------------------------------

NGINX_TEMPLATE = """\
server {{
    listen 80;
    server_name {domain};

    location / {{
        root {base_dir};
        index index.html;
        try_files $uri $uri/ =404;
    }}

    location /api/ {{
        proxy_pass http://127.0.0.1:5057;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }}
}}
"""

SYSTEMD_TEMPLATE = """\
[Unit]
Description=MABU Research Platform
After=network.target

[Service]
Type=simple
User={service_user}
WorkingDirectory={base_dir}/api
Environment=PATH={base_dir}/venv/bin
Environment=MABU_PUBLIC_ORIGIN=https://{domain}
ExecStart={base_dir}/venv/bin/python mabu-server.py
Restart=on-failure

[Install]
WantedBy=multi-user.target
"""


def write_domain_config(domain: str, service_user: str):
    os.makedirs(CONFIG_DIR, exist_ok=True)
    with open(DOMAIN_FILE, "w", encoding="utf-8") as f:
        f.write(domain + "\n")

    os.makedirs(DEPLOY_DIR, exist_ok=True)

    with open(NGINX_TEMPLATE_PATH, "w", encoding="utf-8") as f:
        f.write(NGINX_TEMPLATE.format(domain=domain, base_dir=BASE_DIR.replace("\\", "/")))

    with open(SYSTEMD_TEMPLATE_PATH, "w", encoding="utf-8") as f:
        f.write(SYSTEMD_TEMPLATE.format(domain=domain, base_dir=BASE_DIR.replace("\\", "/"), service_user=service_user))


def get_configured_domain() -> str | None:
    if os.path.isfile(DOMAIN_FILE):
        with open(DOMAIN_FILE, "r", encoding="utf-8") as f:
            value = f.read().strip()
            return value or None
    return None


def print_domain_next_steps(domain: str):
    hr("=")
    print(f"Domain configured: {domain}")
    print(f"Generated: deploy/nginx.conf, deploy/mabu.service")
    print()
    print("On the VPS, run:")
    print(f"    sudo cp deploy/nginx.conf /etc/nginx/sites-available/mabu")
    print(f"    sudo ln -sf /etc/nginx/sites-available/mabu /etc/nginx/sites-enabled/mabu")
    print(f"    sudo nginx -t && sudo systemctl reload nginx")
    print(f"    sudo cp deploy/mabu.service /etc/systemd/system/mabu.service")
    print(f"    sudo systemctl daemon-reload")
    print(f"    sudo systemctl enable --now mabu")
    print()
    print("Then issue a real TLS certificate:")
    print(f"    sudo apt install -y certbot python3-certbot-nginx")
    print(f"    sudo certbot --nginx -d {domain}")
    print()
    print("certbot will edit the nginx config to redirect http -> https automatically.")
    print(f"After that, MABU will be live at: https://{domain}")
    hr("=")


# ---------------------------------------------------------------------------
# Status summary
# ---------------------------------------------------------------------------

def print_summary(env: dict):
    import mabu_auth
    import mabu_format as fmt

    hr("=")
    print("MABU STATUS SUMMARY")
    hr("=")
    print(f"  Platform:            {env['system']} (Python {env['python_version']})")
    print(f"  Vault directory:     {fmt.vault_dir()}")
    print(f"  Vault key:           {'present' if os.path.exists(fmt.default_key_path()) else 'MISSING'}")
    print(f"  Session secret:      {'present' if os.path.exists(os.path.join(CONFIG_DIR, 'session-secret.key')) else 'MISSING'}")

    if mabu_auth.is_configured():
        print(f"  Admin account:       configured (username: {mabu_auth.get_admin_username()})")
    else:
        print(f"  Admin account:       NOT CONFIGURED")

    domain = get_configured_domain()
    print(f"  Public domain:       {domain or '(not configured — running local-only)'}")

    n_cases = 0
    if os.path.isdir(fmt.vault_dir()):
        n_cases = len([f for f in os.listdir(fmt.vault_dir()) if f.endswith(".mabu")])
    print(f"  Case files in vault: {n_cases}")
    hr("=")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(
        description="MABU installer / configuration wizard.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("--reset-admin", action="store_true", help="Replace the existing admin account")
    parser.add_argument("--reset-vault-key", action="store_true",
                         help="Generate a new vault encryption key (WARNING: makes existing default-key-encrypted .mabu files unreadable)")
    parser.add_argument("--username", help="Admin username (skips prompt)")
    parser.add_argument("--password-env", help="Name of an environment variable holding the admin password (avoids interactive prompt / shell history)")
    parser.add_argument("--domain", help="Public domain to configure non-interactively (e.g. mabu.example.com); pass an empty string to clear it")
    parser.add_argument("--service-user", default="mabu", help="Linux user the systemd service should run as (default: mabu)")
    parser.add_argument("--skip-deps", action="store_true", help="Skip the dependency check/install step")
    parser.add_argument("--non-interactive", action="store_true", help="Never prompt; accept safe defaults and skip optional steps not fully specified via flags")
    args = parser.parse_args()

    print(BANNER)
    env = detect_environment()
    print(f"Detected: {env['system']}, Python {env['python_version']}"
          + (", likely VPS/headless" if env["likely_vps"] else ""))
    if env["is_root"]:
        print("WARNING: running as root. MABU (and the systemd service) should run as a dedicated non-root user in production.")

    total_steps = 6

    # 1. Dependencies
    step(1, total_steps, "Checking Python dependencies")
    if args.skip_deps:
        print("  Skipped (--skip-deps).")
    else:
        missing = check_dependencies()
        if not missing:
            print("  All required packages are installed.")
        else:
            print("  Missing:", ", ".join(missing))
            should_install = not args.non_interactive and prompt_yes_no("  Install them now via pip?", default=True)
            if args.non_interactive or should_install:
                if install_dependencies(missing):
                    print("  Dependencies installed successfully.")
                else:
                    print("  pip install failed — install manually with:")
                    print("      pip install -r api/requirements.txt")
                    sys.exit(1)
            else:
                print("  Skipping install. Run later with: pip install -r api/requirements.txt")
                sys.exit(1)

    import mabu_auth
    import mabu_format as fmt

    # 2. Vault directory
    step(2, total_steps, "Preparing vault directory")
    os.makedirs(fmt.vault_dir(), exist_ok=True)
    print(f"  Ready: {fmt.vault_dir()}")

    # 3. Vault encryption key
    step(3, total_steps, "Vault encryption key")
    if args.reset_vault_key and os.path.exists(fmt.default_key_path()):
        if not args.non_interactive:
            confirmed = prompt_yes_no(
                "  This will make existing default-key-encrypted .mabu files unreadable. Continue?",
                default=False,
            )
            if not confirmed:
                print("  Aborted key reset.")
                sys.exit(1)
        os.remove(fmt.default_key_path())
        print("  Existing vault key removed.")
    if os.path.exists(fmt.default_key_path()):
        print("  Vault key already exists — keeping it.")
    else:
        fmt.get_default_key()
        print("  Generated new vault encryption key.")

    # 4. Session secret
    step(4, total_steps, "Session signing secret")
    mabu_auth.get_or_create_session_secret()
    print("  Ready.")

    # 5. Admin account
    step(5, total_steps, "Admin account")
    if mabu_auth.is_configured() and not args.reset_admin:
        print(f"  Already configured (username: {mabu_auth.get_admin_username()}).")
        print("  Re-run with --reset-admin to replace it.")
    else:
        username = args.username
        if not username:
            if args.non_interactive:
                print("  ERROR: --non-interactive requires --username (and --password-env or a TTY for the password).")
                sys.exit(1)
            username = input("  Admin username: ").strip()
            while not username:
                username = input("  Admin username (cannot be blank): ").strip()

        if args.password_env:
            password = os.environ.get(args.password_env, "")
            if len(password) < 8:
                print(f"  ERROR: environment variable {args.password_env} is unset or shorter than 8 characters.")
                sys.exit(1)
        elif args.non_interactive:
            print("  ERROR: --non-interactive requires --password-env to supply the admin password.")
            sys.exit(1)
        else:
            password = prompt_password("  Admin password (min 8 characters): ")

        mabu_auth.create_admin(username, password)
        print(f"  Admin account created for '{username}'.")

    # 6. Domain / deployment config
    step(6, total_steps, "Public domain (optional)")
    if args.domain is not None:
        if args.domain == "":
            if os.path.isfile(DOMAIN_FILE):
                os.remove(DOMAIN_FILE)
            print("  Domain configuration cleared.")
        else:
            write_domain_config(args.domain, args.service_user)
            print_domain_next_steps(args.domain)
    elif not args.non_interactive:
        existing_domain = get_configured_domain()
        if existing_domain:
            print(f"  Currently configured: {existing_domain}")
            if prompt_yes_no("  Reconfigure it?", default=False):
                domain = prompt_domain()
                if domain:
                    write_domain_config(domain, args.service_user)
                    print_domain_next_steps(domain)
                else:
                    print("  Skipped — keeping existing domain configuration.")
        else:
            if prompt_yes_no("  Configure a public domain now (for VPS/nginx deployment)?", default=env["likely_vps"]):
                domain = prompt_domain()
                if domain:
                    write_domain_config(domain, args.service_user)
                    print_domain_next_steps(domain)
                else:
                    print("  Skipped — MABU will run local-only (http://127.0.0.1:5057).")
    else:
        print("  Skipped (--non-interactive without --domain).")

    print_summary(env)

    print("\nNext steps:")
    if get_configured_domain():
        print("  See the deployment commands printed above, then visit your domain once nginx + certbot are set up.")
    else:
        print("  Start the server:  python api/mabu-server.py")
        print("  Then open index.html in a browser and log in.")


if __name__ == "__main__":
    main()

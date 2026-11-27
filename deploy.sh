#!/usr/bin/env bash
# Production deploy on a Debian/Ubuntu server, in one command:
#
#   sudo ./deploy.sh mabu.example.com [you@example.com]
#
# Installs system packages (nginx, certbot, Python venv), the app's Python
# dependencies, runs first-time setup (asks for an admin username + password
# only if no account exists yet), installs the generated nginx site and
# systemd service, starts MABU, and gets an HTTPS certificate.
#
# The service runs as the user who owns this checkout (whoever ran sudo).
# Safe to re-run after a `git pull`: every step is idempotent and the
# service is restarted at the end.
set -euo pipefail

DOMAIN="${1:-}"
EMAIL="${2:-}"
if [ -z "$DOMAIN" ]; then
  echo "usage: sudo ./deploy.sh <domain> [email-for-letsencrypt]" >&2
  exit 1
fi
if [ "$(id -u)" -ne 0 ]; then
  echo "[mabu] run this with sudo:  sudo ./deploy.sh $DOMAIN" >&2
  exit 1
fi

APP_DIR="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"
RUN_USER="${SUDO_USER:-root}"
cd "$APP_DIR"
as_app() { if [ "$RUN_USER" = root ]; then "$@"; else sudo -u "$RUN_USER" -H "$@"; fi; }

echo "[mabu] installing system packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq python3 python3-venv python3-pip nginx certbot python3-certbot-nginx curl >/dev/null

echo "[mabu] installing Python dependencies into $APP_DIR/venv"
[ -x venv/bin/pip ] || as_app python3 -m venv venv
as_app venv/bin/pip install --quiet --disable-pip-version-check -r api/requirements.txt

echo "[mabu] configuring MABU for $DOMAIN (service user: $RUN_USER)"
# Prompts for an admin username/password only when no account exists yet.
as_app venv/bin/python setup.py --skip-deps --domain "$DOMAIN" --service-user "$RUN_USER"
echo "[mabu] (this script now performs the nginx/systemd/certbot steps listed above for you)"
as_app venv/bin/python -c "import sys; sys.path.insert(0, 'api'); import mabu_auth; sys.exit(0 if mabu_auth.is_configured() else 1)" \
  || { echo "[mabu] no admin account was created; re-run and enter a username/password when asked." >&2; exit 1; }

echo "[mabu] installing nginx site"
cp deploy/nginx.conf /etc/nginx/sites-available/mabu
ln -sf /etc/nginx/sites-available/mabu /etc/nginx/sites-enabled/mabu
nginx -t
systemctl enable --now nginx >/dev/null 2>&1 || true
systemctl reload nginx

echo "[mabu] installing and starting the mabu service"
cp deploy/mabu.service /etc/systemd/system/mabu.service
systemctl daemon-reload
systemctl enable mabu >/dev/null 2>&1
systemctl restart mabu

for _ in $(seq 1 30); do
  curl -fs -o /dev/null http://127.0.0.1:5057/api/health 2>/dev/null && break
  sleep 1
done
if ! curl -fsS -o /dev/null http://127.0.0.1:5057/api/health; then
  echo "[mabu] the service did not come up. Last log lines:" >&2
  journalctl -u mabu -n 30 --no-pager >&2 || true
  exit 1
fi
echo "[mabu] service is running"

if command -v ufw >/dev/null && ufw status | grep -q "Status: active"; then
  ufw allow 'Nginx Full' >/dev/null
fi

# Let's Encrypt validates over the internet, so only try when the domain
# actually resolves to this machine.
SERVER_IP="$(curl -fs -4 --max-time 10 https://api.ipify.org 2>/dev/null || true)"
DOMAIN_IP="$(getent ahostsv4 "$DOMAIN" | awk 'NR==1 {print $1}' || true)"
if [ -n "$SERVER_IP" ] && [ -n "$DOMAIN_IP" ] && [ "$SERVER_IP" != "$DOMAIN_IP" ]; then
  echo "[mabu] $DOMAIN points to $DOMAIN_IP, but this server is $SERVER_IP." >&2
  echo "[mabu] Fix the DNS A record, wait for it to update, then re-run this script for HTTPS." >&2
  echo "[mabu] MABU itself is installed and running; only DNS (and therefore HTTPS) is missing." >&2
  exit 1
fi

echo "[mabu] requesting HTTPS certificate"
if [ -n "$EMAIL" ]; then
  certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos --redirect -m "$EMAIL"
else
  certbot --nginx -d "$DOMAIN" --redirect
fi

echo
echo "[mabu] done. MABU is live at https://$DOMAIN"

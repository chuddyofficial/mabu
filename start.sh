#!/usr/bin/env bash
# Start MABU locally with one command:  ./start.sh
#   - creates ./venv and installs the server's Python dependencies into it
#   - runs first-time setup (keys + admin account) if it hasn't been done yet
#   - starts the server; then open http://127.0.0.1:5057 in your browser
# Safe to run every time — each step skips itself once it's already done.
set -euo pipefail
cd "$(dirname "$0")"

if [ ! -x venv/bin/pip ]; then
  echo "[mabu] creating virtual environment in ./venv"
  if ! python3 -m venv venv; then
    rm -rf venv
    echo "[mabu] could not create a virtual environment."
    echo "       On Debian/Ubuntu install it with:  sudo apt install python3-venv"
    exit 1
  fi
fi

echo "[mabu] checking dependencies"
venv/bin/pip install --quiet --disable-pip-version-check -r api/requirements.txt

if ! venv/bin/python -c "import sys; sys.path.insert(0, 'api'); import mabu_auth; sys.exit(0 if mabu_auth.is_configured() else 1)"; then
  echo "[mabu] first run: generating keys and creating your admin account"
  venv/bin/python setup.py --skip-deps
fi

echo "[mabu] starting — open http://127.0.0.1:5057 in your browser (Ctrl+C to stop)"
cd api
exec ../venv/bin/python mabu-server.py

#!/usr/bin/env bash
# Deploy / update C-Drive dengan pm2. Aman dijalankan berulang (idempotent).
set -euo pipefail
cd "$(dirname "$0")/.."

PYTHON="${PYTHON:-/usr/bin/python3}"
APP=c-drive

[ -d venv ] || "$PYTHON" -m venv venv
venv/bin/pip install -q --upgrade pip
venv/bin/pip install -q -r requirements.txt

if [ ! -f .env ]; then
  cp .env.example .env && chmod 600 .env
  echo ">> .env dibuat dari .env.example"
fi
if ! grep -qE "^ADMIN_PASSWORD_HASH=.+" .env; then
  echo "!! ADMIN_PASSWORD_HASH belum diisi. Jalankan: venv/bin/python scripts/set-password.py"
  exit 1
fi

mkdir -p data
venv/bin/python -m py_compile app.py

if pm2 describe "$APP" >/dev/null 2>&1; then
  pm2 reload ecosystem.config.cjs --update-env
else
  pm2 start ecosystem.config.cjs
fi
pm2 save >/dev/null

PORT="$(grep -E '^PORT=' .env | tail -n1 | cut -d= -f2 | tr -d "'\" " || true)"
PORT="${PORT:-8000}"
for i in 1 2 3 4 5 6 7 8 9 10; do
  if curl -fsS "http://127.0.0.1:${PORT}/healthz" >/dev/null 2>&1; then
    echo ">> OK: $(curl -fsS "http://127.0.0.1:${PORT}/healthz")"
    exit 0
  fi
  sleep 1
done
echo "!! Health check gagal. Lihat: pm2 logs $APP --lines 50"
exit 1

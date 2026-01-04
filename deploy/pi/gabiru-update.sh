#!/usr/bin/env bash
set -euo pipefail

APP_DIR="/opt/gabiru"
BACKEND_DIR="$APP_DIR/backend"
VENV_PY="$BACKEND_DIR/.venv/bin/python"
SERVICE_SRC="$APP_DIR/deploy/pi/gabiru.service"
SERVICE_DST="/etc/systemd/system/gabiru.service"
UPDATE_SERVICE_SRC="$APP_DIR/deploy/pi/gabiru-update.service"
UPDATE_SERVICE_DST="/etc/systemd/system/gabiru-update.service"
UPDATE_TIMER_SRC="$APP_DIR/deploy/pi/gabiru-update.timer"
UPDATE_TIMER_DST="/etc/systemd/system/gabiru-update.timer"

if [[ ! -d "$APP_DIR" ]]; then
  exit 0
fi

if ! command -v git >/dev/null 2>&1; then
  exit 0
fi

cd "$APP_DIR"
if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  exit 0
fi

# Ensure we have an upstream (origin/main etc)
if ! git rev-parse --abbrev-ref --symbolic-full-name @{u} >/dev/null 2>&1; then
  exit 0
fi

git fetch --prune

LOCAL_SHA="$(git rev-parse HEAD)"
REMOTE_SHA="$(git rev-parse @{u})"

if [[ "$LOCAL_SHA" == "$REMOTE_SHA" ]]; then
  exit 0
fi

echo "[gabiru-update] Updating $LOCAL_SHA -> $REMOTE_SHA"

git pull --ff-only

# Keep systemd units canonical.
# Users sometimes edit /etc/systemd/system/gabiru.service and accidentally add
# non-comment text which systemd then ignores, causing confusing behavior.
if [[ -f "$SERVICE_SRC" ]]; then
  install -m 0644 "$SERVICE_SRC" "$SERVICE_DST" || true
fi
if [[ -f "$UPDATE_SERVICE_SRC" ]]; then
  install -m 0644 "$UPDATE_SERVICE_SRC" "$UPDATE_SERVICE_DST" || true
fi
if [[ -f "$UPDATE_TIMER_SRC" ]]; then
  install -m 0644 "$UPDATE_TIMER_SRC" "$UPDATE_TIMER_DST" || true
fi

# Ensure venv exists (first install might not have run yet)
if [[ ! -x "$VENV_PY" ]]; then
  python3 -m venv "$BACKEND_DIR/.venv"
fi

"$VENV_PY" -m pip install -U pip >/dev/null
"$VENV_PY" -m pip install -r "$BACKEND_DIR/requirements.txt" >/dev/null

systemctl daemon-reload || true
systemctl restart gabiru.service

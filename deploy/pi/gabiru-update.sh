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
WIFI_SERVICE_SRC="$APP_DIR/deploy/pi/gabiru-wifi.service"
WIFI_SERVICE_DST="/etc/systemd/system/gabiru-wifi.service"

LOG_FILE="$BACKEND_DIR/data/update.log"
mkdir -p "$(dirname "$LOG_FILE")"

# Append logs and also show in journal.
exec >>"$LOG_FILE" 2>&1

echo ""
echo "[gabiru-update] ==== $(date -Is) ===="

if [[ ! -d "$APP_DIR" ]]; then
  exit 0
fi

_install_units() {
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
  if [[ -f "$WIFI_SERVICE_SRC" ]]; then
    install -m 0644 "$WIFI_SERVICE_SRC" "$WIFI_SERVICE_DST" || true
  fi

  chmod 0755 "$APP_DIR/deploy/pi/gabiru-wifi.sh" || true
}

_ensure_venv_and_deps() {
  # Ensure venv exists (first install might not have run yet)
  if [[ ! -x "$VENV_PY" ]]; then
    python3 -m venv "$BACKEND_DIR/.venv"
  fi

  "$VENV_PY" -m pip install -U pip >/dev/null
  "$VENV_PY" -m pip install -r "$BACKEND_DIR/requirements.txt" >/dev/null
}

_restart_services() {
  systemctl daemon-reload || true
  systemctl restart gabiru.service
  systemctl restart gabiru-wifi.service || true
}

_zip_update() {
  local url tmp zip src
  url="${GABIRU_UPDATE_ZIP_URL:-https://github.com/tonymichaelb/Gabiru/archive/refs/heads/main.zip}"

  if ! command -v curl >/dev/null 2>&1; then
    echo "[gabiru-update] curl not found; cannot run zip update"
    exit 1
  fi
  if ! command -v unzip >/dev/null 2>&1; then
    echo "[gabiru-update] unzip not found; cannot run zip update"
    exit 1
  fi
  if ! command -v rsync >/dev/null 2>&1; then
    echo "[gabiru-update] rsync not found; cannot run zip update"
    exit 1
  fi

  tmp="$(mktemp -d)"
  zip="$tmp/src.zip"

  echo "[gabiru-update] ZIP update from: $url"
  curl -fsSL -o "$zip" "$url"
  unzip -q "$zip" -d "$tmp"

  # GitHub zips usually extract into a single top-level folder.
  src="$(find "$tmp" -mindepth 1 -maxdepth 1 -type d | head -n 1)"
  if [[ -z "${src:-}" || ! -d "$src" ]]; then
    echo "[gabiru-update] Could not locate extracted source directory"
    exit 1
  fi

  echo "[gabiru-update] Syncing files (preserving data/ and venv)"
  rsync -a --delete \
    --exclude ".git" \
    --exclude ".venv" \
    --exclude "backend/.venv" \
    --exclude "backend/data" \
    --exclude "backend/data/" \
    "$src"/ "$APP_DIR"/

  rm -rf "$tmp" || true
}

cd "$APP_DIR"

did_git_update=0
if command -v git >/dev/null 2>&1 && git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  if git rev-parse --abbrev-ref --symbolic-full-name @{u} >/dev/null 2>&1; then
    echo "[gabiru-update] Git update mode"
    git fetch --prune
    LOCAL_SHA="$(git rev-parse HEAD)"
    REMOTE_SHA="$(git rev-parse @{u})"
    if [[ "$LOCAL_SHA" != "$REMOTE_SHA" ]]; then
      echo "[gabiru-update] Updating $LOCAL_SHA -> $REMOTE_SHA"
      git pull --ff-only
      did_git_update=1
    else
      echo "[gabiru-update] Already up-to-date ($LOCAL_SHA)"
    fi
  else
    echo "[gabiru-update] No upstream configured; falling back to ZIP update"
  fi
else
  echo "[gabiru-update] Git repo not detected; using ZIP update"
fi

if [[ "$did_git_update" -eq 0 ]]; then
  _zip_update
fi

_install_units
_ensure_venv_and_deps
_restart_services

echo "[gabiru-update] Done"

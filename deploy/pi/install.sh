#!/usr/bin/env bash
set -euo pipefail

# Instala o Gabiru em /opt/gabiru e cria um serviço systemd.
# Uso (no Raspberry Pi):
#   sudo bash deploy/pi/install.sh

APP_DIR="/opt/gabiru"
BACKEND_DIR="$APP_DIR/backend"
REPO_URL="${GABIRU_REPO:-https://github.com/tonymichaelb/Gabiru.git}"
BRANCH="${GABIRU_BRANCH:-main}"

echo "[1/6] Instalando dependências do sistema..."
apt-get update -y
apt-get install -y python3 python3-venv python3-pip git curl unzip rsync

# Wi-Fi setup / hotspot fallback (best-effort)
apt-get install -y network-manager || true

# Timelapse prerequisites (best-effort; packages vary by distro/release)
apt-get install -y ffmpeg || true
apt-get install -y libcamera-apps || true
apt-get install -y fswebcam || true

echo "[2/6] Criando diretórios..."
mkdir -p "$APP_DIR"

echo "[3/6] Obtendo código do GitHub..."
if [[ -d "$APP_DIR/.git" ]]; then
	sudo -u pi git -C "$APP_DIR" fetch --prune
	sudo -u pi git -C "$APP_DIR" checkout "$BRANCH"
	sudo -u pi git -C "$APP_DIR" pull --ff-only
else
	rm -rf "$APP_DIR"/*
	sudo -u pi git clone --depth 1 --branch "$BRANCH" "$REPO_URL" "$APP_DIR"
fi

echo "[4/6] Criando venv e instalando requirements..."
cd "$BACKEND_DIR"
python3 -m venv .venv
"$BACKEND_DIR/.venv/bin/python" -m pip install -U pip
"$BACKEND_DIR/.venv/bin/python" -m pip install -r requirements.txt

echo "[5/6] Instalando systemd units..."
install -m 0644 "$APP_DIR/deploy/pi/gabiru.service" /etc/systemd/system/gabiru.service
chmod 0755 "$APP_DIR/deploy/pi/gabiru-update.sh" || true
install -m 0644 "$APP_DIR/deploy/pi/gabiru-update.service" /etc/systemd/system/gabiru-update.service
install -m 0644 "$APP_DIR/deploy/pi/gabiru-update.timer" /etc/systemd/system/gabiru-update.timer
chmod 0755 "$APP_DIR/deploy/pi/gabiru-wifi.sh" || true
install -m 0644 "$APP_DIR/deploy/pi/gabiru-wifi.service" /etc/systemd/system/gabiru-wifi.service
systemctl daemon-reload
systemctl enable gabiru.service
systemctl enable gabiru-update.timer
systemctl enable gabiru-wifi.service || true

echo "[6/6] Iniciando serviços..."
systemctl restart gabiru.service
systemctl restart gabiru-update.timer
systemctl restart gabiru-wifi.service || true

echo "OK: Gabiru rodando em http://<ip-do-pi>:8080"

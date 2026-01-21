#!/usr/bin/env bash
set -euo pipefail

# Script para atualizar o Gabiru via Docker no Raspberry Pi
# Uso: sudo bash deploy/pi/update-docker.sh

REPO_DIR="/opt/gabiru"

echo "[1/5] Parando container atual..."
cd "$REPO_DIR"
docker compose down || true

echo "[2/5] Atualizando código do GitHub..."
git pull

echo "[3/5] Buildando nova imagem Docker localmente..."
docker build -t tonymichael/gabiru:latest .

echo "[4/5] Limpando imagens antigas..."
docker image prune -f

echo "[5/5] Iniciando container com nova imagem..."
docker compose up -d

echo "✅ Atualização completa! Verifique os logs:"
echo "   docker logs -f gabiru"

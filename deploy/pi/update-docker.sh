#!/usr/bin/env bash
set -euo pipefail

# Script para atualizar o Gabiru via Docker no Raspberry Pi
# Uso: sudo bash deploy/pi/update-docker.sh (rode de dentro do diretório /opt/Gabiru ou /opt/gabiru)

# Usa o diretório atual ao invés de hardcoded
REPO_DIR="$(pwd)"

echo "[1/5] Parando container atual..."
docker compose down || true

echo "[2/5] Atualizando código do GitHub..."
git pull

echo "[3/5] Limpando cache de build..."
docker builder prune -af

echo "[4/5] Buildando nova imagem Docker (SEM CACHE)..."
docker build --no-cache --pull -t tonymichael/gabiru:latest .

echo "[5/5] Iniciando container com nova imagem..."
docker compose up -d

echo ""
echo "✅ Atualização completa!"
echo ""
echo "Verificando container:"
docker ps | grep gabiru || echo "⚠️  Container não rodando!"
echo ""
echo "Para ver logs: docker logs -f gabiru"
echo "Acesse: http://$(hostname -I | awk '{print $1}'):8080"

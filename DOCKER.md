# Instalação via Docker

## Pré-requisitos

```bash
# Instalar Docker e Docker Compose no Raspberry Pi
curl -sSL https://get.docker.com | sh
sudo usermod -aG docker pi
sudo apt-get install -y docker-compose
```

## Instalação

```bash
# Clonar repositório
cd /tmp
rm -rf Gabiru
git clone https://github.com/tonymichaelb/Gabiru.git
cd Gabiru

# Build da imagem
docker build -t gabiru .

# Iniciar container
docker-compose up -d

# Ver logs
docker logs -f gabiru
```

## Acesso

- **URL**: http://IP_DO_RASPBERRY:8080
- **Dados**: `/var/lib/docker/volumes/gabiru-data/_data`

## Parar/Reiniciar

```bash
# Parar
docker-compose down

# Reiniciar
docker-compose restart gabiru

# Ver status
docker ps
```

## Troubleshooting

```bash
# Ver logs completos
docker logs gabiru

# Entrar no container
docker exec -it gabiru bash

# Listar portas
docker ps --no-trunc
```

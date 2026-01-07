# Gabiru

MVP de gerenciamento de impressora 3D (estilo OctoPrint): conexão serial, upload e execução de G-code, status em tempo real via WebSocket.

## Rodar (dev)

1) Crie/ative um ambiente Python (3.10+ recomendado).

No macOS, o caminho mais previsível é usar um `venv` dentro de `backend/`.

2) Crie o `venv` e instale dependências:

```bash
cd backend
python3 -m venv .venv
./.venv/bin/python -m pip install -U pip
./.venv/bin/python -m pip install -r requirements.txt
```

3) Inicie o servidor:

```bash
./.venv/bin/python -m uvicorn app.main:app --reload --host 127.0.0.1 --port 8080
```

4) Abra no navegador:

- http://localhost:8080

## Observações

- Este MVP implementa um fluxo básico de streaming de G-code aguardando `ok`.
- Recursos “Chroma/Palette” ficam como ponto de extensão (ainda não implementado).
- Se a lista de portas estiver vazia, conecte a impressora via USB e clique em “Atualizar portas”.

## Time-lapse

O Gabiru tem um time-lapse simples:

- Captura frames a cada N segundos
- Gera um `timelapse.mp4` (precisa de `ffmpeg`)

### Requisitos no Raspberry Pi

- `ffmpeg`
- Uma ferramenta de captura de imagem:
	- Camera Module: `rpicam-still` (mais comum em imagens mais novas), ou `libcamera-still` (em algumas distros), pacote `libcamera-apps`, ou
	- Webcam USB: `fswebcam`

O instalador do Pi tenta instalar isso automaticamente.

### Como usar

No painel web, use a seção **Time-lapse**:

- **Iniciar**: começa a capturar frames
- **Parar e gerar vídeo**: para e gera o `timelapse.mp4`
- **Baixar último** / lista: baixa os vídeos gerados

Configuração via variáveis de ambiente:

- `GABIRU_TIMELAPSE_INTERVAL_S` (padrão: 10)
- `GABIRU_TIMELAPSE_FPS` (padrão: 30)
- `GABIRU_TIMELAPSE_AUTOSTART` (padrão: 0) — se `1`, inicia/para junto com o job
- `GABIRU_TIMELAPSE_MODE` (padrão: `interval`) — `interval` (a cada N segundos) ou `layer` (estilo OctoPrint: 1 frame por camada durante a impressão)

## Raspberry Pi Zero 2 W (deploy)

O Gabiru foi pensado para rodar como serviço (auto-start) no Raspberry Pi.

1) No Pi, clone/copie este repositório.
2) Rode o instalador (como root):

```bash
sudo bash deploy/pi/install.sh
```

3) Acesse no navegador:

- `http://<ip-do-pi>:8080`

### Wi‑Fi fallback (hotspot)

Opcional: quando o Pi não estiver conectado a nenhuma rede Wi‑Fi, ele pode criar um hotspot
para você entrar e configurar o Wi‑Fi pelo painel.

- SSID padrão: `Chroma-Setup`
- Senha padrão: `chroma-setup`

O instalador tenta instalar `network-manager` e ativa o serviço:

- [deploy/pi/gabiru-wifi.service](deploy/pi/gabiru-wifi.service)

Você pode ajustar SSID/senha editando `/etc/systemd/system/gabiru-wifi.service`.

### Auto-update (toda vez que você subir atualização)

O instalador ativa um `systemd timer` que roda periodicamente e faz:

- `git pull` em `/opt/gabiru`
- reinstala dependências (se necessário)
- reinicia o `gabiru.service`

Por padrão ele verifica a cada ~5 minutos.

Comandos úteis no Pi:

```bash
sudo systemctl status gabiru-update.timer
sudo journalctl -u gabiru-update.service -n 200 --no-pager
```

Se o seu repositório for privado, você vai precisar configurar autenticação no Pi (ex.: deploy key ou token). Para repo público, funciona direto.

## Publicar no GitHub

Repositório alvo:

- https://github.com/tonymichaelb/Gabiru.git

No seu mac (na raiz do projeto):

```bash
git init
git add -A
git commit -m "Initial commit"
git branch -M main
git remote add origin https://github.com/tonymichaelb/Gabiru.git
git push -u origin main
```

### Auto-connect

O serviço já vem com `GABIRU_AUTOCONNECT=1` em [deploy/pi/gabiru.service](deploy/pi/gabiru.service).

- Se você já conectou uma vez pela UI, ele vai reutilizar a última porta/baudrate salvos em `backend/data/config.json`.
- Opcionalmente, você pode fixar a porta/baudrate editando o unit file e reiniciando o serviço:

```bash
sudo systemctl daemon-reload
sudo systemctl restart gabiru.service
```

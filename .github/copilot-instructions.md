# Gabiru - Instruções para Agentes de IA

Gabiru é um sistema de gerenciamento de impressora 3D (MVP estilo OctoPrint) projetado para rodar em Raspberry Pi. Fornece streaming serial de G-code, status em tempo real via WebSocket, gravação de timelapse e gerenciamento Wi-Fi opcional.

## Visão Geral da Arquitetura

**Componentes Principais:**
- `SerialManager` ([serial_manager.py](../backend/app/serial_manager.py)): Comunicação serial thread-safe com impressoras. Usa locks assíncronos (`_cmd_lock`) para sequenciamento de comandos, aguarda respostas `ok`, faz parsing de temperatura de respostas `M105` usando regex.
- `JobManager` ([job_manager.py](../backend/app/job_manager.py)): Gerencia trabalhos de impressão G-code. Envia linhas uma a uma aguardando `ok`, suporta pause/resume via `asyncio.Event`, implementa detecção de camadas para timelapse, status LED RGB via `M150`.
- `TimelapseManager` ([timelapse_manager.py](../backend/app/timelapse_manager.py)): Dois modos - `interval` (frames periódicos) e `layer` (sob demanda). Auto-detecta ferramentas de câmera (`rpicam-still` > `libcamera-still` > `fswebcam`). Gera MP4 com `ffmpeg`.
- `WifiManager` ([wifi_manager.py](../backend/app/wifi_manager.py)): Usa NetworkManager (`nmcli`) para gerenciamento de rede, cria hotspot fallback quando desconectado (SSID: `Chroma-Setup`).
- `FilamentSensor` ([filament_sensor.py](../backend/app/filament_sensor.py)): Detecção opcional de falta de filamento via GPIO usando `gpiozero` com fallback para `RPi.GPIO`.

**Padrão WebSocket Hub:**
- Classe `WsHub` em [main.py](../backend/app/main.py) gerencia conexões WebSocket com broadcast async-safe para todos os clientes
- Task em background `_status_broadcast_loop()` envia atualizações de status a cada 1 segundo, consulta temperaturas a cada 5 segundos com `M105`
- Todas as mudanças de estado fazem broadcast imediatamente através do hub

**Autenticação:**
- Auth baseado em JWT ([auth.py](../backend/app/auth.py)) com hashing de senha bcrypt
- "Modo setup": se não existem usuários, auth é opcional via dependency `optional_auth`
- Registro do primeiro usuário auto-habilitado, usuários subsequentes requerem autenticação
- Usuários armazenados em arquivo JSON ([user_db.py](../backend/app/user_db.py))

## Fluxo de Desenvolvimento

**Desenvolvimento Local (macOS/Linux):**
```bash
cd backend
python3 -m venv .venv
./.venv/bin/python -m pip install -U pip
./.venv/bin/python -m pip install -r requirements.txt
./.venv/bin/python -m uvicorn app.main:app --reload --host 127.0.0.1 --port 8080
```

**Deploy no Raspberry Pi:**
- Script de instalação: `sudo bash deploy/pi/install.sh` (clona para `/opt/gabiru`, cria serviço systemd)
- Três serviços systemd: `gabiru.service`, `gabiru-wifi.service` (fallback hotspot), `gabiru-update.timer` (auto-update via git pull)
- Serviço roda como usuário `pi`, usa venv em `/opt/gabiru/backend/.venv`

**Docker:**
- Build: `docker build -t gabiru .`
- Run: `docker-compose up -d` (requer `--privileged` para acesso serial/GPIO)
- Dispositivo serial montado como `/dev/ttyACM0` no container

## Convenções Específicas do Projeto

**Tratamento de Erros:**
- Operações seriais: padrão "best-effort" - ignora erros para recursos opcionais (LEDs RGB via `M150`, polling de temperatura)
- Use `try/except` com `pass` para operações não-críticas (autostart de timelapse, updates de LED)
- Operações críticas (envio serial durante impressão) usam `async with` locks e levantam exceção em falha

**Padrões Async:**
- Sempre use `async with self._lock` para modificações de estado compartilhado
- Comandos seriais usam dois locks: `_cmd_lock` para sequenciamento de comandos, `_lock` para estado de conexão
- Tasks em background criadas com `asyncio.create_task()`, armazenadas para cancelamento no cleanup

**Configuração:**
- Variáveis de ambiente prefixadas com `GABIRU_` ([settings.py](../backend/app/settings.py))
- Config persistente em `data/config.json` via `ConfigStore` ([config_store.py](../backend/app/config_store.py))
- Prioridade de settings: env vars > arquivo config > defaults

**Caminhos de Arquivo:**
- Todas operações de arquivo fazem resolve de paths e validam contra diretórios esperados (segurança: previne directory traversal)
- Exemplo: `path.resolve()` depois verifica `if expected_dir.resolve() not in path.parents`

**Frontend:**
- Vanilla JS ([static/app.js](../backend/app/static/app.js)), sem framework
- WebSocket para atualizações em tempo real, REST API para ações
- App single-page com fluxo de login

## Especificidades de Câmera/Timelapse

**Ordem de Detecção de Ferramentas:**
1. `rpicam-still` (Raspberry Pi OS mais novo)
2. `libcamera-still` (mais antigo mas ainda recente)
3. `fswebcam` (webcams USB)

**Detecção de Camadas:**
- Faz parsing de comentários do slicer: `LAYER_CHANGE`, `;LAYER:N`
- Usa deduplicação baseada em hash para evitar frames duplicados por camada
- Ver `_should_capture_layer_frame()` em [job_manager.py](../backend/app/job_manager.py)

## Armadilhas Comuns

- **GPIO em sistemas não-Pi**: `FilamentSensor` trata graciosamente bibliotecas GPIO ausentes (fallback para estado "unavailable")
- **Permissões de porta serial**: Usuário deve estar no grupo `dialout` no Linux (instalador cuida disso)
- **Timelapse ffmpeg**: Verificar se `ffmpeg` está instalado antes de iniciar timelapse, senão geração falha silenciosamente
- **Gerenciamento Wi-Fi**: Requer NetworkManager; setups antigos de Pi com `wpa_supplicant` não funcionam com `WifiManager`

## Arquivos Chave para Entender

- [main.py](../backend/app/main.py): App FastAPI, todos endpoints, gerenciamento de lifespan, WebSocket hub
- [models.py](../backend/app/models.py): Modelos Pydantic para requests/responses da API
- [README.md](../README.md): Documentação para usuário, instruções de deploy
- [deploy/pi/install.sh](../deploy/pi/install.sh): Automação completa de instalação para Pi

## Testes/Debugging

- Não há testes automatizados atualmente - testes manuais via web UI
- Verificar logs: `sudo journalctl -u gabiru -f` (no Pi)
- Logs Docker: `docker logs -f gabiru`
- Debug serial: Adicione `print()` statements em `_reader_loop()` para ver respostas brutas da impressora

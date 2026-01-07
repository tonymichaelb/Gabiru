from __future__ import annotations

import asyncio
import os
import shutil
import subprocess
from pathlib import Path
from typing import Any
from typing import Optional

from contextlib import asynccontextmanager

from fastapi import FastAPI, File, HTTPException, UploadFile, WebSocket, WebSocketDisconnect, Depends
from fastapi.responses import Response
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from serial.tools import list_ports

from .auth import (
    UserCreate,
    UserLogin,
    Token,
    ChangePassword,
    create_access_token,
    get_current_user,
    is_password_too_long,
)
from .config_store import ConfigStore
from . import user_db


# Optional auth dependency: if no users exist, allow access
async def optional_auth(current_user: Optional[str] = Depends(get_current_user)) -> Optional[str]:
    """
    Optional authentication - if no users exist (setup mode), allow access.
    Otherwise require valid JWT token.
    """
    if not user_db.has_users():
        return None  # Setup mode, no auth required
    return current_user  # Auth required, return current user
from .gcode_thumbnail import extract_thumbnail
from .gcode_toolpath import extract_toolpath
from .job_manager import JobManager
from .models import (
    ConnectRequest,
    StartJobRequest,
    StatusResponse,
    WsClientCommand,
    PrinterConnectionState,
    JobState,
    SetTemperatureRequest,
    WifiConnectRequest,
)
from .serial_manager import SerialManager
from .settings import get_settings
from .timelapse_manager import TimelapseManager
from .wifi_manager import WifiManager
from .filament_sensor import FilamentSensor

settings = get_settings()
settings.uploads_dir.mkdir(parents=True, exist_ok=True)
settings.timelapse_dir.mkdir(parents=True, exist_ok=True)

serial_manager = SerialManager()
config_store = ConfigStore(settings.config_path)
timelapse_manager = TimelapseManager(
    timelapse_dir=settings.timelapse_dir,
    interval_s=settings.timelapse_interval_s,
    fps=settings.timelapse_fps,
)
wifi_manager = WifiManager()
filament_sensor = FilamentSensor(gpio=17)
job_manager = JobManager(
    serial_manager=serial_manager,
    uploads_dir=settings.uploads_dir,
    timelapse_manager=timelapse_manager,
    timelapse_mode=settings.timelapse_mode,
)


class WsHub:
    def __init__(self) -> None:
        self._clients: set[WebSocket] = set()
        self._lock = asyncio.Lock()

    async def add(self, ws: WebSocket) -> None:
        async with self._lock:
            self._clients.add(ws)

    async def remove(self, ws: WebSocket) -> None:
        async with self._lock:
            self._clients.discard(ws)

    async def broadcast(self, msg: dict[str, Any]) -> None:
        async with self._lock:
            clients = list(self._clients)
        for ws in clients:
            try:
                await ws.send_json(msg)
            except Exception:
                await self.remove(ws)


hub = WsHub()


async def _status_broadcast_loop() -> None:
    ticks = 0
    last_job_state: JobState = JobState.idle
    while True:
        try:
            # Poll temps periodically (lightweight; doesn't wait for ok)
            if serial_manager.is_connected and (ticks % 5 == 0):
                try:
                    await serial_manager.send("M105")
                except Exception:
                    pass

            # Timelapse autostart/stop based on job transitions (optional; best-effort)
            if settings.timelapse_autostart:
                try:
                    cur_state = job_manager.info.state
                    cur_file = job_manager.info.filename
                    if cur_state == JobState.printing and last_job_state == JobState.idle and cur_file:
                        await timelapse_manager.start(label=cur_file, mode=settings.timelapse_mode)
                    if cur_state == JobState.idle and last_job_state != JobState.idle and timelapse_manager.info.running:
                        await timelapse_manager.stop()
                    last_job_state = cur_state
                except Exception:
                    pass

            await hub.broadcast({"type": "status", "data": _make_status().model_dump()})
        except Exception:
            pass
        ticks += 1
        await asyncio.sleep(1.0)


@asynccontextmanager
async def lifespan(_: FastAPI):
    status_task = asyncio.create_task(_status_broadcast_loop())

    if settings.autoconnect:
        cfg = config_store.load()
        port = settings.port or cfg.port
        baud = settings.baudrate or cfg.baudrate
        if port:
            try:
                await serial_manager.connect(port=port, baudrate=baud)
                await serial_manager.send("M105")
            except Exception:
                pass

    try:
        yield
    finally:
        try:
            if timelapse_manager.info.running:
                await timelapse_manager.stop()
        except Exception:
            pass
        try:
            filament_sensor.close()
        except Exception:
            pass
        status_task.cancel()
        try:
            await status_task
        except asyncio.CancelledError:
            pass
        except Exception:
            pass
        await serial_manager.disconnect()


app = FastAPI(title="Gabiru", version="0.3.4", lifespan=lifespan)


# ---------- Authentication Endpoints ----------

@app.get("/api/auth/status")
async def auth_status():
    """Check if authentication is required (no users = setup mode)."""
    return {"has_users": user_db.has_users()}


@app.post("/api/auth/register", response_model=Token)
async def register(user: UserCreate):
    """Register first user (only works if no users exist)."""
    if user_db.has_users():
        raise HTTPException(status_code=400, detail="Já existe um usuário cadastrado")
    
    if not user.username or len(user.username) < 3:
        raise HTTPException(status_code=400, detail="O nome de usuário deve ter pelo menos 3 caracteres")
    
    if not user.password or len(user.password) < 6:
        raise HTTPException(status_code=400, detail="A senha deve ter pelo menos 6 caracteres")

    if is_password_too_long(user.password):
        raise HTTPException(
            status_code=400,
            detail="Senha muito longa. Use uma senha menor (até 72 caracteres; acentos/emoji contam mais).",
        )
    
    if user.password != user.password_confirm:
        raise HTTPException(status_code=400, detail="As senhas não coincidem")
    
    try:
        user_db.create_user(username=user.username, password=user.password)
        token = create_access_token(data={"sub": user.username})
        return Token(access_token=token)
    except ValueError as e:
        # Mensagens de validação em português
        raise HTTPException(status_code=400, detail=str(e))


@app.post("/api/auth/login", response_model=Token)
async def login(credentials: UserLogin):
    """Login with username and password."""
    if is_password_too_long(credentials.password):
        raise HTTPException(
            status_code=400,
            detail="Senha muito longa. Use uma senha menor (até 72 caracteres; acentos/emoji contam mais).",
        )

    user = user_db.authenticate_user(username=credentials.username, password=credentials.password)
    if not user:
        raise HTTPException(status_code=401, detail="Usuário ou senha inválidos")
    
    token = create_access_token(data={"sub": user.username})
    return Token(access_token=token)


@app.get("/api/auth/me")
async def get_me(current_user: str = Depends(get_current_user)):
    """Get current authenticated user."""
    return {"username": current_user}


@app.post("/api/auth/change-password")
async def change_password(payload: ChangePassword, current_user: str = Depends(get_current_user)):
    """Change password for the current authenticated user."""
    if not payload.new_password or len(payload.new_password) < 6:
        raise HTTPException(status_code=400, detail="A nova senha deve ter pelo menos 6 caracteres")

    if is_password_too_long(payload.new_password):
        raise HTTPException(
            status_code=400,
            detail="Senha muito longa. Use uma senha menor (até 72 caracteres; acentos/emoji contam mais).",
        )

    if payload.new_password != payload.new_password_confirm:
        raise HTTPException(status_code=400, detail="As senhas não coincidem")

    try:
        user_db.change_password(
            username=current_user,
            current_password=payload.current_password,
            new_password=payload.new_password,
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    return {"ok": True}


@app.post("/api/auth/users")
async def create_additional_user(user: UserCreate, _: str = Depends(get_current_user)):
    """Create additional users (requires authentication)."""
    if not user.username or len(user.username) < 3:
        raise HTTPException(status_code=400, detail="O nome de usuário deve ter pelo menos 3 caracteres")

    if not user.password or len(user.password) < 6:
        raise HTTPException(status_code=400, detail="A senha deve ter pelo menos 6 caracteres")

    if is_password_too_long(user.password):
        raise HTTPException(
            status_code=400,
            detail="Senha muito longa. Use uma senha menor (até 72 caracteres; acentos/emoji contam mais).",
        )

    if user.password != user.password_confirm:
        raise HTTPException(status_code=400, detail="As senhas não coincidem")

    try:
        user_db.create_user(username=user.username, password=user.password)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    return {"ok": True, "username": user.username}


@app.post("/api/auth/reset-users")
async def reset_users(current_user: str = Depends(get_current_user)):
    """Reset (delete) all users. Disabled by default; enable with env var."""
    allow = (os.getenv("GABIRU_ALLOW_USER_RESET") or "").strip() == "1"
    if not allow:
        raise HTTPException(status_code=403, detail="Recurso desativado. Habilite GABIRU_ALLOW_USER_RESET=1")

    # Require auth (already ensured) and then wipe.
    user_db.reset_users()
    return {"ok": True, "by": current_user}


# ---------- Update helpers ----------

_REPO_ROOT = Path(__file__).resolve().parent.parent.parent


async def _run_cmd(*args: str, cwd: Optional[Path] = None, timeout: float = 20.0) -> tuple[int, str, str]:
    proc = await asyncio.create_subprocess_exec(
        *args,
        cwd=str(cwd) if cwd else None,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    try:
        out_b, err_b = await asyncio.wait_for(proc.communicate(), timeout=timeout)
    except asyncio.TimeoutError:
        proc.kill()
        raise
    out = out_b.decode(errors="replace") if out_b else ""
    err = err_b.decode(errors="replace") if err_b else ""
    return proc.returncode or 0, out.strip(), err.strip()


async def _git_rev(ref: str) -> Optional[str]:
    if not shutil.which("git"):
        return None
    if not (_REPO_ROOT / ".git").exists():
        return None
    rc, out, _ = await _run_cmd("git", "rev-parse", ref, cwd=_REPO_ROOT)
    return out if rc == 0 else None


async def _git_update_status() -> dict[str, Optional[str]]:
    local = await _git_rev("HEAD")
    upstream = await _git_rev("@{u}")
    pending = bool(local and upstream and local != upstream)
    return {"local": local, "upstream": upstream, "pending": pending}


def _read_build_id() -> Optional[str]:
    env_build = (os.getenv("GABIRU_BUILD") or os.getenv("GABIRU_VERSION") or "").strip()
    if env_build:
        return env_build

    # Best-effort: read git HEAD without invoking subprocess.
    try:
        here = Path(__file__).resolve()
        root = None
        for p in [here.parent, *here.parents]:
            if (p / ".git").exists():
                root = p
                break
        if root is None:
            return None
        head = (root / ".git" / "HEAD")
        if not head.exists():
            return None
        ref = head.read_text(encoding="utf-8").strip()
        if ref.startswith("ref:"):
            ref_path = ref.split(" ", 1)[-1].strip()
            sha_path = (root / ".git" / ref_path)
            if sha_path.exists():
                sha = sha_path.read_text(encoding="utf-8").strip()
            else:
                # Fallback to packed-refs
                packed = root / ".git" / "packed-refs"
                sha = ""
                if packed.exists():
                    for line in packed.read_text(encoding="utf-8").splitlines():
                        line = line.strip()
                        if not line or line.startswith("#") or line.startswith("^"):
                            continue
                        parts = line.split(" ")
                        if len(parts) == 2 and parts[1] == ref_path:
                            sha = parts[0]
                            break
            sha = (sha or "").strip()
        else:
            sha = ref
        if sha and all(c in "0123456789abcdef" for c in sha.lower()[:12]):
            return sha[:12]
    except Exception:
        return None
    return None


@app.get("/api/version")
async def api_version() -> dict[str, Optional[str]]:
    return {
        "version": getattr(app, "version", None),
        "build": _read_build_id(),
    }


@app.get("/api/update/status")
async def api_update_status() -> dict[str, Any]:
    """Report if there is an update pending (git)."""

    if not shutil.which("git") or not (_REPO_ROOT / ".git").exists():
        raise HTTPException(status_code=400, detail="git not available")

    try:
        status = await _git_update_status()
        status["version"] = getattr(app, "version", None)
        status["build"] = _read_build_id()
        return status
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.post("/api/update")
async def api_update() -> dict[str, str]:
    """Trigger an update on the Raspberry Pi and report whether a restart was attempted."""

    cmd: list[str] | None = None

    if shutil.which("systemctl"):
        cmd = ["systemctl", "start", "--no-block", "gabiru-update.service"]
    else:
        # Best-effort fallback: run the script if present.
        script = Path("/opt/gabiru/deploy/pi/gabiru-update.sh")
        if script.exists():
            cmd = [str(script)]

    if not cmd:
        raise HTTPException(status_code=400, detail="Update not supported on this host")

    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.DEVNULL,
        )
        asyncio.create_task(proc.wait())
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))

    return {"status": "started"}


@app.get("/api/update/log")
async def api_update_log() -> dict[str, str]:
    """Return the last part of the update log (best-effort)."""

    # On Raspberry installs, deploy/pi/gabiru-update.sh appends to backend/data/update.log
    path = settings.data_dir / "update.log"
    if not path.exists() or not path.is_file():
        return {"log": ""}
    try:
        # Keep payload small
        data = path.read_text(encoding="utf-8", errors="replace")
        return {"log": data[-20000:]}
    except Exception as e:
        return {"log": f"[erro] {e}\n"}


@app.get("/api/wifi/status")
async def api_wifi_status() -> dict[str, Any]:
    st = await wifi_manager.get_status()
    return {
        "available": st.available,
        "iface": st.iface,
        "connected": st.connected,
        "ssid": st.ssid,
        "hotspot_active": st.hotspot_active,
        "hotspot_ssid": st.hotspot_ssid,
        "ip4": st.ip4,
    }


@app.get("/api/wifi/saved")
async def api_wifi_saved() -> dict[str, list[str]]:
    """Get list of saved Wi-Fi networks."""
    try:
        saved = await wifi_manager.list_saved_networks()
        return {"saved": saved}
    except Exception:
        return {"saved": []}


@app.post("/api/wifi/scan")
async def api_wifi_scan() -> dict[str, Any]:
    st = await wifi_manager.get_status()
    if not st.available:
        raise HTTPException(status_code=400, detail="Wi-Fi management unavailable (need nmcli)")
    try:
        nets = await wifi_manager.scan()
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))
    return {
        "networks": [
            {"ssid": n.ssid, "signal": n.signal, "security": n.security}
            for n in nets
        ]
    }


@app.post("/api/wifi/hotspot/disable")
async def api_wifi_hotspot_disable() -> dict[str, str]:
    """Explicitly disable hotspot to allow Wi-Fi connection attempts."""
    try:
        ok = await wifi_manager.stop_hotspot()
        if ok:
            return {"status": "hotspot stopped"}
        return {"status": "failed to stop hotspot"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/wifi/hotspot/enable")
async def api_wifi_hotspot_enable() -> dict[str, str]:
    """Explicitly enable hotspot."""
    try:
        ok = await wifi_manager.start_hotspot()
        if ok:
            return {"status": "hotspot started"}
        return {"status": "failed to start hotspot"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/wifi/connect")
async def api_wifi_connect(req: WifiConnectRequest) -> dict[str, str]:
    st = await wifi_manager.get_status()
    if not st.available:
        raise HTTPException(status_code=400, detail="Wi-Fi management unavailable (need nmcli)")
    try:
        await wifi_manager.connect(ssid=req.ssid, password=req.password)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))

    return {"status": "connecting"}


@app.get("/api/timelapse/status")
async def api_timelapse_status() -> dict[str, Any]:
    return {
        "running": timelapse_manager.info.running,
        "session_dir": timelapse_manager.info.session_dir,
        "frames": timelapse_manager.info.frames,
        "label": timelapse_manager.info.label,
        "last_video": timelapse_manager.info.last_video,
        "mode": timelapse_manager.info.mode,
        "interval_s": settings.timelapse_interval_s,
        "fps": settings.timelapse_fps,
    }


@app.post("/api/timelapse/start")
async def api_timelapse_start(payload: Optional[dict[str, Any]] = None) -> dict[str, Any]:
    label = None
    if payload and isinstance(payload, dict):
        raw = payload.get("label")
        if isinstance(raw, str):
            label = raw.strip()[:120]
    try:
        info = await timelapse_manager.start(label=label)
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))
    return {
        "status": "started",
        "running": info.running,
        "session_dir": info.session_dir,
    }


@app.post("/api/timelapse/stop")
async def api_timelapse_stop() -> dict[str, Any]:
    try:
        info = await timelapse_manager.stop()
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))
    return {
        "status": "stopped",
        "running": info.running,
        "frames": info.frames,
        "last_video": info.last_video,
    }


@app.get("/api/timelapse/videos")
async def api_timelapse_videos() -> list[dict[str, object]]:
    return timelapse_manager.list_videos()


@app.get("/api/timelapse/video/{name:path}")
async def api_timelapse_video(name: str) -> FileResponse:
    try:
        path = timelapse_manager.resolve_video(name)
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid video name")
    if not path.exists() or not path.is_file():
        raise HTTPException(status_code=404, detail="Video not found")
    return FileResponse(path)


@app.get("/api/timelapse/live")
async def api_timelapse_live() -> FileResponse:
    path = timelapse_manager.latest_frame_path()
    if path is None or not path.exists() or not path.is_file():
        try:
            path = await timelapse_manager.capture_preview_frame()
        except Exception as e:
            try:
                print(f"[camera] live preview failed: {e}")
            except Exception:
                pass
            raise HTTPException(status_code=404, detail=f"Live preview failed: {e}")
    return FileResponse(path, media_type="image/jpeg", headers={"Cache-Control": "no-store"})


def _make_status() -> StatusResponse:
    if serial_manager.is_connected:
        connection = PrinterConnectionState.connected
    else:
        connection = PrinterConnectionState.disconnected

    return StatusResponse(
        connection=connection,
        port=serial_manager.state.port,
        baudrate=serial_manager.state.baudrate,
        job_state=job_manager.info.state,
        job_file=job_manager.info.filename,
        progress=job_manager.info.progress,
        job_line=job_manager.info.line,
        job_total_lines=job_manager.info.total_lines,
        hotend_c=serial_manager.state.hotend_c,
        bed_c=serial_manager.state.bed_c,
    )


def _on_serial_line(line: str) -> None:
    # Fire-and-forget to the WS hub
    asyncio.create_task(hub.broadcast({"type": "serial", "line": line}))


serial_manager.set_on_line_callback(_on_serial_line)


@app.get("/")
async def index() -> FileResponse:
    return FileResponse(Path(__file__).parent / "static" / "index.html")


app.mount("/static", StaticFiles(directory=Path(__file__).parent / "static"), name="static")


def _resolve_upload(name: str) -> Path:
    safe_name = Path((name or "").strip()).name
    path = (settings.uploads_dir / safe_name).resolve()
    if settings.uploads_dir.resolve() not in path.parents:
        raise HTTPException(status_code=400, detail="Invalid filename")
    return path


@app.delete("/api/files/{filename}")
async def api_files_delete(filename: str) -> dict[str, str]:
    # Only allow deleting .gcode files inside uploads_dir
    if not (filename or "").lower().endswith(".gcode"):
        raise HTTPException(status_code=400, detail="Only .gcode files are supported")

    path = _resolve_upload(filename)
    if not path.exists() or not path.is_file():
        raise HTTPException(status_code=404, detail="File not found")

    # Avoid deleting the file currently being printed/paused/etc.
    if job_manager.info.filename and Path(job_manager.info.filename).name == path.name:
        if job_manager.info.state != JobState.idle:
            raise HTTPException(status_code=409, detail="Cannot delete a file while it is in use by the current job")

    try:
        path.unlink()
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

    return {"status": "deleted", "filename": path.name}


@app.get("/api/ports")
async def api_ports() -> list[dict[str, str]]:
    ports = []
    for p in list_ports.comports():
        ports.append({"device": p.device, "description": p.description})
    return ports


@app.post("/api/printer/connect")
async def api_connect(req: ConnectRequest) -> dict[str, str]:
    try:
        await serial_manager.connect(port=req.port, baudrate=req.baudrate)
        try:
            config_store.save(port=req.port, baudrate=req.baudrate)
        except Exception:
            pass
        # Ask for temps periodically from UI; but do an initial ping
        await serial_manager.send("M105")
        return {"status": "connected"}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.post("/api/printer/disconnect")
async def api_disconnect() -> dict[str, str]:
    await serial_manager.disconnect()
    return {"status": "disconnected"}


@app.post("/api/printer/temperature")
async def api_set_temperature(req: SetTemperatureRequest) -> dict[str, Any]:
    if not serial_manager.is_connected:
        raise HTTPException(status_code=400, detail="Printer not connected")

    if req.hotend_c is None and req.bed_c is None:
        raise HTTPException(status_code=400, detail="Provide hotend_c and/or bed_c")

    # Use non-blocking set commands to avoid waiting for heat-up (M109/M190).
    try:
        if req.hotend_c is not None:
            # Typical safe range for most machines is <= 300C; model enforces <= 320.
            await serial_manager.send_and_wait_ok(f"M104 S{req.hotend_c:.0f}")
        if req.bed_c is not None:
            await serial_manager.send_and_wait_ok(f"M140 S{req.bed_c:.0f}")
        # Ask for an updated temperature report
        await serial_manager.send("M105")
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))

    return {"status": "ok", "hotend_c": req.hotend_c, "bed_c": req.bed_c}


@app.get("/api/status", response_model=StatusResponse)
async def api_status() -> StatusResponse:
    return _make_status()


@app.get("/api/filament/status")
async def api_filament_status() -> dict[str, Any]:
    return filament_sensor.get_status().to_dict()


@app.get("/api/files")
async def api_files() -> list[str]:
    settings.uploads_dir.mkdir(parents=True, exist_ok=True)
    return sorted([p.name for p in settings.uploads_dir.glob("*.gcode") if p.is_file()])


@app.get("/api/files/list")
async def api_files_list() -> list[dict[str, Any]]:
    settings.uploads_dir.mkdir(parents=True, exist_ok=True)
    out: list[dict[str, Any]] = []
    for p in sorted(settings.uploads_dir.glob("*.gcode")):
        if not p.is_file():
            continue
        try:
            st = p.stat()
        except Exception:
            continue
        # We don't parse thumbnails here to keep it fast; UI loads thumbnails on demand.
        out.append(
            {
                "filename": p.name,
                "size_bytes": int(st.st_size),
                "mtime": float(st.st_mtime),
            }
        )
    return out


@app.get("/api/files/thumbnail/{filename}")
async def api_files_thumbnail(filename: str) -> Response:
    path = _resolve_upload(filename)
    if not path.exists() or not path.is_file():
        raise HTTPException(status_code=404, detail="File not found")

    thumb = extract_thumbnail(path)
    if thumb is None:
        raise HTTPException(status_code=404, detail="Thumbnail not found")

    return Response(content=thumb.data, media_type=thumb.media_type)


@app.get("/api/files/toolpath/{filename}")
async def api_files_toolpath(filename: str, max_segments: int = 50000) -> dict[str, Any]:
    path = _resolve_upload(filename)
    if not path.exists() or not path.is_file():
        raise HTTPException(status_code=404, detail="File not found")

    max_segments = int(max_segments or 0)
    if max_segments <= 0:
        max_segments = 50000
    if max_segments > 200000:
        max_segments = 200000

    try:
        return extract_toolpath(path, max_segments=max_segments)
    except Exception:
        raise HTTPException(status_code=400, detail="Failed to parse G-code")


@app.post("/api/files/upload")
async def api_upload(file: UploadFile = File(...)) -> dict[str, str]:
    name = (file.filename or "").strip()
    if not name.lower().endswith(".gcode"):
        raise HTTPException(status_code=400, detail="Only .gcode files are supported")

    dest = settings.uploads_dir / Path(name).name
    content = await file.read()
    dest.write_bytes(content)
    return {"status": "uploaded", "filename": dest.name}


@app.post("/api/job/start")
async def api_job_start(req: StartJobRequest) -> dict[str, str]:
    try:
        await job_manager.start(req.filename)
        return {"status": "started"}
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="File not found")
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.post("/api/job/pause")
async def api_job_pause() -> dict[str, str]:
    await job_manager.pause()
    return {"status": "paused"}


@app.post("/api/job/resume")
async def api_job_resume() -> dict[str, str]:
    await job_manager.resume()
    return {"status": "resumed"}


@app.post("/api/job/cancel")
async def api_job_cancel() -> dict[str, str]:
    await job_manager.cancel()
    return {"status": "cancelled"}


@app.websocket("/ws")
async def ws_endpoint(ws: WebSocket) -> None:
    await ws.accept()
    await hub.add(ws)
    try:
        await ws.send_json({"type": "status", "data": _make_status().model_dump()})
        while True:
            raw = await ws.receive_json()
            cmd = WsClientCommand.model_validate(raw)
            if cmd.type == "send" and cmd.command:
                try:
                    await serial_manager.send(cmd.command)
                except Exception as e:
                    await ws.send_json({"type": "error", "message": str(e)})
            elif cmd.type == "poll":
                # Ask printer for temps; status broadcast will include last parsed temps
                if serial_manager.is_connected:
                    try:
                        await serial_manager.send("M105")
                    except Exception:
                        pass
                await ws.send_json({"type": "status", "data": _make_status().model_dump()})
    except WebSocketDisconnect:
        pass
    finally:
        await hub.remove(ws)

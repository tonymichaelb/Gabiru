from __future__ import annotations

import asyncio
import os
import shutil
from pathlib import Path
from typing import Any
from typing import Optional

from contextlib import asynccontextmanager

from fastapi import FastAPI, File, HTTPException, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.responses import Response
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from serial.tools import list_ports

from .config_store import ConfigStore
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
        status_task.cancel()
        try:
            await status_task
        except asyncio.CancelledError:
            pass
        except Exception:
            pass
        await serial_manager.disconnect()


app = FastAPI(title="Gabiru", version="0.3.1", lifespan=lifespan)


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


@app.post("/api/update")
async def api_update() -> dict[str, str]:
    """Trigger an update on the Raspberry Pi.

    Preferred path is systemd: start the oneshot gabiru-update.service.
    This endpoint returns quickly (it may restart the server shortly after).
    """

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

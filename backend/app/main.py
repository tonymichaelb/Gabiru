from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any

from contextlib import asynccontextmanager

from fastapi import FastAPI, File, HTTPException, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.responses import Response
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from serial.tools import list_ports

from .config_store import ConfigStore
from .gcode_thumbnail import extract_thumbnail
from .job_manager import JobManager
from .models import ConnectRequest, StartJobRequest, StatusResponse, WsClientCommand, PrinterConnectionState, JobState
from .serial_manager import SerialManager
from .settings import get_settings

settings = get_settings()
settings.uploads_dir.mkdir(parents=True, exist_ok=True)

serial_manager = SerialManager()
job_manager = JobManager(serial_manager=serial_manager, uploads_dir=settings.uploads_dir)
config_store = ConfigStore(settings.config_path)


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
    while True:
        try:
            # Poll temps periodically (lightweight; doesn't wait for ok)
            if serial_manager.is_connected and (ticks % 5 == 0):
                try:
                    await serial_manager.send("M105")
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
        status_task.cancel()
        try:
            await status_task
        except asyncio.CancelledError:
            pass
        except Exception:
            pass
        await serial_manager.disconnect()


app = FastAPI(title="Gabiru", version="0.2.0", lifespan=lifespan)


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

from __future__ import annotations

import asyncio
import shutil
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Optional


@dataclass
class TimelapseInfo:
    running: bool = False
    session_dir: Optional[str] = None
    frames: int = 0
    label: Optional[str] = None
    last_video: Optional[str] = None
    mode: str = "interval"  # 'interval' | 'layer'


class TimelapseManager:
    def __init__(
        self,
        timelapse_dir: Path,
        interval_s: float = 10.0,
        fps: int = 30,
        capture_tool: Optional[str] = None,
    ) -> None:
        self._root = timelapse_dir
        self._root.mkdir(parents=True, exist_ok=True)
        self._interval_s = float(interval_s)
        self._fps = int(fps)
        self._capture_tool = capture_tool  # 'libcamera-still' | 'fswebcam' | None (auto)

        self.info = TimelapseInfo()
        self._task: Optional[asyncio.Task[None]] = None
        self._stop = asyncio.Event()
        self._lock = asyncio.Lock()
        self._capture_lock = asyncio.Lock()
        self._session_tool: Optional[str] = None

    def _pick_tool(self) -> Optional[str]:
        if self._capture_tool:
            return self._capture_tool
        # Newer Raspberry Pi OS uses rpicam-* commands.
        if shutil.which("rpicam-still"):
            return "rpicam-still"
        if shutil.which("libcamera-still"):
            return "libcamera-still"
        if shutil.which("fswebcam"):
            return "fswebcam"
        return None

    def _new_session_dir(self, label: Optional[str]) -> Path:
        ts = datetime.now().strftime("%Y%m%d-%H%M%S")
        safe = "timelapse" if not label else "".join(c for c in label if c.isalnum() or c in {"-", "_"})[:40]
        name = f"{ts}-{safe}" if safe else ts
        p = (self._root / name).resolve()
        if self._root.resolve() not in p.parents:
            # Should never happen, but keep it safe.
            raise RuntimeError("Invalid timelapse directory")
        p.mkdir(parents=True, exist_ok=True)
        return p

    async def start(self, label: Optional[str] = None, mode: str = "interval") -> TimelapseInfo:
        async with self._lock:
            if self._task is not None and not self._task.done():
                return self.info

            # If we're already running in layer mode (no background task), keep it.
            if self.info.running and self.info.mode == "layer" and self.info.session_dir:
                return self.info

            mode = (mode or "interval").strip().lower()
            if mode not in {"interval", "layer"}:
                mode = "interval"

            tool = self._pick_tool()
            if tool is None:
                raise RuntimeError("No camera capture tool found (need rpicam-still, libcamera-still, or fswebcam)")

            self._session_tool = tool

            session = self._new_session_dir(label)
            self._stop.clear()
            self.info = TimelapseInfo(
                running=True,
                session_dir=session.name,
                frames=0,
                label=label,
                last_video=self.info.last_video,
                mode=mode,
            )

            if mode == "interval":
                self._task = asyncio.create_task(self._capture_loop(session=session, tool=tool))
            else:
                # 'layer' mode: frames are captured on-demand by trigger.
                self._task = None
            return self.info

    async def stop(self) -> TimelapseInfo:
        async with self._lock:
            if not self.info.session_dir:
                self.info.running = False
                return self.info

            task = self._task
            self._stop.set()

        if task is not None:
            try:
                await task
            except asyncio.CancelledError:
                pass
            except Exception:
                pass

        # Render video (best-effort)
        try:
            session_path = (self._root / (self.info.session_dir or "")).resolve()
            video = await self._render_video(session_path=session_path)
            self.info.last_video = video.name
        except Exception:
            pass

        self.info.running = False
        return self.info

    async def capture_triggered_frame(self) -> Optional[Path]:
        """Capture exactly one frame into the current session (layer-based timelapse).

        Returns the captured frame path, or None if no session is running.
        """

        async with self._lock:
            if not self.info.running or self.info.mode != "layer" or not self.info.session_dir:
                return None
            tool = self._session_tool or self._pick_tool()
            if tool is None:
                raise RuntimeError("No camera capture tool found (need rpicam-still, libcamera-still, or fswebcam)")
            session_dir = self.info.session_dir
            next_idx = int(self.info.frames) + 1

        session = (self._root / session_dir).resolve()
        if self._root.resolve() not in session.parents:
            raise RuntimeError("Invalid timelapse directory")
        session.mkdir(parents=True, exist_ok=True)

        out = (session / f"frame{next_idx:06d}.jpg").resolve()
        async with self._capture_lock:
            await self._capture_frame(tool=tool, out=out)

        async with self._lock:
            # Only bump frames if we're still on the same session.
            if self.info.running and self.info.mode == "layer" and self.info.session_dir == session_dir:
                self.info.frames = next_idx
        return out

    async def _capture_loop(self, session: Path, tool: str) -> None:
        idx = 0
        while not self._stop.is_set():
            idx += 1
            out = session / f"frame{idx:06d}.jpg"
            try:
                async with self._capture_lock:
                    await self._capture_frame(tool=tool, out=out)
                self.info.frames = idx
            except Exception:
                # Ignore capture errors; keep trying.
                pass
            await asyncio.sleep(self._interval_s)

        self.info.running = False

    async def _capture_frame(self, tool: str, out: Path) -> None:
        if tool in ("rpicam-still", "libcamera-still"):
            # -n: no preview, -t: timeout (ms). Too small can cause intermittent failures.
            proc = await asyncio.create_subprocess_exec(
                tool,
                "-n",
                "-t",
                "1000",
                "-o",
                str(out),
                stdout=asyncio.subprocess.DEVNULL,
                stderr=asyncio.subprocess.DEVNULL,
            )
        elif tool == "fswebcam":
            proc = await asyncio.create_subprocess_exec(
                "fswebcam",
                "-q",
                str(out),
                stdout=asyncio.subprocess.DEVNULL,
                stderr=asyncio.subprocess.DEVNULL,
            )
        else:
            raise RuntimeError("Unsupported capture tool")

        rc = await proc.wait()
        if rc != 0:
            raise RuntimeError(f"capture failed ({tool})")

    async def capture_preview_frame(self) -> Path:
        """Capture a single JPEG frame for live preview.

        This does not start/stop a timelapse session. It simply captures a fresh
        frame to a stable file in the timelapse root, so the UI can request it.
        """

        tool = self._pick_tool()
        if tool is None:
            raise RuntimeError("No camera capture tool found (need rpicam-still, libcamera-still, or fswebcam)")

        out = (self._root / "live.jpg").resolve()
        if self._root.resolve() not in out.parents:
            raise RuntimeError("Invalid timelapse directory")

        async with self._capture_lock:
            await self._capture_frame(tool=tool, out=out)
        return out

    async def _render_video(self, session_path: Path) -> Path:
        # Requires ffmpeg. Generates session.mp4 in the session folder.
        if shutil.which("ffmpeg") is None:
            raise RuntimeError("ffmpeg not installed")

        video = session_path / "timelapse.mp4"
        pattern = str(session_path / "frame%06d.jpg")

        proc = await asyncio.create_subprocess_exec(
            "ffmpeg",
            "-y",
            "-framerate",
            str(self._fps),
            "-i",
            pattern,
            "-c:v",
            "libx264",
            "-pix_fmt",
            "yuv420p",
            str(video),
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.DEVNULL,
        )
        rc = await proc.wait()
        if rc != 0:
            raise RuntimeError("ffmpeg failed")

        return video

    def list_videos(self) -> list[dict[str, object]]:
        out: list[dict[str, object]] = []
        for session in sorted(self._root.iterdir()):
            if not session.is_dir():
                continue
            video = session / "timelapse.mp4"
            if not video.exists() or not video.is_file():
                continue
            try:
                st = video.stat()
            except Exception:
                continue
            out.append(
                {
                    "name": f"{session.name}/timelapse.mp4",
                    "size_bytes": int(st.st_size),
                    "mtime": float(st.st_mtime),
                }
            )
        return out

    def resolve_video(self, name: str) -> Path:
        safe = Path((name or "").strip()).as_posix()
        # Only allow <session>/timelapse.mp4
        parts = [p for p in safe.split("/") if p]
        if len(parts) != 2 or parts[1] != "timelapse.mp4":
            raise RuntimeError("Invalid video name")
        path = (self._root / parts[0] / parts[1]).resolve()
        if self._root.resolve() not in path.parents:
            raise RuntimeError("Invalid video path")
        return path

    def latest_frame_path(self) -> Optional[Path]:
        if not self.info.session_dir:
            return None
        session_path = (self._root / self.info.session_dir).resolve()
        if self._root.resolve() not in session_path.parents:
            return None
        if not session_path.exists() or not session_path.is_dir():
            return None
        # Find the newest frame*.jpg file.
        frames = sorted(session_path.glob("frame*.jpg"))
        if not frames:
            return None
        return frames[-1]

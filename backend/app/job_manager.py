from __future__ import annotations

import asyncio
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

from .models import JobState
from .serial_manager import SerialManager
from .timelapse_manager import TimelapseManager


@dataclass
class JobInfo:
    state: JobState = JobState.idle
    filename: Optional[str] = None
    progress: float = 0.0
    line: Optional[int] = None
    total_lines: Optional[int] = None
    error: Optional[str] = None


class JobManager:
    def __init__(
        self,
        serial_manager: SerialManager,
        uploads_dir: Path,
        timelapse_manager: Optional[TimelapseManager] = None,
        timelapse_mode: str = "interval",
    ) -> None:
        self._serial = serial_manager
        self._uploads_dir = uploads_dir
        self._timelapse = timelapse_manager
        self._timelapse_mode = (timelapse_mode or "interval").strip().lower()

        self.info = JobInfo()
        self._task: Optional[asyncio.Task[None]] = None
        self._pause_event = asyncio.Event()
        self._pause_event.set()
        self._cancel = False

    def _should_capture_layer_frame(self, raw_line: str, last_layer_key: Optional[str]) -> tuple[bool, Optional[str]]:
        """Detect layer change markers commonly emitted by slicers.

        Returns (should_capture, new_layer_key).
        """

        s = (raw_line or "").strip()
        if not s.startswith(";"):
            return (False, last_layer_key)

        up = s.upper()

        # PrusaSlicer/SuperSlicer/Cura variants
        if "LAYER_CHANGE" in up:
            key = f"layer_change:{hash(s)}"
            return (key != last_layer_key, key)

        if ";LAYER:" in up:
            # e.g. ;LAYER:12
            try:
                part = up.split(";LAYER:", 1)[1].strip()
                num = "".join(ch for ch in part if ch.isdigit())
                key = f"layer:{int(num)}" if num else f"layer_raw:{hash(s)}"
            except Exception:
                key = f"layer_raw:{hash(s)}"
            return (key != last_layer_key, key)

        return (False, last_layer_key)

    async def _set_led_rgb_best_effort(self, r: int, g: int, b: int) -> None:
        """Best-effort RGB status LED.

        Uses M150 (Marlin-style). If the printer doesn't support it, ignore errors.
        """

        if not self._serial.is_connected:
            return
        r = max(0, min(255, int(r)))
        g = max(0, min(255, int(g)))
        b = max(0, min(255, int(b)))
        try:
            # Marlin commonly uses U for green.
            await self._serial.send(f"M150 R{r} U{g} B{b}")
        except Exception:
            pass

    def is_running(self) -> bool:
        return self._task is not None and not self._task.done()

    async def start(self, filename: str) -> None:
        if self.is_running():
            raise RuntimeError("A job is already running")
        if not self._serial.is_connected:
            raise RuntimeError("Printer not connected")

        path = (self._uploads_dir / filename).resolve()
        if not path.exists() or not path.is_file():
            raise FileNotFoundError(filename)
        if self._uploads_dir.resolve() not in path.parents:
            raise RuntimeError("Invalid filename")

        self._cancel = False
        self._pause_event.set()
        self.info = JobInfo(state=JobState.printing, filename=filename, progress=0.0)

        # Printing state LED: white
        await self._set_led_rgb_best_effort(255, 255, 255)
        self._task = asyncio.create_task(self._run_file(path))

    async def pause(self) -> None:
        if self.info.state != JobState.printing:
            return
        self.info.state = JobState.paused
        self._pause_event.clear()

        # Paused state LED: blue
        await self._set_led_rgb_best_effort(0, 0, 255)

    async def resume(self) -> None:
        if self.info.state != JobState.paused:
            return
        self.info.state = JobState.printing
        self._pause_event.set()

        # Printing state LED: white
        await self._set_led_rgb_best_effort(255, 255, 255)

    async def cancel(self) -> None:
        if self.info.state not in (JobState.printing, JobState.paused):
            return
        self.info.state = JobState.cancelling
        self._cancel = True
        self._pause_event.set()
        if self._task is not None:
            try:
                await asyncio.wait_for(self._task, timeout=2.0)
            except Exception:
                pass
        self.info = JobInfo()

    async def _run_file(self, path: Path) -> None:
        # Do NOT run G28/G29 automatically.
        # Let the slicer's start G-code handle homing/leveling, or user can do it manually via UI buttons.
        # This avoids timeouts that abort the print immediately.

        lines = path.read_text(errors="ignore").splitlines()
        total = max(len(lines), 1)
        self.info.total_lines = total

        last_layer_key: Optional[str] = None

        for idx, raw in enumerate(lines):
            self.info.line = idx
            await self._pause_event.wait()
            if self._cancel:
                break

            # OctoPrint-like: capture a frame on layer change (best-effort).
            if self._timelapse is not None and self._timelapse_mode == "layer":
                try:
                    should_cap, last_layer_key = self._should_capture_layer_frame(raw, last_layer_key)
                    if should_cap:
                        await self._timelapse.capture_triggered_frame()
                except Exception:
                    pass

            line = raw.strip()
            if not line or line.startswith(";"):
                self.info.progress = (idx + 1) / total
                continue

            # Strip inline comments
            if ";" in line:
                line = line.split(";", 1)[0].strip()
                if not line:
                    self.info.progress = (idx + 1) / total
                    continue

            # Skip commands that many printers don't support (e.g., M73 from PrusaSlicer/Cura for progress display).
            # These would cause "Unknown command" but are non-critical.
            upper = line.upper()
            if upper in {"M73", "M117"}:
                self.info.progress = (idx + 1) / total
                continue

            # Temperature commands (M104, M109, M140, M190) need longer timeout (bed/nozzle heating).
            # Use 60s timeout for these, 30s for others.
            is_temp_cmd = any(upper.startswith(prefix) for prefix in ("M104", "M109", "M140", "M190", "M109", "M106"))
            timeout_s = 60.0 if is_temp_cmd else 30.0

            try:
                await self._serial.send_and_wait_ok(line, timeout_s=timeout_s)
            except Exception as e:
                # Error state LED: red
                await self._set_led_rgb_best_effort(255, 0, 0)
                error_msg = str(e).strip() or "Erro desconhecido ao enviar comando"
                self.info = JobInfo(state=JobState.idle, filename=self.info.filename, error=f"Falha na impressão: {error_msg}")
                return
            self.info.progress = (idx + 1) / total

        # Job finished: green; cancelled: off
        if self._cancel:
            await self._set_led_rgb_best_effort(0, 0, 0)
        else:
            await self._set_led_rgb_best_effort(0, 255, 0)
        self.info = JobInfo()

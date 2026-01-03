from __future__ import annotations

import asyncio
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

from .models import JobState
from .serial_manager import SerialManager


@dataclass
class JobInfo:
    state: JobState = JobState.idle
    filename: Optional[str] = None
    progress: float = 0.0


class JobManager:
    def __init__(self, serial_manager: SerialManager, uploads_dir: Path) -> None:
        self._serial = serial_manager
        self._uploads_dir = uploads_dir

        self.info = JobInfo()
        self._task: Optional[asyncio.Task[None]] = None
        self._pause_event = asyncio.Event()
        self._pause_event.set()
        self._cancel = False

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
        self._task = asyncio.create_task(self._run_file(path))

    async def pause(self) -> None:
        if self.info.state != JobState.printing:
            return
        self.info.state = JobState.paused
        self._pause_event.clear()

    async def resume(self) -> None:
        if self.info.state != JobState.paused:
            return
        self.info.state = JobState.printing
        self._pause_event.set()

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
        lines = path.read_text(errors="ignore").splitlines()
        total = max(len(lines), 1)

        for idx, raw in enumerate(lines):
            await self._pause_event.wait()
            if self._cancel:
                break

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

            await self._serial.send_and_wait_ok(line)
            self.info.progress = (idx + 1) / total

        self.info = JobInfo()

from __future__ import annotations

import asyncio
import re
from dataclasses import dataclass
from typing import Optional

import serial


_TEMP_RE = re.compile(
    r"T:(?P<t>[-+]?\d+(?:\.\d+)?)\s*/\s*(?P<tt>[-+]?\d+(?:\.\d+)?)?\s*"
    r"(?:B:(?P<b>[-+]?\d+(?:\.\d+)?)\s*/\s*(?P<bt>[-+]?\d+(?:\.\d+)?)?)?"
)


@dataclass
class SerialState:
    port: Optional[str] = None
    baudrate: Optional[int] = None
    hotend_c: Optional[float] = None
    bed_c: Optional[float] = None


class SerialManager:
    def __init__(self) -> None:
        self._ser: Optional[serial.Serial] = None
        self._reader_task: Optional[asyncio.Task[None]] = None
        self._lock = asyncio.Lock()
        self._cmd_lock = asyncio.Lock()

        self.state = SerialState()

        self._line_queue: asyncio.Queue[str] = asyncio.Queue()
        self._ok_event = asyncio.Event()

        self._on_line: Optional[callable] = None

    def set_on_line_callback(self, cb: Optional[callable]) -> None:
        self._on_line = cb

    @property
    def is_connected(self) -> bool:
        return self._ser is not None and self._ser.is_open

    async def connect(self, port: str, baudrate: int) -> None:
        async with self._lock:
            if self.is_connected:
                return

            loop = asyncio.get_running_loop()

            def _open() -> serial.Serial:
                return serial.Serial(port=port, baudrate=baudrate, timeout=0.1)

            self._ser = await loop.run_in_executor(None, _open)
            self.state.port = port
            self.state.baudrate = baudrate

            self._ok_event.clear()
            self._reader_task = asyncio.create_task(self._reader_loop())

    async def disconnect(self) -> None:
        async with self._lock:
            if self._reader_task is not None:
                self._reader_task.cancel()
                self._reader_task = None

            if self._ser is not None:
                ser = self._ser
                self._ser = None

                loop = asyncio.get_running_loop()

                def _close() -> None:
                    try:
                        ser.close()
                    except Exception:
                        pass

                await loop.run_in_executor(None, _close)

            self.state = SerialState()

    async def send(self, line: str) -> None:
        async with self._cmd_lock:
            await self._send_raw(line)

    async def _send_raw(self, line: str) -> None:
        if not self.is_connected or self._ser is None:
            raise RuntimeError("Serial not connected")

        data = (line.strip() + "\n").encode("utf-8", errors="ignore")
        loop = asyncio.get_running_loop()

        def _write() -> None:
            assert self._ser is not None
            self._ser.write(data)
            self._ser.flush()

        await loop.run_in_executor(None, _write)

    async def send_and_wait_ok(self, line: str, timeout_s: float = 10.0) -> None:
        async with self._cmd_lock:
            self._ok_event.clear()
            await self._send_raw(line)
            await asyncio.wait_for(self._ok_event.wait(), timeout=timeout_s)

    async def read_line(self) -> str:
        return await self._line_queue.get()

    async def _reader_loop(self) -> None:
        assert self._ser is not None
        loop = asyncio.get_running_loop()

        def _readline() -> bytes:
            assert self._ser is not None
            try:
                return self._ser.readline()
            except Exception:
                return b""

        while True:
            raw = await loop.run_in_executor(None, _readline)
            if not raw:
                await asyncio.sleep(0.01)
                continue

            try:
                line = raw.decode("utf-8", errors="ignore").strip()
            except Exception:
                continue

            if not line:
                continue

            await self._line_queue.put(line)
            if self._on_line is not None:
                try:
                    self._on_line(line)
                except Exception:
                    pass

            # Basic protocol handling
            lower = line.lower()
            if lower == "ok" or lower.startswith("ok "):
                self._ok_event.set()
                continue

            m = _TEMP_RE.search(line)
            if m:
                try:
                    self.state.hotend_c = float(m.group("t"))
                except Exception:
                    pass
                bed = m.group("b")
                if bed is not None:
                    try:
                        self.state.bed_c = float(bed)
                    except Exception:
                        pass

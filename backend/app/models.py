from __future__ import annotations

from enum import Enum
from typing import Optional

from pydantic import BaseModel, Field


class PrinterConnectionState(str, Enum):
    disconnected = "disconnected"
    connecting = "connecting"
    connected = "connected"


class JobState(str, Enum):
    idle = "idle"
    printing = "printing"
    paused = "paused"
    cancelling = "cancelling"


class ConnectRequest(BaseModel):
    port: str
    baudrate: int = Field(default=115200, ge=1200)


class StatusResponse(BaseModel):
    connection: PrinterConnectionState
    port: Optional[str] = None
    baudrate: Optional[int] = None
    job_state: JobState
    job_file: Optional[str] = None
    progress: float = Field(default=0.0, ge=0.0, le=1.0)
    hotend_c: Optional[float] = None
    bed_c: Optional[float] = None


class StartJobRequest(BaseModel):
    filename: str


class WsClientCommand(BaseModel):
    type: str
    command: Optional[str] = None

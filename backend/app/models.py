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
    job_line: Optional[int] = Field(default=None, ge=0)
    job_total_lines: Optional[int] = Field(default=None, ge=1)
    job_error: Optional[str] = None
    hotend_c: Optional[float] = None
    bed_c: Optional[float] = None


class StartJobRequest(BaseModel):
    filename: str


class SetTemperatureRequest(BaseModel):
    hotend_c: Optional[float] = Field(default=None, ge=0.0, le=320.0)
    bed_c: Optional[float] = Field(default=None, ge=0.0, le=150.0)


class WsClientCommand(BaseModel):
    type: str
    command: Optional[str] = None


class WifiConnectRequest(BaseModel):
    ssid: str
    password: Optional[str] = None

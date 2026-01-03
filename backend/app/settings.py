from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path
from typing import Optional


@dataclass(frozen=True)
class Settings:
    root_dir: Path
    autoconnect: bool
    port: Optional[str]
    baudrate: int

    @property
    def data_dir(self) -> Path:
        return self.root_dir / "data"

    @property
    def uploads_dir(self) -> Path:
        return self.data_dir / "uploads"

    @property
    def config_path(self) -> Path:
        return self.data_dir / "config.json"


def _env_bool(name: str, default: bool = False) -> bool:
    raw = os.environ.get(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "y", "on"}


def get_settings() -> Settings:
    # backend/app/settings.py -> backend/ is parent of app/
    root = Path(__file__).resolve().parents[1]
    port = os.environ.get("GABIRU_PORT")
    baudrate = int(os.environ.get("GABIRU_BAUDRATE") or 115200)
    return Settings(
        root_dir=root,
        autoconnect=_env_bool("GABIRU_AUTOCONNECT", default=False),
        port=port,
        baudrate=baudrate,
    )

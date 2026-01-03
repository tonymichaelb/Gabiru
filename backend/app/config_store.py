from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Optional


@dataclass
class AppConfig:
    port: Optional[str] = None
    baudrate: int = 115200


class ConfigStore:
    def __init__(self, path: Path) -> None:
        self._path = path

    def load(self) -> AppConfig:
        try:
            raw = self._path.read_text(encoding="utf-8")
            data = json.loads(raw)
            port = data.get("port")
            baudrate = int(data.get("baudrate") or 115200)
            return AppConfig(port=port, baudrate=baudrate)
        except FileNotFoundError:
            return AppConfig()
        except Exception:
            return AppConfig()

    def save(self, *, port: str, baudrate: int) -> None:
        self._path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self._path.with_suffix(self._path.suffix + ".tmp")
        payload = {"port": port, "baudrate": int(baudrate)}
        tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        tmp.replace(self._path)

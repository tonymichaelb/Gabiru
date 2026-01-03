from __future__ import annotations

import base64
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Optional


_THUMB_BEGIN_RE = re.compile(
    r"^;\s*thumbnail(?:_(?P<kind>[a-zA-Z0-9]+))?\s+begin\s+(?P<w>\d+)x(?P<h>\d+)\s+(?P<bytes>\d+)\s*$",
    re.IGNORECASE,
)
_THUMB_END_RE = re.compile(r"^;\s*thumbnail\s+end\s*$", re.IGNORECASE)


@dataclass
class Thumbnail:
    width: int
    height: int
    data: bytes
    media_type: str


def _sniff_media_type(data: bytes) -> str:
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if data.startswith(b"\xff\xd8"):
        return "image/jpeg"
    return "application/octet-stream"


def extract_thumbnail(path: Path, *, max_lines: int = 4000) -> Optional[Thumbnail]:
    """Extracts an embedded thumbnail from common slicers (PrusaSlicer/Cura).

    Supports blocks like:
      ; thumbnail begin 200x200 12345
      ; iVBORw0KGgo...
      ; ...
      ; thumbnail end

    Returns the *largest* thumbnail found in the scanned region.
    """

    best: Optional[Thumbnail] = None

    def consider(width: int, height: int, b64_lines: list[str]) -> None:
        nonlocal best
        if not b64_lines:
            return
        payload = "".join(b64_lines)
        try:
            raw = base64.b64decode(payload, validate=False)
        except Exception:
            return
        media = _sniff_media_type(raw)
        cand = Thumbnail(width=width, height=height, data=raw, media_type=media)
        if best is None or (cand.width * cand.height) > (best.width * best.height):
            best = cand

    in_block = False
    width = 0
    height = 0
    b64_lines: list[str] = []

    try:
        with path.open("r", encoding="utf-8", errors="ignore") as f:
            for idx, raw in enumerate(f):
                if idx >= max_lines:
                    break
                line = raw.strip("\r\n")

                if not in_block:
                    m = _THUMB_BEGIN_RE.match(line.strip())
                    if m:
                        in_block = True
                        width = int(m.group("w"))
                        height = int(m.group("h"))
                        b64_lines = []
                    continue

                if _THUMB_END_RE.match(line.strip()):
                    consider(width, height, b64_lines)
                    in_block = False
                    b64_lines = []
                    continue

                # Typical lines look like "; iVBOR..." (sometimes without space)
                s = line.strip()
                if s.startswith(";"):
                    s = s[1:].lstrip()
                if s:
                    b64_lines.append(s)
    except FileNotFoundError:
        return None

    return best

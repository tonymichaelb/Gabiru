from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Optional


_FLOAT = r"[-+]?\d+(?:\.\d+)?"
_TOKEN_RE = re.compile(rf"\b(?P<k>[XYZE])(?P<v>{_FLOAT})\b", re.IGNORECASE)


@dataclass
class ToolpathSegment:
    x1: float
    y1: float
    x2: float
    y2: float
    extrude: bool
    line: int
    layer: int


@dataclass
class LayerInfo:
    idx: int
    z: float
    start_line: int
    end_line: int


def _strip_comments(line: str) -> str:
    # Remove ';' comments
    if ";" in line:
        line = line.split(";", 1)[0]
    # Remove '( ... )' style comments (best-effort)
    while True:
        a = line.find("(")
        if a == -1:
            break
        b = line.find(")", a + 1)
        if b == -1:
            line = line[:a]
            break
        line = line[:a] + line[b + 1 :]
    return line.strip()


def extract_toolpath(
    path: Path,
    *,
    max_segments: int = 50_000,
    max_lines: int = 2_000_000,
) -> dict[str, Any]:
    """Parse a G-code file and return a simplified XY toolpath.

    Supports G0/G1 with X/Y/E. Ignores arcs (G2/G3) and Z.
    Returns:
      { bounds: {min_x, max_x, min_y, max_y}, segments: [{x1,y1,x2,y2,extrude}] }
    """

    abs_xyz = True  # G90 default
    abs_e = True  # M82 default

    x = 0.0
    y = 0.0
    z = 0.0
    e = 0.0

    layer_idx = 0
    layers: list[LayerInfo] = [LayerInfo(idx=0, z=0.0, start_line=0, end_line=0)]

    min_x: Optional[float] = None
    max_x: Optional[float] = None
    min_y: Optional[float] = None
    max_y: Optional[float] = None

    segments: list[ToolpathSegment] = []

    def upd_bounds(px: float, py: float) -> None:
        nonlocal min_x, max_x, min_y, max_y
        if min_x is None or px < min_x:
            min_x = px
        if max_x is None or px > max_x:
            max_x = px
        if min_y is None or py < min_y:
            min_y = py
        if max_y is None or py > max_y:
            max_y = py

    with path.open("r", encoding="utf-8", errors="ignore") as f:
        for line_no, raw in enumerate(f):
            if line_no >= max_lines:
                break

            line = _strip_comments(raw)
            if not line:
                continue

            upper = line.upper().strip()
            # Modes
            if upper.startswith("G90"):
                abs_xyz = True
                continue
            if upper.startswith("G91"):
                abs_xyz = False
                continue
            if upper.startswith("M82"):
                abs_e = True
                continue
            if upper.startswith("M83"):
                abs_e = False
                continue

            # Only parse linear moves
            if not (upper.startswith("G0") or upper.startswith("G1")):
                continue

            dx = dy = dz = de = None
            for m in _TOKEN_RE.finditer(line):
                k = m.group("k").upper()
                try:
                    v = float(m.group("v"))
                except Exception:
                    continue
                if k == "X":
                    dx = v
                elif k == "Y":
                    dy = v
                elif k == "Z":
                    dz = v
                elif k == "E":
                    de = v

            new_x = x
            new_y = y
            new_z = z

            if dx is not None:
                new_x = dx if abs_xyz else x + dx
            if dy is not None:
                new_y = dy if abs_xyz else y + dy
            if dz is not None:
                new_z = dz if abs_xyz else z + dz

            # Layer tracking: create a new layer when Z changes meaningfully.
            if new_z != z and abs(new_z - z) > 1e-6:
                z = new_z
                layer_idx += 1
                layers.append(LayerInfo(idx=layer_idx, z=round(z, 4), start_line=line_no, end_line=line_no))
            else:
                layers[-1].end_line = line_no

            extrude = False
            if de is not None:
                if abs_e:
                    extrude = de > e + 1e-6
                    e = de
                else:
                    extrude = de > 1e-6
                    e = e + de

            if (new_x != x) or (new_y != y):
                segments.append(
                    ToolpathSegment(
                        x1=round(x, 4),
                        y1=round(y, 4),
                        x2=round(new_x, 4),
                        y2=round(new_y, 4),
                        extrude=bool(extrude),
                        line=int(line_no),
                        layer=int(layer_idx),
                    )
                )
                upd_bounds(x, y)
                upd_bounds(new_x, new_y)

                x, y = new_x, new_y

                if len(segments) >= max_segments:
                    break
            else:
                # Even if no XY movement, update E state already handled.
                continue

    if not segments or min_x is None or min_y is None or max_x is None or max_y is None:
        return {
            "bounds": {"min_x": 0.0, "max_x": 0.0, "min_y": 0.0, "max_y": 0.0},
            "segments": [],
            "layers": [],
        }

    return {
        "bounds": {"min_x": min_x, "max_x": max_x, "min_y": min_y, "max_y": max_y},
        "segments": [s.__dict__ for s in segments],
        "layers": [li.__dict__ for li in layers],
    }

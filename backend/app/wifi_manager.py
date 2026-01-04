from __future__ import annotations

import asyncio
import re
import shutil
from dataclasses import dataclass
from typing import Optional


@dataclass(frozen=True)
class WifiNetwork:
    ssid: str
    signal: int
    security: str


@dataclass(frozen=True)
class WifiStatus:
    available: bool
    iface: str
    connected: bool
    ssid: Optional[str]
    hotspot_active: bool
    ip4: Optional[str]
    hotspot_ssid: str


class WifiManager:
    """Best-effort Wi-Fi management for Raspberry Pi via NetworkManager (nmcli).

    This is intentionally conservative: if nmcli isn't present, it reports unavailable.
    """

    def __init__(
        self,
        *,
        iface: str = "wlan0",
        hotspot_conn_name: str = "chroma-hotspot",
        hotspot_ssid: str = "Chroma-Setup",
    ) -> None:
        self.iface = iface
        self.hotspot_conn_name = hotspot_conn_name
        self.hotspot_ssid = hotspot_ssid

    def is_available(self) -> bool:
        return bool(shutil.which("nmcli"))

    async def _run_nmcli(self, *args: str, timeout_s: float = 20.0) -> tuple[int, str, str]:
        proc = await asyncio.create_subprocess_exec(
            "nmcli",
            *args,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        try:
            out_b, err_b = await asyncio.wait_for(proc.communicate(), timeout=timeout_s)
        except asyncio.TimeoutError:
            proc.kill()
            raise
        out = out_b.decode(errors="replace") if out_b else ""
        err = err_b.decode(errors="replace") if err_b else ""
        return proc.returncode or 0, out, err

    async def _run_ip(self, *args: str, timeout_s: float = 5.0) -> tuple[int, str, str]:
        proc = await asyncio.create_subprocess_exec(
            "ip",
            *args,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        try:
            out_b, err_b = await asyncio.wait_for(proc.communicate(), timeout=timeout_s)
        except asyncio.TimeoutError:
            proc.kill()
            raise
        out = out_b.decode(errors="replace") if out_b else ""
        err = err_b.decode(errors="replace") if err_b else ""
        return proc.returncode or 0, out, err

    async def get_status(self) -> WifiStatus:
        if not self.is_available():
            return WifiStatus(
                available=False,
                iface=self.iface,
                connected=False,
                ssid=None,
                hotspot_active=False,
                ip4=None,
                hotspot_ssid=self.hotspot_ssid,
            )

        connected = False
        ssid: Optional[str] = None
        hotspot_active = False

        # nmcli -t keeps output easy to parse.
        # Example: wlan0:wifi:connected:MySSID
        rc, out, _ = await self._run_nmcli("-t", "-f", "DEVICE,TYPE,STATE,CONNECTION", "dev", "status")
        if rc == 0:
            for line in out.splitlines():
                parts = line.split(":")
                if len(parts) < 4:
                    continue
                dev, typ, state, conn = parts[0], parts[1], parts[2], parts[3]
                if dev != self.iface or typ != "wifi":
                    continue
                if state == "connected":
                    connected = True
                    # For Wi-Fi, NetworkManager typically names the connection as the SSID.
                    ssid = conn if conn and conn != "--" else None
                if conn == self.hotspot_conn_name and state == "connected":
                    hotspot_active = True

        ip4: Optional[str] = None
        if shutil.which("ip"):
            rc, out, _ = await self._run_ip("-4", "addr", "show", "dev", self.iface)
            if rc == 0:
                m = re.search(r"\binet\s+(\d+\.\d+\.\d+\.\d+)/(\d+)", out)
                if m:
                    ip4 = m.group(1)

        return WifiStatus(
            available=True,
            iface=self.iface,
            connected=connected and not hotspot_active,
            ssid=ssid if (connected and not hotspot_active) else None,
            hotspot_active=hotspot_active,
            ip4=ip4,
            hotspot_ssid=self.hotspot_ssid,
        )

    async def scan(self) -> list[WifiNetwork]:
        if not self.is_available():
            return []

        # Use --rescan yes to refresh results when possible.
        rc, out, err = await self._run_nmcli(
            "-t",
            "-f",
            "SSID,SIGNAL,SECURITY",
            "dev",
            "wifi",
            "list",
            "ifname",
            self.iface,
            "--rescan",
            "yes",
            timeout_s=30.0,
        )
        if rc != 0:
            # Some NetworkManager versions reject --rescan; retry without it.
            rc, out, err = await self._run_nmcli(
                "-t",
                "-f",
                "SSID,SIGNAL,SECURITY",
                "dev",
                "wifi",
                "list",
                "ifname",
                self.iface,
                timeout_s=30.0,
            )
        if rc != 0:
            raise RuntimeError(err.strip() or "wifi scan failed")

        seen: set[str] = set()
        nets: list[WifiNetwork] = []
        for line in out.splitlines():
            # Format: SSID:SIGNAL:SECURITY (SSID may be empty)
            parts = line.split(":")
            if len(parts) < 3:
                continue
            ssid = parts[0].strip()
            if not ssid or ssid in seen:
                continue
            seen.add(ssid)
            try:
                signal = int(parts[1])
            except Exception:
                signal = 0
            security = parts[2].strip() or "open"
            nets.append(WifiNetwork(ssid=ssid, signal=signal, security=security))

        nets.sort(key=lambda n: n.signal, reverse=True)
        return nets

    async def connect(self, *, ssid: str, password: Optional[str]) -> None:
        if not self.is_available():
            raise RuntimeError("nmcli not available")

        target = (ssid or "").strip()
        if not target:
            raise ValueError("ssid is required")

        # Best-effort: bring down hotspot if it exists.
        await self._run_nmcli("con", "down", self.hotspot_conn_name, timeout_s=10.0)

        args = ["dev", "wifi", "connect", target, "ifname", self.iface]
        pw = (password or "").strip()
        if pw:
            args.extend(["password", pw])

        rc, _, err = await self._run_nmcli(*args, timeout_s=40.0)
        if rc != 0:
            raise RuntimeError(err.strip() or "wifi connect failed")

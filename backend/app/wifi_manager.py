from __future__ import annotations

import asyncio
import os
import re
import shutil
import time
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
        connect_lock_path: str = "/run/gabiru-wifi-connect.lock",
    ) -> None:
        self.iface = iface
        self.hotspot_conn_name = hotspot_conn_name
        self.hotspot_ssid = hotspot_ssid
        self.connect_lock_path = connect_lock_path

        # Use a separator that is extremely unlikely to appear in SSIDs/connection names.
        # nmcli escapes ':' in terse mode, but parsing escapes correctly is fiddly; a tab
        # separator keeps parsing straightforward and robust.
        self._nmcli_sep = "\t"
        self._nmcli_separator_supported = True
        # When --separator isn't supported, nmcli defaults to ':' and escapes it as '\:'.
        self._nmcli_sep_mode: str = "tab"

    def _split_nmcli_terse(self, line: str, *, max_fields: int | None = None) -> list[str]:
        if self._nmcli_sep_mode == "tab":
            if max_fields is None:
                return line.split(self._nmcli_sep)
            return line.split(self._nmcli_sep, max_fields - 1)

        # Default nmcli -t delimiter ':' with backslash-escaping.
        # Example: My\:SSID:70:WPA2
        fields: list[str] = []
        cur: list[str] = []
        i = 0
        while i < len(line):
            ch = line[i]
            if ch == "\\" and i + 1 < len(line):
                cur.append(line[i + 1])
                i += 2
                continue
            if ch == ":" and (max_fields is None or len(fields) < max_fields - 1):
                fields.append("".join(cur))
                cur = []
                i += 1
                continue
            cur.append(ch)
            i += 1
        fields.append("".join(cur))
        return fields

    async def _run_nmcli_terse(self, *args: str, timeout_s: float = 20.0) -> tuple[int, str, str]:
        if self._nmcli_separator_supported:
            rc, out, err = await self._run_nmcli(
                "-t",
                "--separator",
                self._nmcli_sep,
                *args,
                timeout_s=timeout_s,
            )
            if rc == 0:
                self._nmcli_sep_mode = "tab"
                return rc, out, err

            # Some older nmcli builds don't support --separator.
            err_l = (err or "").lower()
            if "separator" in err_l and ("unknown" in err_l or "invalid" in err_l or "unrecognized" in err_l):
                self._nmcli_separator_supported = False
                self._nmcli_sep_mode = "colon"
            else:
                # Fail fast for non-separator-related errors.
                return rc, out, err

        self._nmcli_sep_mode = "colon"
        return await self._run_nmcli("-t", *args, timeout_s=timeout_s)

    def is_available(self) -> bool:
        return bool(shutil.which("nmcli"))

    def _make_client_conn_name(self, ssid: str) -> str:
        base = (ssid or "").strip() or "wifi"
        # Keep it conservative: ASCII-ish, avoid characters that nmcli may treat oddly.
        base = re.sub(r"[^A-Za-z0-9._-]+", "_", base).strip("_")
        if not base:
            base = "wifi"
        name = f"gabiru-wifi-{base}"
        return name[:64]

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
        rc, out, _ = await self._run_nmcli_terse(
            "-f",
            "DEVICE,TYPE,STATE,CONNECTION",
            "dev",
            "status",
        )
        if rc == 0:
            for line in out.splitlines():
                parts = self._split_nmcli_terse(line, max_fields=4)
                if len(parts) < 4:
                    continue
                dev, typ, state, conn = parts[0], parts[1], parts[2], parts[3]
                if dev != self.iface or typ != "wifi":
                    continue
                if state.startswith("connected"):
                    connected = True
                    # For Wi-Fi, NetworkManager typically names the connection as the SSID.
                    ssid = conn if conn and conn != "--" else None
                if conn == self.hotspot_conn_name and state.startswith("connected"):
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
        rc, out, err = await self._run_nmcli_terse(
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
            rc, out, err = await self._run_nmcli_terse(
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
            parts = self._split_nmcli_terse(line, max_fields=3)
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

    async def list_saved_networks(self) -> list[str]:
        """List SSID names of saved Wi-Fi connections (excluding hotspot)."""
        if not self.is_available():
            return []

        rc, out, err = await self._run_nmcli_terse(
            "-f",
            "NAME,TYPE,AUTOCONNECT",
            "con",
            "show",
        )
        if rc != 0:
            return []

        saved: list[str] = []
        for line in out.splitlines():
            parts = self._split_nmcli_terse(line, max_fields=3)
            if len(parts) < 2:
                continue
            name = parts[0].strip()
            conn_type = parts[1].strip()

            # Skip non-wifi and hotspot connections
            if conn_type != "802-11-wireless" and conn_type != "wifi":
                continue
            if name == self.hotspot_conn_name:
                continue
            if name.startswith("gabiru-wifi-"):
                # Extract SSID from connection name
                ssid = name.replace("gabiru-wifi-", "", 1)
                if ssid and ssid not in saved:
                    saved.append(ssid)
            elif name not in saved:
                # Connection name may be the SSID itself
                saved.append(name)

        return saved

    async def _get_security_for_ssid(self, ssid: str) -> Optional[str]:
        target = (ssid or "").strip()
        if not target:
            return None

        # Prefer a fresh scan when possible.
        rc, out, err = await self._run_nmcli_terse(
            "-f",
            "SSID,SECURITY",
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
            rc, out, err = await self._run_nmcli_terse(
                "-f",
                "SSID,SECURITY",
                "dev",
                "wifi",
                "list",
                "ifname",
                self.iface,
                timeout_s=30.0,
            )
        if rc != 0:
            return None

        for line in out.splitlines():
            parts = self._split_nmcli_terse(line, max_fields=2)
            if len(parts) < 2:
                continue
            line_ssid = parts[0].strip()
            if line_ssid != target:
                continue
            sec = parts[1].strip()
            return sec or "open"

        return None

    async def connect(self, *, ssid: str, password: Optional[str]) -> None:
        if not self.is_available():
            raise RuntimeError("nmcli not available")

        target = (ssid or "").strip()
        if not target:
            raise ValueError("ssid is required")

        pw = (password or "").strip()
        sec = await self._get_security_for_ssid(target)
        if sec and sec.lower() not in {"open", "--"} and not pw:
            raise ValueError("password is required for this Wi‑Fi network")

        def _key_mgmt_for_security(security: Optional[str]) -> str:
            sec_l = (security or "").strip().lower()
            # WPA3-Personal often shows as "WPA3" or includes "SAE".
            if "wpa3" in sec_l or "sae" in sec_l:
                return "sae"
            return "wpa-psk"

        async def connect_via_profile(
            *,
            conn_ssid: str,
            conn_password: str,
            conn_security: Optional[str],
        ) -> None:
            """Create/update a per-SSID connection profile and bring it up.

            This avoids nmcli prompting for secrets (which it cannot do non-interactively)
            and works around some NM variants that don't infer key-mgmt reliably.
            """

            conn_name = self._make_client_conn_name(conn_ssid)

            # Best-effort cleanup if it already exists.
            await self._run_nmcli("con", "delete", conn_name, timeout_s=10.0)

            rc2, _, err2 = await self._run_nmcli(
                "con",
                "add",
                "type",
                "wifi",
                "ifname",
                self.iface,
                "con-name",
                conn_name,
                "ssid",
                conn_ssid,
                timeout_s=20.0,
            )
            if rc2 != 0:
                raise RuntimeError((err2 or "failed to create wifi connection").strip())

            # Store WPA2 PSK to avoid interactive prompts.
            if conn_password:
                key_mgmt = _key_mgmt_for_security(conn_security)
                await self._run_nmcli(
                    "con",
                    "modify",
                    conn_name,
                    "wifi-sec.key-mgmt",
                    key_mgmt,
                    timeout_s=10.0,
                )
                await self._run_nmcli(
                    "con",
                    "modify",
                    conn_name,
                    "wifi-sec.psk",
                    conn_password,
                    timeout_s=10.0,
                )

            # Ensure DHCP.
            await self._run_nmcli("con", "modify", conn_name, "ipv4.method", "auto", timeout_s=10.0)
            await self._run_nmcli("con", "modify", conn_name, "ipv6.method", "auto", timeout_s=10.0)

            rc3, _, err3 = await self._run_nmcli("con", "up", conn_name, timeout_s=75.0)
            if rc3 != 0:
                raise RuntimeError((err3 or "wifi connect failed").strip())

        # Prevent the hotspot watchdog from restarting the AP while we attempt to connect.
        # This is important because bringing up a client connection temporarily drops AP mode.
        try:
            os.makedirs(os.path.dirname(self.connect_lock_path), exist_ok=True)
            with open(self.connect_lock_path, "w", encoding="utf-8") as f:
                f.write(str(int(time.time())))
        except Exception:
            # Best-effort; proceed even if we can't create the lock.
            pass

        try:
            # Ensure Wi-Fi radio is enabled.
            await self._run_nmcli("radio", "wifi", "on", timeout_s=10.0)

            # Best-effort: bring down hotspot if it exists.
            await self._run_nmcli("con", "down", self.hotspot_conn_name, timeout_s=15.0)

            args = ["dev", "wifi", "connect", target, "ifname", self.iface]
            if pw:
                args.extend(["password", pw])

            rc, out, err = await self._run_nmcli(*args, timeout_s=75.0)
            if rc == 0:
                return

            msg = (err or out or "").strip()
            msg_l = msg.lower()

            # If NM decided the network is secured but we didn't provide secrets, fail clearly.
            if (
                "secrets were required" in msg_l
                or "nmcli cannot ask" in msg_l
                or "802-11-wireless-security.psk" in msg_l
            ) and not pw:
                raise ValueError("password is required for this WiFi network")

            # Some NetworkManager builds (notably on certain Debian/RPi images) fail to
            # infer key-mgmt for WPA2 networks when using `dev wifi connect`.
            # Fallback: create a persistent connection profile and bring it up.
            if "802-11-wireless-security.key-mgmt" in msg and "property is missing" in msg:
                if not pw:
                    raise ValueError("password is required for this WiFi network")
                await connect_via_profile(conn_ssid=target, conn_password=pw, conn_security=sec)
                return

            # Another common failure mode: NM creates/activates a connection but can't prompt
            # for secrets in non-interactive mode. If we have a password, switch to the
            # profile-based approach so the PSK is present.
            if (
                "secrets were required" in msg_l
                or "nmcli cannot ask" in msg_l
                or "802-11-wireless-security.psk" in msg_l
            ) and pw:
                await connect_via_profile(conn_ssid=target, conn_password=pw, conn_security=sec)
                return

            raise RuntimeError(msg or "wifi connect failed")
        finally:
            try:
                os.remove(self.connect_lock_path)
            except Exception:
                pass

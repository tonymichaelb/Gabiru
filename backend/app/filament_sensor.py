from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Any, Optional


@dataclass
class FilamentStatus:
    supported: bool
    gpio: int
    has_filament: Optional[bool]
    contact_closed: Optional[bool]
    ts: float
    error: Optional[str] = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "supported": self.supported,
            "gpio": self.gpio,
            "has_filament": self.has_filament,
            "contact_closed": self.contact_closed,
            "ts": self.ts,
            "error": self.error,
        }


class FilamentSensor:
    """Reads a simple contact sensor wired as NC with pull-up.

    Wiring expectation (GPIO17 / physical pin 11):
    - One side of the switch to GPIO17
    - Other side to GND
    - Internal pull-up enabled

    With a NC contact:
    - contact OPEN  => GPIO HIGH  => has_filament = True
    - contact CLOSED => GPIO LOW  => has_filament = False
    """

    def __init__(self, gpio: int = 17, bounce_time_s: float = 0.05) -> None:
        self.gpio = int(gpio)
        self._bounce_time_s = float(bounce_time_s)
        self._supported: Optional[bool] = None
        self._error: Optional[str] = None
        self._button = None

    def _ensure(self) -> None:
        if self._supported is not None:
            return

        def _try_gpiozero_with_factory(factory: object | None) -> None:
            from gpiozero import Button, Device  # type: ignore

            if factory is not None:
                Device.pin_factory = factory  # type: ignore[attr-defined]
            self._button = Button(self.gpio, pull_up=True, bounce_time=self._bounce_time_s)

        try:
            # First try: default factory (works on many Pi setups)
            _try_gpiozero_with_factory(None)
            self._supported = True
            return
        except Exception as e:
            first_err = e

        # Second try: lgpio (common on Raspberry Pi OS Bookworm)
        try:
            from gpiozero.pins.lgpio import LGPIOFactory  # type: ignore

            _try_gpiozero_with_factory(LGPIOFactory())
            self._supported = True
            self._error = None
            return
        except Exception as e:
            second_err = e

        # Third try: RPi.GPIO (common on older Raspberry Pi OS)
        try:
            from gpiozero.pins.rpigpio import RPiGPIOFactory  # type: ignore

            _try_gpiozero_with_factory(RPiGPIOFactory())
            self._supported = True
            self._error = None
            return
        except Exception as e:
            third_err = e

        self._supported = False
        self._button = None
        self._error = f"gpio init failed: default=({first_err}) lgpio=({second_err}) rpigpio=({third_err})"

    def get_status(self) -> FilamentStatus:
        self._ensure()
        ts = time.time()

        if not self._supported or self._button is None:
            return FilamentStatus(
                supported=False,
                gpio=self.gpio,
                has_filament=None,
                contact_closed=None,
                ts=ts,
                error=self._error,
            )

        try:
            # gpiozero.Button with pull_up=True is considered "pressed" when the pin is pulled LOW.
            contact_closed = bool(self._button.is_pressed)
            has_filament = not contact_closed
            return FilamentStatus(
                supported=True,
                gpio=self.gpio,
                has_filament=has_filament,
                contact_closed=contact_closed,
                ts=ts,
            )
        except Exception as e:
            return FilamentStatus(
                supported=False,
                gpio=self.gpio,
                has_filament=None,
                contact_closed=None,
                ts=ts,
                error=str(e),
            )

    def close(self) -> None:
        try:
            if self._button is not None:
                self._button.close()
        except Exception:
            pass
        self._button = None
        self._supported = None
        self._error = None

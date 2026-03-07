"""
Generator backend over RS485 (half‑duplex on the cabinet trunk).
Used on the Generator Pi to forward generator commands downstream to the
remote generator module (FD485/RS232 bridge). Dry-contact control stays local
on the Generator Pi; only generator control commands are forwarded.
"""
from __future__ import annotations

import os
from typing import Any, Dict, Optional

from home_controller.core.backend_core import RS485Backend, RS485NotReady


class GeneratorBackend:
    def __init__(self, port: Optional[str] = None, baud: Optional[int] = None, timeout: float = 0.08, address: int = 0x20) -> None:
        self.port = port or os.getenv("HC_RS485_PORT", "/dev/ttyAMA0")
        self.baud = baud or int(os.getenv("HC_RS485_BAUD", "115200"))
        self.timeout = timeout
        self.addr = address  # matches MODULE_ID_XIAO in gen_core.ino
        self.rs485: Optional[RS485Backend] = None
        self._ensure_backend()

    def _ensure_backend(self) -> None:
        if self.rs485:
            return
        if not RS485Backend or not RS485Backend.available():
            raise RS485NotReady("pyserial/RS485 backend not available")
        self.rs485 = RS485Backend(port=self.port, baudrate=self.baud, timeout=self.timeout)

    # --- Telemetry ---
    def snapshot(self) -> Dict[str, Any]:
        self._ensure_backend()
        snap = self.rs485.gen_snapshot(self.addr)
        if not snap.get("ok"):
            return snap
        t = snap.get("telem", {})
        return {
            "ok": True,
            "running": t.get("rpm", 0) > 0,
            "rpm": t.get("rpm"),
            "hz": t.get("hz_x100", 0) / 100.0 if "hz_x100" in t else None,
            "battery_v": t.get("batt_mv", 0) / 1000.0 if "batt_mv" in t else None,
            "temp_c": t.get("eng_temp_c_x10", 0) / 10.0 if "eng_temp_c_x10" in t else None,
            "gen_v_l1": t.get("gen_v_l1_x10", 0) / 10.0 if "gen_v_l1_x10" in t else None,
            "gen_v_l2": t.get("gen_v_l2_x10", 0) / 10.0 if "gen_v_l2_x10" in t else None,
            "raw": t,
        }

    # --- Commands ---
    def _cmd(self, code: int, p1: int = 0, p2: int = 0) -> Dict[str, Any]:
        self._ensure_backend()
        return self.rs485.gen_send_cmd(self.addr, code, param1=p1, param2=p2)

    def forward_command(self, name: str, param1: int = 0, param2: int = 0) -> Dict[str, Any]:
        """
        Forward a generator control command downstream.
        Supported names: start, stop, exercise, exercise_transfer, clear_alarm, set_mode.
        """
        name = (name or "").lower()
        if name == "start":
            return self.start()
        if name == "stop":
            return self.stop()
        if name in ("exercise", "exercise_no_transfer"):
            return self.exercise(False)
        if name in ("exercise_transfer", "exercise_xfer"):
            return self.exercise(True)
        if name == "clear_alarm":
            return self.clear_alarm()
        if name == "set_mode":
            return self.set_mode(param1)
        return {"ok": False, "error": f"unsupported command: {name}"}

    def start(self) -> Dict[str, Any]:
        return self._cmd(0x01)

    def stop(self) -> Dict[str, Any]:
        return self._cmd(0x02)

    def exercise(self, transfer: bool = False) -> Dict[str, Any]:
        return self._cmd(0x04 if transfer else 0x03)

    def clear_alarm(self) -> Dict[str, Any]:
        return self._cmd(0x05)

    def set_mode(self, mode: int) -> Dict[str, Any]:
        # mode: 1=OFF, 2=AUTO, 3=MANUAL (per gen_core.ino)
        return self._cmd(0x06, p1=mode)

    def close(self) -> None:
        if self.rs485 and getattr(self.rs485, "_ser", None):
            try:
                self.rs485._ser.close()
            except Exception:
                pass
        self.rs485 = None


__all__ = ["GeneratorBackend", "RS485NotReady"]

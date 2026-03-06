"""
backend_core.py
Low-level RS485 helpers for talking to the RP2040 module firmwares under
home_controller/core/module_firmware/*_core.ino.

This file frames the request/response packets exactly as the firmware expects:

DI_core.ino (digital input)
  Request 5B : [0xAA][addr][ch][CMD_READ=0x00][crc=xor(first4)]
  Reply   6B : [0x55][addr][ch][value][senseMask][crc=xor(first5)]
  Special ch : 0xFE -> inputs 0..7 in data, 0xFF -> inputs 8..15 in data

DO_core.ino (digital output)
  Request 5B : [0xAA][addr][ch][cmd(0=off,!=0 on)][crc]
  Reply   6B : [0x55][addr][ch][actual_state][senseMask][crc]
  Note: no read-only command; every request is a set operation.

AIO_core.ino (analog in/out)
  Request 7B : [0xAA][addr][ch][cmd][d0][d1][crc]  (crc xor first6)
               cmd 0x00=READ, 0x01=WRITE
               value12 = d0 | ((d1 & 0x0F)<<8)
  Reply   8B : [0x55][addr][ch][cmd][d0][d1][senseMask][crc]

I2C_core.ino (I2C sensor hub)
  Request 9B  : [0xAA][addr][cmd][type][i2c][p0][p1][p2][crc]
  Reply   12B : [0x55][addr][cmd][type][i2c][field][d0][d1][d2][d3][status][crc]
  Only a minimal helper is provided here; higher-level parsing can be added later.

RS485_core.ino (4‑bus expander)
  Upstream request: [0xAA][moduleAddr][bus][len][payload...][crc]
  Upstream reply  : [0x55][moduleAddr][bus][len][payload...][status][crc]

All CRCs are simple XOR of the preceding bytes in the frame.
"""

from __future__ import annotations

import threading
import time
from typing import Dict, Optional

try:
    import serial  # type: ignore

    _HAS_PYSERIAL = True
except Exception:  # pragma: no cover - optional dependency
    serial = None  # type: ignore
    _HAS_PYSERIAL = False


class RS485NotReady(Exception):
    """Raised when pyserial is missing or the serial port cannot be opened."""


def _xor_crc(buf: bytes) -> int:
    c = 0
    for b in buf:
        c ^= b
    return c & 0xFF


def _pack12(value: int) -> (int, int):
    v = max(0, min(4095, int(value)))
    return v & 0xFF, (v >> 8) & 0x0F


def _unpack12(d0: int, d1: int) -> int:
    return (d0 & 0xFF) | ((d1 & 0x0F) << 8)


class RS485Backend:
    """
    Thin, synchronous RS485 transport for the RP2040 modules.
    Provides one-call helpers per module type; thread-safe via a single lock.
    """

    def __init__(self, port: str, baudrate: int = 115200, timeout: float = 0.08) -> None:
        if not _HAS_PYSERIAL:
            raise RS485NotReady("pyserial is not installed")
        try:
            self._ser = serial.Serial(
                port=port,
                baudrate=baudrate,
                bytesize=serial.EIGHTBITS,
                parity=serial.PARITY_NONE,
                stopbits=serial.STOPBITS_ONE,
                timeout=timeout,
                inter_byte_timeout=timeout,
            )
        except Exception as exc:
            raise RS485NotReady(f"could not open RS485 port {port}: {exc}")
        self._lock = threading.Lock()
        self._timeout = timeout

    @staticmethod
    def available() -> bool:
        return _HAS_PYSERIAL

    # -------------------------------------------------
    # Low-level IO
    # -------------------------------------------------
    def _write_and_read(self, request: bytes, expect_len: int, timeout: Optional[float] = None) -> bytes:
        """Send request bytes and read an exact-length reply or raise TimeoutError."""
        to = timeout if timeout is not None else self._timeout
        end_at = time.time() + to
        with self._lock:
            self._ser.reset_input_buffer()
            self._ser.write(request)
            self._ser.flush()
            buf = b""
            while len(buf) < expect_len:
                remaining = expect_len - len(buf)
                chunk = self._ser.read(remaining)
                if chunk:
                    buf += chunk
                    continue
                if time.time() > end_at:
                    raise TimeoutError(f"RS485 timeout waiting for {expect_len}B reply (got {len(buf)})")
            return buf

    # -------------------------------------------------
    # DI
    # -------------------------------------------------
    def read_di_bitmap(self, addr: int) -> Dict[str, int]:
        """
        Returns 16-bit DI bitmap and sense mask.
        Uses special channels 0xFE (low byte) and 0xFF (high byte).
        """
        lo = self._read_di(addr, 0xFE)
        hi = self._read_di(addr, 0xFF)
        if not lo["ok"]:
            return lo
        if not hi["ok"]:
            return hi
        bitmap = lo["value"] | (hi["value"] << 8)
        return {
            "ok": True,
            "addr": addr,
            "bitmap": bitmap,
            "sense_mask": lo["sense_mask"] | hi["sense_mask"],
            "raw_lo": lo["raw"].hex(),
            "raw_hi": hi["raw"].hex(),
        }

    def _read_di(self, addr: int, ch: int) -> Dict[str, int]:
        req = bytes([0xAA, addr & 0xFF, ch & 0xFF, 0x00])
        crc = _xor_crc(req)
        req += bytes([crc])
        reply = self._write_and_read(req, expect_len=6)
        if len(reply) != 6 or reply[0] != 0x55:
            return {"ok": False, "error": "bad preamble or length", "raw": reply}
        if reply[-1] != _xor_crc(reply[:-1]):
            return {"ok": False, "error": "bad crc", "raw": reply}
        return {
            "ok": True,
            "addr": reply[1],
            "channel": reply[2],
            "value": reply[3],
            "sense_mask": reply[4],
            "raw": reply,
        }

    # -------------------------------------------------
    # DO
    # -------------------------------------------------
    def write_do(self, addr: int, ch: int, on: bool) -> Dict[str, int]:
        """
        Sets a single DO channel (0-15). No pure read command exists in firmware.
        Returns actual state as reported by the module.
        """
        cmd = 0x01 if on else 0x00
        req = bytes([0xAA, addr & 0xFF, ch & 0xFF, cmd])
        crc = _xor_crc(req)
        req += bytes([crc])
        reply = self._write_and_read(req, expect_len=6)
        if len(reply) != 6 or reply[0] != 0x55:
            return {"ok": False, "error": "bad preamble or length", "raw": reply}
        if reply[-1] != _xor_crc(reply[:-1]):
            return {"ok": False, "error": "bad crc", "raw": reply}
        return {
            "ok": True,
            "addr": reply[1],
            "channel": reply[2],
            "actual": reply[3],
            "sense_mask": reply[4],
            "raw": reply,
        }

    # -------------------------------------------------
    # AIO
    # -------------------------------------------------
    def read_aio_channel(self, addr: int, ch: int) -> Dict[str, int]:
        """Reads a single AI/AO channel; ch 0-7 = AI, 8-15 = AO setpoint."""
        req = bytes([0xAA, addr & 0xFF, ch & 0xFF, 0x00, 0x00, 0x00])
        crc = _xor_crc(req)
        req += bytes([crc])
        reply = self._write_and_read(req, expect_len=8)
        if len(reply) != 8 or reply[0] != 0x55:
            return {"ok": False, "error": "bad preamble or length", "raw": reply}
        if reply[-1] != _xor_crc(reply[:-1]):
            return {"ok": False, "error": "bad crc", "raw": reply}
        val12 = _unpack12(reply[4], reply[5])
        return {
            "ok": True,
            "addr": reply[1],
            "channel": reply[2],
            "cmd": reply[3],
            "value12": val12,
            "sense_mask": reply[6],
            "raw": reply,
        }

    def write_aio_channel(self, addr: int, ch: int, value12: int) -> Dict[str, int]:
        """Writes AO channel (8-15). value12 is 0-4095 raw DAC units."""
        d0, d1 = _pack12(value12)
        req = bytes([0xAA, addr & 0xFF, ch & 0xFF, 0x01, d0, d1])
        crc = _xor_crc(req)
        req += bytes([crc])
        reply = self._write_and_read(req, expect_len=8)
        if len(reply) != 8 or reply[0] != 0x55:
            return {"ok": False, "error": "bad preamble or length", "raw": reply}
        if reply[-1] != _xor_crc(reply[:-1]):
            return {"ok": False, "error": "bad crc", "raw": reply}
        val12 = _unpack12(reply[4], reply[5])
        return {
            "ok": True,
            "addr": reply[1],
            "channel": reply[2],
            "cmd": reply[3],
            "value12": val12,
            "sense_mask": reply[6],
            "raw": reply,
        }

    # -------------------------------------------------
    # I2C module (minimal)
    # -------------------------------------------------
    def send_i2c_cmd(
        self, addr: int, cmd: int, sensor_type: int, i2c_addr: int, p0: int = 0, p1: int = 0, p2: int = 0
    ) -> Dict[str, int]:
        """
        Sends a single I2C module command and returns one reply frame.
        Multi-reply commands (e.g. scan, sample_all) should be called repeatedly until timeout.
        """
        req = bytes(
            [
                0xAA,
                addr & 0xFF,
                cmd & 0xFF,
                sensor_type & 0xFF,
                i2c_addr & 0xFF,
                p0 & 0xFF,
                p1 & 0xFF,
                p2 & 0xFF,
            ]
        )
        crc = _xor_crc(req)
        req += bytes([crc])
        reply = self._write_and_read(req, expect_len=12)
        if len(reply) != 12 or reply[0] != 0x55:
            return {"ok": False, "error": "bad preamble or length", "raw": reply}
        if reply[-1] != _xor_crc(reply[:-1]):
            return {"ok": False, "error": "bad crc", "raw": reply}
        return {
            "ok": True,
            "addr": reply[1],
            "cmd": reply[2],
            "sensor_type": reply[3],
            "i2c_addr": reply[4],
            "field": reply[5],
            "d0": reply[6],
            "d1": reply[7],
            "d2": reply[8],
            "d3": reply[9],
            "status": reply[10],
            "raw": reply,
        }

    # -------------------------------------------------
    # Expander raw (optional)
    # -------------------------------------------------
    def send_expander(self, addr: int, bus: int, payload: bytes, timeout: Optional[float] = None) -> Dict[str, object]:
        """
        Talks to RS485_core.ino expander.
        Request: [AA][addr][bus][len][payload...][crc]
        Reply  : [55][addr][bus][len][payload...][status][crc]
        """
        if len(payload) > 255:
            return {"ok": False, "error": "payload too long"}
        req_hdr = bytes([0xAA, addr & 0xFF, bus & 0xFF, len(payload) & 0xFF])
        crc = _xor_crc(req_hdr + payload)
        req = req_hdr + payload + bytes([crc])
        reply = self._write_and_read(req, expect_len=4 + len(payload) + 2, timeout=timeout)
        if len(reply) < 6 or reply[0] != 0x55:
            return {"ok": False, "error": "bad preamble or length", "raw": reply}
        calc_crc = _xor_crc(reply[:-1])
        if reply[-1] != calc_crc:
            return {"ok": False, "error": "bad crc", "raw": reply}
        plen = reply[3]
        payload_out = reply[4 : 4 + plen]
        status = reply[4 + plen]
        return {
            "ok": True if status == 0 else False,
            "addr": reply[1],
            "bus": reply[2],
            "payload": payload_out,
            "status": status,
            "raw": reply,
        }

    # -------------------------------------------------
    def close(self) -> None:
        try:
            self._ser.close()
        except Exception:
            pass

from __future__ import annotations

#!/usr/bin/env python3
"""
home_controller/core/backend.py

Core backend logic for the Home Controller project.

GOALS (v0):
- Single source of truth for runtime state + saved configuration
- Manual module add/remove (type + I2C address)
- Deterministic behavior (no guessing board type from MCP chip)
- Designed to grow into: discovery, drivers, pinmap validation, Flask GUI

ASSUMPTIONS:
- I2C bus is fixed to the main SDA/SCL pins (BCM2/BCM3).
    On Raspberry Pi this is typically /dev/i2c-1 (bus_num = 1).
"""

import json
import os
import shutil
import time
from dataclasses import dataclass, asdict
from typing import Any, Dict, List, Optional, Tuple, Union

import datetime
from home_controller.core import i2c_catalog
from home_controller.config import aio_max_voltage
try:
    from home_controller.core.backend_core import RS485Backend, RS485NotReady
except Exception:  # backend_core may fail if pyserial missing
    RS485Backend = None  # type: ignore
    RS485NotReady = Exception  # type: ignore

# Optional smbus2 import for direct I2C access. If missing, reads will report an error.
try:
    import smbus2
    _HAS_SMBUS = True
except Exception:
    smbus2 = None  # type: ignore
    _HAS_SMBUS = False


# -----------------------------
# Constants / Defaults
# -----------------------------

DEFAULT_I2C_BUS_NUM = 1  # fixed bus (Pi SDA/SCL)

VALID_TYPES = ("di", "do", "aio", "i2c", "rs485", "genmon")  # 'i2c' is I2C Module

# Typical MCP23017 A0..A2 range.
# We can expand later if you add other chips.
MCP23017_MIN = 0x20
MCP23017_MAX = 0x27

# AIO modules: base address (A0..A2 DIP switches add 0..7)
AIO_BASE = 0x30
AIO_MAX = 0x37


# -----------------------------
# Data model
# -----------------------------

@dataclass
class ModuleEntry:
    """
    A configured module. For v0 this is just type + address.

    id format: "i2c1-0x21"
    """
    id: str
    type: str          # "di" | "do" | "aio" | "i2c" (I2C Module)
    address_hex: str   # "0x21"
    name: str = ""     # optional friendly label
    module_num: Optional[int] = None  # optional UI slot 1-10

    def address_int(self) -> int:
        return int(self.address_hex, 16)


@dataclass
class ControllerConfig:
    controller_name: str = "Home Controller"
    notes: str = ""
    i2c_bus_num: int = DEFAULT_I2C_BUS_NUM
    modules: List[ModuleEntry] = None  # type: ignore

    def __post_init__(self) -> None:
        if self.modules is None:
            self.modules = []


# -----------------------------
# Backend
# -----------------------------

class HomeControllerBackend:

    # -----------------------------
    # Per-module config helpers
    # -----------------------------
    def _module_config_path(self, mtype: str, address_hex: str) -> str:
        """Return the config file path for a module (by type and address)."""
        fname = f"{mtype.lower()}_{address_hex.lower()}.json"
        return os.path.join(self._repo_root, "home_controller", "config", "modules", fname)

    def _append_bounded_log(self, path: str, entry: dict, limit: int = 2) -> None:
        """Append a JSON line to path, keeping only the most recent `limit` lines."""
        try:
            os.makedirs(os.path.dirname(path), exist_ok=True)
            existing: list[str] = []
            if os.path.exists(path):
                with open(path, "r", encoding="utf-8") as f:
                    existing = [ln.rstrip("\n") for ln in f if ln.strip()]
            existing.append(json.dumps(entry))
            # keep only last `limit`
            trimmed = existing[-limit:]
            with open(path, "w", encoding="utf-8") as f:
                for ln in trimmed:
                    f.write(ln + "\n")
        except Exception:
            pass

    def _log_gen_serial(self, event: str, req: bytes, resp: bytes) -> None:
        """Append a small diagnostic entry when generator RS485/Modbus times out."""
        try:
            log_path = os.path.expanduser("~/home_controller/home_controller/Gen_Serial_log.json")
            entry = {
                "ts": int(time.time()),
                "event": event,
                "request_hex": req.hex() if isinstance(req, (bytes, bytearray)) else "",
                "response_hex": resp.hex() if isinstance(resp, (bytes, bytearray)) else "",
            }
            self._append_bounded_log(log_path, entry, limit=2)
        except Exception:
            # logging should never break main path
            pass

    def _log_module_error(self, mtype: str, module_id: str, address_hex: str, error: str, raw: Any = None) -> None:
        """Per-module error log written to ~/home_controller/home_controller/<TYPE>_log.json."""
        if not self._module_log_enabled:
            return
        try:
            safe_id = str(module_id).replace("/", "_").replace("\\", "_")
            name = f"{safe_id}_log.json"
            log_path = os.path.expanduser(f"~/home_controller/home_controller/{name}")
            entry = {
                "ts": int(time.time()),
                "module_id": module_id,
                "type": mtype,
                "address": address_hex,
                "error": str(error),
            }
            if isinstance(raw, (bytes, bytearray)):
                entry["raw_hex"] = raw.hex()
            self._append_bounded_log(log_path, entry, limit=2)
        except Exception:
            pass

    def load_module_config(self, mtype: str, address_hex: str) -> dict:
        path = self._module_config_path(mtype, address_hex)
        if not os.path.exists(path):
            return {}
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)

    def save_module_config(self, mtype: str, address_hex: str, data: dict) -> None:
        path = self._module_config_path(mtype, address_hex)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2, sort_keys=True)

    def __init__(self, config_path: Optional[str] = None) -> None:
        self._repo_root = self._find_repo_root()
        self._config_path = config_path or os.path.join(
            self._repo_root, "home_controller", "config", "config.json"
        )
        # bounded logging helpers
        self._module_log_enabled: bool = True
        # dev_mode and dev_file may be set by the caller to simulate I2C
        self._dev_mode = False
        self._dev_file: Optional[str] = None
        self._dev_data: Dict[str, Any] = {}
        self._last_errors: Dict[str, str] = {}
        self._manual_errors_by_num: Dict[int, str] = {}

        self.cfg = self.load_config()
        # Force modules to use the fixed modules I2C bus (ensure modules are always on i2c1)
        self.cfg.i2c_bus_num = DEFAULT_I2C_BUS_NUM

        # Optional RS485 transport (for *_core.ino firmwares)
        self.rs485: Optional[RS485Backend] = None
        self._rs485_err: Optional[str] = None
        self._rs485_port = os.getenv("HC_RS485_PORT", "/dev/ttyAMA0")
        self._rs485_baud = int(os.getenv("HC_RS485_BAUD", "115200"))
        self._rs485_enabled = os.getenv("HC_RS485_ENABLE", "1").lower() not in ("0", "false", "no")
        # RS485-only mode: disable direct I2C access and rely solely on the RS485 bridge paths.
        self._force_rs485 = True

        if self._rs485_enabled and RS485Backend is not None and RS485Backend.available():
            try:
                self.rs485 = RS485Backend(port=self._rs485_port, baudrate=self._rs485_baud, timeout=0.08)
            except Exception as exc:
                self._rs485_err = str(exc)
        else:
            if not self._rs485_enabled:
                self._rs485_err = "RS485 disabled via HC_RS485_ENABLE"
            elif RS485Backend is None or not getattr(RS485Backend, "available", lambda: False)():
                self._rs485_err = "pyserial not installed"

    @staticmethod
    def _rs485_status_name(code: int) -> str:
        names = {
            0x00: "ok",
            0x01: "bad_bus",
            0x02: "timeout",
            0x03: "bad_crc",
            0x04: "too_long",
        }
        return names.get(int(code) & 0xFF, f"err{code}")

    def enable_dev_mode(self, dev_file: Optional[str] = None) -> None:
        """Enable developer simulation mode and load data from `dev_file`.

        If `dev_file` is not provided, defaults to `<repo>/home_controller/config/dev_i2c.json`.
        """
        self._dev_mode = True
        if dev_file:
            self._dev_file = dev_file
        else:
            self._dev_file = os.path.join(self._repo_root, "home_controller", "config", "dev_i2c.json")
        self._dev_data = self._load_dev_data()

    def disable_dev_mode(self) -> None:
        self._dev_mode = False
        self._dev_file = None
        self._dev_data = {}

    def _load_dev_data(self) -> Dict[str, Any]:
        try:
            if not self._dev_file:
                return {}
            if not os.path.exists(self._dev_file):
                return {}
            with open(self._dev_file, "r", encoding="utf-8") as f:
                raw = json.load(f) or {}
            # normalize keys to lowercase hex strings
            out: Dict[str, Any] = {}
            for k, v in raw.items():
                out[str(k).lower()] = v
            return out
        except Exception:
            return {}

    def _save_dev_data(self) -> None:
        try:
            if not self._dev_file:
                return
            os.makedirs(os.path.dirname(self._dev_file), exist_ok=True)
            tmp = self._dev_file + ".tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(self._dev_data, f, indent=2, sort_keys=True)
            os.replace(tmp, self._dev_file)
        except Exception:
            pass

    # --------
    # Paths
    # --------

    def _find_repo_root(self) -> str:
        # backend.py is in home_controller/core/ -> go up two levels
        return os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))

    @property
    def config_path(self) -> str:
        return self._config_path

    # --------
    # Config I/O
    # --------

    def load_config(self) -> ControllerConfig:
        """
        Load config, falling back to .bak if the primary file is missing
        or corrupted (e.g., crash during write).
        """
        def _load(path: str) -> ControllerConfig:
            with open(path, "r", encoding="utf-8") as f:
                raw = json.load(f) or {}

            modules: List[ModuleEntry] = []
            for m in raw.get("modules", []):
                try:
                    modules.append(ModuleEntry(
                        id=str(m["id"]),
                        type=str(m["type"]).lower(),
                        address_hex=str(m["address_hex"]).lower(),
                        name=str(m.get("name", "")),
                        module_num=int(m["module_num"]) if "module_num" in m and m["module_num"] is not None else None,
                    ))
                except Exception:
                    # skip malformed entries
                    continue

            return ControllerConfig(
                controller_name=str(raw.get("controller_name", "Home Controller")),
                notes=str(raw.get("notes", "")),
                i2c_bus_num=int(raw.get("i2c_bus_num", DEFAULT_I2C_BUS_NUM)),
                modules=modules,
            )

        primary = self._config_path
        backup = self._config_path + ".bak"

        if os.path.exists(primary):
            try:
                return _load(primary)
            except Exception:
                pass  # fall through to backup

        if os.path.exists(backup):
            try:
                return _load(backup)
            except Exception:
                pass

        return ControllerConfig()

    def save_config(self) -> None:
        """
        Persist config atomically to avoid corruption after crashes.

        Steps:
          1. Write JSON to <config>.tmp and fsync.
          2. If a current config exists, copy it to .bak (keeps primary in place).
          3. Replace primary with tmp (atomic on POSIX).
        """
        os.makedirs(os.path.dirname(self._config_path), exist_ok=True)
        raw: Dict[str, Any] = {
            "controller_name": self.cfg.controller_name,
            "notes": self.cfg.notes,
            "i2c_bus_num": self.cfg.i2c_bus_num,
            "modules": [asdict(m) for m in self.cfg.modules],
            "saved_at": int(time.time()),
        }
        tmp = self._config_path + ".tmp"
        bak = self._config_path + ".bak"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(raw, f, indent=2, sort_keys=True)
            f.flush()
            os.fsync(f.fileno())
        if os.path.exists(self._config_path):
            try:
                shutil.copy2(self._config_path, bak)
            except Exception:
                pass
        os.replace(tmp, self._config_path)

    # --------
    # Helpers
    # --------

    def normalize_address(self, addr: str) -> Tuple[str, int]:
        """
        Accepts "0x21" or "21" and returns ("0x21", 33).
        Raises ValueError on invalid.
        """
        s = addr.strip().lower()
        if not s:
            raise ValueError("Address is blank")

        if s.startswith("0x"):
            val = int(s, 16)
        else:
            # treat as hex
            val = int(s, 16)

        if val < 0 or val > 0x7F:
            raise ValueError(f"I2C address out of range: {addr}")

        return f"0x{val:02x}", val

    # --------
    # AIO scaling helpers
    # --------
    def _aio_max_in(self, module_id: str, ch: int) -> float:
        cfg = aio_max_voltage.load_aio_max_voltage(module_id)
        try:
            return float(cfg.get("in", {}).get(str(ch), cfg.get("in", {}).get("default", 10.0)))
        except Exception:
            return 10.0

    def _aio_max_out(self, module_id: str, ch: int) -> float:
        cfg = aio_max_voltage.load_aio_max_voltage(module_id)
        try:
            return float(cfg.get("out", {}).get(str(ch), cfg.get("out", {}).get("default", 10.0)))
        except Exception:
            return 10.0

    def _counts_to_voltage(self, counts: int, module_id: str, ch: int, direction: str = "in") -> float:
        full_scale = self._aio_max_in(module_id, ch) if direction == "in" else self._aio_max_out(module_id, ch)
        return (max(0, min(4095, counts)) / 4095.0) * full_scale

    def _voltage_to_counts(self, voltage: float, module_id: str, ch: int) -> int:
        maxv = self._aio_max_out(module_id, ch)
        v = max(0.0, min(maxv, float(voltage)))
        return int(round((v / maxv) * 4095.0))

    # --------
    # Sense / LED helpers
    # --------
    @staticmethod
    def _sense_info(sense_mask: Optional[int], two_lines: bool = True) -> Dict[str, Any]:
        """
        Returns standardized sense/power indicator info for the UI:
          sense1, sense2 (bool or None), power_led in {"off","yellow","green"}.
        two_lines=False treats only sense1.
        """
        if sense_mask is None:
            return {"sense1": None, "sense2": None, "power_led": "off"}

        s1 = bool(sense_mask & 0x01)
        s2 = bool(sense_mask & 0x02) if two_lines else None

        if two_lines:
            if s1 and s2:
                led = "green"
            elif s1 or s2:
                led = "yellow"
            else:
                led = "off"
        else:
            led = "green" if s1 else "off"

        return {"sense1": s1, "sense2": s2, "power_led": led}

    def _module_id(self, address_hex: str, mtype: Optional[str] = None) -> str:
        """
        Build a module id string that is unique per bus.

        - I2C-based modules (di/do/aio/i2c/ext) keep the historical
          `i2c<bus>-0xNN` format.
        - RS485-based modules (rs485 hub, genmon) use `rs485-0xNN`
          so they no longer collide with I2C addresses.
        """
        if (mtype or "").lower() in ("rs485", "genmon"):
            return f"rs485-{address_hex.lower()}"
        return f"i2c{DEFAULT_I2C_BUS_NUM}-{address_hex.lower()}"

    def _find_module_index(self, mid: str) -> int:
        for i, m in enumerate(self.cfg.modules):
            if m.id.lower() == mid.lower():
                return i
        return -1

    def _set_last_error(self, module_id: str, err: Optional[str]) -> None:
        if err:
            self._last_errors[module_id] = err
        else:
            self._last_errors.pop(module_id, None)

    def get_last_error(self, module_id: str) -> Optional[str]:
        return self._last_errors.get(module_id)

    def module_errors_map(self) -> Dict[str, str]:
        """Return map of module_id -> last_error (only those with errors)."""
        return dict(self._last_errors)

    def health_check_modules(self) -> None:
        """
        Light health check used by head indicators:
        - For modules with a module_num, attempt a read.
        - If read fails, set last_error for that module_num.
        - If it succeeds and the existing error was a 'not responding' marker, clear it.
        """
        for m in self.cfg.modules:
            if m.module_num is None:
                continue
            try:
                res = self.read_module(m.id)
                if not res.get("ok"):
                    msg = f"{m.type.upper()} not responding ({res.get('error', 'error')})"
                    self.set_last_error_for_module_num(m.module_num, msg)
                else:
                    cur = self.get_last_error(m.id)
                    if cur and "not responding" in cur.lower():
                        self.set_last_error_for_module_num(m.module_num, None)
            except Exception as exc:
                msg = f"{m.type.upper()} not responding ({exc})"
                self.set_last_error_for_module_num(m.module_num, msg)

    def module_errors_by_num(self) -> Dict[str, Dict[str, str]]:
        """
        Return map of module_num (string) -> {module_id, error}
        Includes real module errors and any manual/test errors set by module_num.
        """
        out: Dict[str, Dict[str, str]] = {}
        errs = self._last_errors
        for m in self.cfg.modules:
            if m.module_num is None:
                continue
            if m.id in errs:
                out[str(m.module_num)] = {"module_id": m.id, "error": errs[m.id]}
        for num, msg in self._manual_errors_by_num.items():
            out[str(num)] = {"module_id": None, "error": msg}
        return out

    def set_last_error_for_module(self, module_id: str, err: Optional[str]) -> None:
        """Public helper to set/clear last_error for a module by id."""
        mid = module_id.strip()
        idx = self._find_module_index(mid)
        if idx < 0:
            raise ValueError(f"Module not found: {mid}")
        self._set_last_error(mid, err)

    def set_last_error_for_module_num(self, module_num: int, err: Optional[str]) -> None:
        """Public helper to set/clear last_error by module_num (1-10)."""
        if not (1 <= int(module_num) <= 10):
            raise ValueError("module_num must be 1..10")
        # clear manual entry first
        self._manual_errors_by_num.pop(int(module_num), None)
        for m in self.cfg.modules:
            if m.module_num == int(module_num):
                self._set_last_error(m.id, err)
                return
        # if no module exists with that slot, keep a manual entry so UI can show it
        if err:
            self._manual_errors_by_num[int(module_num)] = err

    # --------
    # Public API
    # --------

    def list_modules(self) -> List[ModuleEntry]:
        return list(self.cfg.modules)

    def add_module(self, mtype: str, address: str, name: str = "") -> ModuleEntry:
        mtype = mtype.strip().lower()
        if mtype not in VALID_TYPES:
            raise ValueError(f"Invalid module type: {mtype}")

        # No address normalization or guardrails for any module type
        address_hex = address.strip()
        mid = self._module_id(address_hex, mtype)
        if self._find_module_index(mid) >= 0:
            raise ValueError(f"Module already exists: {mid}")
        entry = ModuleEntry(id=mid, type=mtype, address_hex=address_hex, name=name.strip())
        self.cfg.modules.append(entry)
        self.save_config()
        return entry

        entry = ModuleEntry(id=mid, type=mtype, address_hex=address_hex, name=name.strip())
        self.cfg.modules.append(entry)
        self.save_config()
        return entry

    def remove_module(self, module_id: str) -> None:
        mid = module_id.strip()
        idx = self._find_module_index(mid)
        if idx < 0:
            raise ValueError(f"Module not found: {mid}")
        self.cfg.modules.pop(idx)
        self.save_config()

    def rename_module(self, module_id: str, new_name: str) -> None:
        mid = module_id.strip()
        idx = self._find_module_index(mid)
        if idx < 0:
            raise ValueError(f"Module not found: {mid}")
        self.cfg.modules[idx].name = new_name.strip()
        self.save_config()

    def change_module_address(self, module_id: str, new_address: str) -> ModuleEntry:
        """
        Change the I2C address of an existing module without removing it.

        Returns the updated ModuleEntry on success.
        """
        mid = module_id.strip()
        idx = self._find_module_index(mid)
        if idx < 0:
            raise ValueError(f"Module not found: {mid}")

        m = self.cfg.modules[idx]

        # normalize and validate new address
        address_hex, address_int = self.normalize_address(new_address)

        # type-specific guardrails
        if m.type in ("di", "do"):
            if not (MCP23017_MIN <= address_int <= MCP23017_MAX):
                raise ValueError("DI/DO addresses must be in 0x20–0x27 (MCP23017 default range)")
        if m.type == "aio":
            if not (AIO_BASE <= address_int <= AIO_MAX):
                raise ValueError("AIO addresses must be in 0x30–0x37 (AIO base + 3 DIP bits)")

        new_mid = self._module_id(address_hex, m.type)
        # ensure we won't collide with another module
        existing = self._find_module_index(new_mid)
        if existing >= 0 and existing != idx:
            raise ValueError(f"Another module already uses address {address_hex}")

        # update module entry
        m.address_hex = address_hex
        m.id = new_mid
        self.save_config()
        return m

    def set_module_number(self, module_id: str, module_num: Optional[int]) -> ModuleEntry:
        """
        Assign a UI module number (1-10) with uniqueness enforced.
        """
        mid = module_id.strip()
        idx = self._find_module_index(mid)
        if idx < 0:
            raise ValueError(f"Module not found: {mid}")
        if module_num is not None:
            if not (1 <= module_num <= 10):
                raise ValueError("module_num must be 1..10")
            for i, m in enumerate(self.cfg.modules):
                if i != idx and m.module_num == module_num:
                    friendly = m.name or f"{m.type.upper()} @ {m.address_hex}"
                    raise ValueError(
                        f"Module ID {module_num} is already used by {friendly} "
                        f"({m.type.upper()} @ {m.address_hex})"
                    )
        self.cfg.modules[idx].module_num = module_num
        self.save_config()
        return self.cfg.modules[idx]

    # -----------------------------
    # Module-specific I2C reads
    # -----------------------------

    def read_module(self, module_id: str) -> Dict[str, Any]:
        """
        Read and parse a configured module's state (prefers RS485 when enabled, falls back to I2C/dev-mode).

        Returns a dict with keys: ok, module_id, type, address, and type-specific data.
        """
        idx = self._find_module_index(module_id)
        if idx < 0:
            raise ValueError(f"Module not found: {module_id}")

        m = self.cfg.modules[idx]
        self._set_last_error(module_id, None)

        addr_key = m.address_hex.lower()

        if self._force_rs485 and not self.rs485:
            self._log_module_error(m.type, m.id, m.address_hex, "RS485-only mode but RS485 backend not available")
            return {"ok": False, "error": "RS485-only mode but RS485 backend not available"}

        # Dev-mode: return simulated data if available. If exact address
        # isn't present in the dev file, fall back to any compatible
        # simulated entry (useful for quick testing where addresses differ).
        addr_key = m.address_hex.lower()
        if self._dev_mode:
            dev = self._dev_data.get(addr_key)
            # fallback: if no exact match, try to find a compatible dev entry
            if dev is None:
                for k, v in self._dev_data.items():
                    if not isinstance(v, dict):
                        continue
                    # AIO entries typically contain 'channels' or 'raw_response'
                    if m.type == 'aio' and ('raw_response' in v or 'channels' in v):
                        dev = v
                        break
                    # DI/DO entries typically contain gpio_a/gpio_b
                    if m.type in ('di', 'do') and ('gpio_a' in v or 'gpio_b' in v):
                        dev = v
                        break

            if dev is not None:
                self._set_last_error(module_id, None)
                # DI/DO simulated via gpio_a/gpio_b or explicit channels
                if m.type in ("di", "do"):
                    a = int(dev.get("gpio_a", 0))
                    b = int(dev.get("gpio_b", 0))
                    channels: Dict[str, int] = {}
                    for i in range(8):
                        channels[str(i + 1)] = 1 if ((a >> i) & 1) else 0
                    for i in range(8):
                        channels[str(9 + i)] = 1 if ((b >> i) & 1) else 0
                    return {
                        "ok": True,
                        "comms_ok": True,
                        "module_id": m.id,
                        "type": m.type,
                        "address": m.address_hex,
                        "ports": {"gpio_a": a, "gpio_b": b},
                        "channels": channels,
                        "power": self._sense_info(None, two_lines=True),
                    }
                elif m.type == "aio":
                    # AIO simulated via channels list or raw_response
                    if "raw_response" in dev:
                        s = str(dev.get("raw_response", ""))
                        parts = [p.strip() for p in s.split(",") if p.strip()]
                        values: List[float] = []
                        for p in parts:
                            try:
                                values.append(float(p))
                            except Exception:
                                values.append(float("nan"))
                    else:
                        vals = dev.get("channels", [])
                        values = [float(v) for v in vals]

                    channels: Dict[str, float] = {}
                    max_ch = min(len(values), 8)
                    for i in range(max_ch):
                        channels[str(i + 1)] = values[i]

                    return {
                        "ok": True,
                        "comms_ok": True,
                        "module_id": m.id,
                        "type": m.type,
                        "address": m.address_hex,
                        "raw_response": dev.get("raw_response", ",".join(str(v) for v in values)),
                        "channels": channels,
                        "power": self._sense_info(None, two_lines=True),
                        "comms_led": "green",
                    }

        # RS485 path (preferred when enabled)
        addr_int = m.address_int()
        if self.rs485:
            try:
                if m.type == "di":
                    res = self.rs485.read_di_bitmap(addr_int)
                    if res.get("ok"):
                        self._set_last_error(module_id, None)
                        bm = int(res.get("bitmap", 0))
                        channels: Dict[str, int] = {}
                        for i in range(16):
                            channels[str(i + 1)] = 1 if ((bm >> i) & 1) else 0
                        return {
                            "ok": True,
                            "comms_ok": True,
                            "module_id": m.id,
                            "type": m.type,
                            "address": m.address_hex,
                            "bitmap": bm,
                            "sense_mask": res.get("sense_mask"),
                            "power": self._sense_info(res.get("sense_mask"), two_lines=True),
                            "comms_led": "green",
                            "channels": channels,
                            "raw": {
                                "lo": res.get("raw_lo"),
                                "hi": res.get("raw_hi"),
                            },
                        }
                    else:
                        self._log_module_error(m.type, m.id, m.address_hex, res.get("error", "DI RS485 read failed"), res.get("raw"))
                        return res
                elif m.type == "aio":
                    channels: Dict[str, float] = {}
                    raw_frames: Dict[str, str] = {}
                    sense_mask = None
                    alerts = []
                    # Read AI channels 0..7 (presented as 1..8 to UI)
                    for ch in range(8):
                        r = self.rs485.read_aio_channel(addr_int, ch)
                        if not r.get("ok"):
                            self._set_last_error(module_id, r.get("error") or "AIO RS485 read failed")
                            self._log_module_error(m.type, m.id, m.address_hex, r.get("error", "AIO RS485 read failed"), r.get("raw"))
                            return r
                        v12 = int(r.get("value12", 0))
                        if sense_mask is None:
                            sense_mask = r.get("sense_mask")
                        raw_frames[str(ch + 1)] = r.get("raw", b"").hex() if isinstance(r.get("raw"), (bytes, bytearray)) else ""
                        v = self._counts_to_voltage(v12, m.id, ch + 1, direction="in")
                        channels[str(ch + 1)] = v
                        # over-voltage alert
                        max_cfg = aio_max_voltage.load_aio_max_voltage(m.id)
                        maxv = None
                        if max_cfg and "in" in max_cfg and str(ch + 1) in max_cfg["in"]:
                            try:
                                maxv = float(max_cfg["in"][str(ch + 1)])
                            except Exception:
                                maxv = None
                        if maxv is not None and v is not None and v > maxv:
                            alerts.append({
                                "module": m.id,
                                "address": m.address_hex,
                                "channel": ch + 1,
                                "max_voltage": maxv,
                                "measured_voltage": v,
                                "timestamp": int(time.time()),
                            })
                    return {
                        "ok": True,
                        "comms_ok": True,
                        "module_id": m.id,
                        "type": m.type,
                        "address": m.address_hex,
                        "channels": channels,
                        "sense_mask": sense_mask,
                        "power": self._sense_info(sense_mask, two_lines=True),
                        "comms_led": "green",
                        "raw_frames": raw_frames,
                        "alerts": alerts,
                    }
                elif m.type == "do":
                    res = self.rs485.read_do_bitmap(addr_int)
                    if res.get("ok"):
                        self._set_last_error(module_id, None)
                        bm = int(res.get("bitmap", 0))
                        channels: Dict[str, int] = {}
                        for i in range(16):
                            channels[str(i + 1)] = 1 if ((bm >> i) & 1) else 0
                        return {
                            "ok": True,
                            "comms_ok": True,
                            "module_id": m.id,
                            "type": m.type,
                            "address": m.address_hex,
                            "bitmap": bm,
                            "sense_mask": res.get("sense_mask"),
                            "power": self._sense_info(res.get("sense_mask"), two_lines=True),
                            "comms_led": "green",
                            "channels": channels,
                            "raw": {
                                "lo": res.get("raw_lo"),
                                "hi": res.get("raw_hi"),
                            },
                        }
                    else:
                        self._set_last_error(module_id, res.get("error", "DO RS485 read failed"))
                        self._log_module_error(m.type, m.id, m.address_hex, res.get("error", "DO RS485 read failed"), res.get("raw"))
                        return res
                elif m.type == "genmon":
                    snap = self.rs485.gen_snapshot(addr_int, trace_logger=self._log_gen_serial)
                    if not snap.get("ok"):
                        self._set_last_error(module_id, snap.get("error", "Gen RS485 read failed"))
                        self._log_module_error(m.type, m.id, m.address_hex, snap.get("error", "Gen RS485 read failed"), snap.get("raw"))
                        return {"ok": False, "error": snap.get("error", "Gen RS485 read failed")}
                    t = snap["telem"]
                    telem = {
                        "uptime_s": t["uptime_s"],
                        "battery_v": round(t["batt_mv"] / 1000.0, 3),
                        "temp_c": round(t["eng_temp_c_x10"] / 10.0, 1),
                        "gen_v_l1": round(t["gen_v_l1_x10"] / 10.0, 1),
                        "gen_v_l2": round(t["gen_v_l2_x10"] / 10.0, 1),
                        "util_v_l1": round(t["util_v_l1_x10"] / 10.0, 1),
                        "util_v_l2": round(t["util_v_l2_x10"] / 10.0, 1),
                        "amps_l1": round(t["amps_l1_x100"] / 100.0, 2),
                        "amps_l2": round(t["amps_l2_x100"] / 100.0, 2),
                        "hz": round(t["hz_x100"] / 100.0, 2),
                        "rpm": int(t["rpm"]),
                        "run_seconds": int(t["run_seconds"]),
                        "alarm_code": int(t["alarm_code"]),
                        "warn_code": int(t["warn_code"]),
                        "state": int(t["state"]),
                        "mode": int(t["mode"]),
                        "flags": int(t["flags"]),
                        "poll_ms": int(t["poll_ms"]),
                        "good_frames": int(t["good_frames"]),
                        "bad_frames": int(t["bad_frames"]),
                    }
                    state_map = {
                        0: "UNKNOWN",
                        1: "STOPPED",
                        2: "STARTING",
                        3: "RUNNING",
                        4: "COOLDOWN",
                        5: "EXERCISE",
                        6: "ALARM",
                        7: "WARNING",
                    }
                    mode_map = {0: "UNKNOWN", 1: "OFF", 2: "AUTO", 3: "MANUAL"}
                    telem["run_state"] = state_map.get(telem["state"], "UNKNOWN")
                    telem["mode_name"] = mode_map.get(telem["mode"], "UNKNOWN")
                    running = telem["rpm"] > 0 or telem["state"] == 3
                    self._set_last_error(module_id, None)
                    return {
                        "ok": True,
                        "comms_ok": True,
                        "module_id": m.id,
                        "type": m.type,
                        "address": m.address_hex,
                        "running": running,
                        "run_state": telem["run_state"],
                        "mode": telem["mode_name"],
                        "rpm": telem["rpm"],
                        "hz": telem["hz"],
                        "battery_v": telem["battery_v"],
                        "temp_c": telem["temp_c"],
                        "gen_v_l1": telem["gen_v_l1"],
                        "gen_v_l2": telem["gen_v_l2"],
                        "util_v_l1": telem["util_v_l1"],
                        "util_v_l2": telem["util_v_l2"],
                        "amps_l1": telem["amps_l1"],
                        "amps_l2": telem["amps_l2"],
                        "alarm_code": telem["alarm_code"],
                        "warn_code": telem["warn_code"],
                        "raw_telem": telem,
                    }
                elif m.type == "i2c":
                    CMD_SCAN_I2C = 0x05
                    CMD_LIST_REGISTERED = 0x09
                    CMD_SAMPLE_ALL = 0x08
                    # 1) list registered devices
                    lst = self.rs485.send_i2c_cmd_multi(addr_int, CMD_LIST_REGISTERED, 0, 0, timeout=0.8)
                    if not lst.get("ok"):
                        self._set_last_error(module_id, lst.get("error", "I2C module RS485 list failed"))
                        self._log_module_error(m.type, m.id, m.address_hex, lst.get("error", "I2C module RS485 list failed"), lst.get("raw"))
                        return {"ok": False, "error": lst.get("error", "I2C module RS485 list failed")}
                    devices = []
                    for f in lst["frames"]:
                        if not f.get("ok"):
                            continue
                        if f.get("field") == 0x11 and f.get("status") == 0:  # FIELD_REGISTRY_ENTRY
                            devices.append(
                                {
                                    "sensor_type": f.get("sensor_type"),
                                    "i2c_addr": f.get("i2c_addr"),
                                    "slot": f.get("d1"),
                                    "options": f.get("d2"),
                                }
                            )

                    # 2) sample all registered sensors
                    samples = []
                    samp = self.rs485.send_i2c_cmd_multi(addr_int, CMD_SAMPLE_ALL, 0, 0, timeout=1.2)
                    if samp.get("ok"):
                        for f in samp["frames"]:
                            if not f.get("ok") or f.get("status") != 0:
                                continue
                            val = f.get("d0") | (f.get("d1") << 8) | (f.get("d2") << 16) | (f.get("d3") << 24)
                            samples.append(
                                {
                                    "sensor_type": f.get("sensor_type"),
                                    "i2c_addr": f.get("i2c_addr"),
                                    "field": f.get("field"),
                                    "value": val,
                                }
                            )

                    # 3) quick scan for any other devices
                    scan = self.rs485.send_i2c_cmd_multi(addr_int, CMD_SCAN_I2C, 0, 0, timeout=0.8)
                    scan_found = []
                    if scan.get("ok"):
                        for f in scan["frames"]:
                            if f.get("ok") and f.get("field") == 0x0E and f.get("status") == 0:
                                scan_found.append(f.get("i2c_addr"))

                    name_map = i2c_catalog.id_to_name_map()
                    for d in devices:
                        try:
                            sid = int(str(d.get("sensor_type", 0)))
                            d["sensor_name"] = name_map.get(sid, f"0x{sid:02x}")
                        except Exception:
                            pass
                    for s in samples:
                        try:
                            sid = int(str(s.get("sensor_type", 0)))
                            s["sensor_name"] = name_map.get(sid, f"0x{sid:02x}")
                        except Exception:
                            pass

                    self._set_last_error(module_id, None)
                    return {
                        "ok": True,
                        "comms_ok": True,
                        "module_id": m.id,
                        "type": m.type,
                        "address": m.address_hex,
                        "registered": devices,
                        "samples": samples,
                        "scan_found": scan_found,
                    }
                elif m.type == "rs485":
                    res = self.rs485.read_rs485_stats(addr_int)
                    if res.get("ok"):
                        cfg = self.load_module_config("rs485", m.address_hex)
                        bus_enable_cfg = cfg.get("bus_enable", {})

                        bus_errors = []
                        any_err = False
                        for be in res.get("bus_errors", []):
                            bus_idx = str(be.get("bus"))
                            enabled = bus_enable_cfg.get(bus_idx, True)
                            be = dict(be)
                            be["enabled"] = bool(enabled)
                            if not enabled:
                                be["errors"] = 0
                                be["last_status"] = 0
                            else:
                                if (be.get("errors", 0) > 0) or (be.get("last_status", 0) != 0):
                                    any_err = True
                            bus_errors.append(be)

                        if any_err:
                            bad = [
                                f"bus{be.get('bus')} {self._rs485_status_name(be.get('last_status', 0))}"
                                for be in bus_errors
                                if be.get("enabled") and ((be.get("errors", 0) > 0) or (be.get("last_status", 0) != 0))
                            ]
                            msg = ", ".join(bad)
                            self._set_last_error(module_id, msg or "RS485 bus error")
                        else:
                            self._set_last_error(module_id, None)

                        return {
                            "ok": True,
                            "comms_ok": True,
                            "module_id": m.id,
                            "type": m.type,
                            "address": m.address_hex,
                            "bus_errors": bus_errors,
                            "bus_enable": bus_enable_cfg,
                            "raw": res.get("raw"),
                        }
                    else:
                        self._set_last_error(module_id, res.get("error") or "RS485 hub read failed")
                        return {"ok": False, "error": res.get("error", "RS485 hub read failed")}
            except Exception as e:
                # fall through to legacy I2C path on any RS485 issue
                self._set_last_error(module_id, str(e))
                pass

        if self._force_rs485:
            # RS485 is required; don't attempt I2C fallback
            return {"ok": False, "error": self._last_errors.get(module_id) or "RS485 read failed (I2C disabled)"}

        if not _HAS_SMBUS:
            return {"ok": False, "error": "smbus2 not installed on this system"}

        # MCP23017 registers for GPIO (reads reflect pin state)
        MCP_GPIOA = 0x12
        MCP_GPIOB = 0x13

        if m.type in ("di", "do"):
            try:
                with smbus2.SMBus(self.cfg.i2c_bus_num) as bus:
                    a = bus.read_byte_data(m.address_int(), MCP_GPIOA)
                    b = bus.read_byte_data(m.address_int(), MCP_GPIOB)
                self._set_last_error(module_id, None)

                # Map bits to channel numbers: 1-8 -> GPIOA bit0..7, 9-16 -> GPIOB bit0..7
                channels: Dict[str, int] = {}
                for i in range(8):
                    channels[str(i + 1)] = 1 if ((a >> i) & 1) else 0
                for i in range(8):
                    channels[str(9 + i)] = 1 if ((b >> i) & 1) else 0

                return {
                    "ok": True,
                    "comms_ok": True,
                    "module_id": m.id,
                    "type": m.type,
                    "address": m.address_hex,
                    "ports": {"gpio_a": a, "gpio_b": b},
                    "channels": channels,
                    "power": self._sense_info(None, two_lines=True),
                    "comms_led": "green",
                }
            except Exception as e:
                self._set_last_error(module_id, f"I2C read error: {e}")
                return {"ok": False, "error": f"I2C read error: {e}"}


        elif m.type == "aio":
            # AIO protocol: write single-byte 0x01 to request status,
            # then device returns an ASCII CSV of voltages (e.g. "1.23,2.34,...").
            try:
                with smbus2.SMBus(self.cfg.i2c_bus_num) as bus:
                    # send request byte
                    try:
                        bus.write_byte(m.address_int(), 0x01)
                    except Exception:
                        # some devices require write_i2c_block_data with no register
                        try:
                            bus.write_i2c_block_data(m.address_int(), 0, [])
                        except Exception:
                            pass

                    # read up to 128 bytes response
                    from smbus2 import i2c_msg

                    read_len = 128
                    msg = i2c_msg.read(m.address_int(), read_len)
                    bus.i2c_rdwr(msg)
                    raw = bytes(msg)

                # decode and parse ASCII CSV
                s = raw.split(b"\x00", 1)[0].decode("utf-8", errors="ignore").strip()
                if not s:
                    return {"ok": False, "error": "empty response from AIO module"}

                parts = [p.strip() for p in s.split(",") if p.strip()]
                # parse floats and limit to expected channels (default 8)
                values: List[float] = []
                for p in parts:
                    try:
                        values.append(float(p))
                    except Exception:
                        values.append(float("nan"))

                channels: Dict[str, float] = {}
                max_ch = min(len(values), 8)
                for i in range(max_ch):
                    channels[str(i + 1)] = values[i]

                # --- Over-voltage alert logic ---
                max_cfg = aio_max_voltage.load_aio_max_voltage(m.id)
                alerts = []
                for ch in range(1, max_ch + 1):
                    v = values[ch - 1]
                    maxv = None
                    if max_cfg and "in" in max_cfg and str(ch) in max_cfg["in"]:
                        try:
                            maxv = float(max_cfg["in"][str(ch)])
                        except Exception:
                            pass
                    if maxv is not None and v > maxv:
                        alert = {
                            "module": m.id,
                            "address": m.address_hex,
                            "channel": ch,
                            "max_voltage": maxv,
                            "measured_voltage": v,
                            "timestamp": datetime.datetime.now().isoformat(),
                        }
                        alerts.append(alert)
                if alerts:
                    # Log to a file in config for now
                    log_path = os.path.join(self._repo_root, "home_controller", "config", "aio_alerts.log")
                    with open(log_path, "a", encoding="utf-8") as f:
                        for alert in alerts:
                            f.write(json.dumps(alert) + "\n")

                return {
                    "ok": True,
                    "comms_ok": True,
                    "module_id": m.id,
                    "type": m.type,
                    "address": m.address_hex,
                    "raw_response": s,
                    "channels": channels,
                    "power": self._sense_info(None, two_lines=True),
                    "comms_led": "green",
                    "alerts": alerts,
                }
            except Exception as e:
                self._set_last_error(module_id, f"AIO I2C read error: {e}")
                return {"ok": False, "error": f"AIO I2C read error: {e}"}

        else:
            return {"ok": False, "error": f"Unsupported module type: {m.type}"}

    def read_hat_status(self, bus_num: int = 0, address: int = 0x20) -> Dict[str, Any]:
        """
        Report per-slot power/sense info using RS485 module responses (sense masks),
        instead of direct I2C hat GPIO reads. Falls back to dev data when in dev mode.
        """
        # Dev-mode: keep existing simulated hat entries for quick testing
        addr_key = f"0x{address:02x}".lower()
        if self._dev_mode:
            dev = self._dev_data.get(addr_key)
            if dev is not None:
                a = int(dev.get("gpio_a", 0))
                b = int(dev.get("gpio_b", 0))
                modules: Dict[str, Dict[str, bool]] = {}
                for i in range(8):
                    modules[str(i + 1)] = {
                        "24v_a": bool((a >> i) & 1),
                        "24v_b": bool((b >> i) & 1),
                    }
                return {
                    "ok": True,
                    "source": "dev",
                    "modules": modules,
                    "bus": bus_num,
                    "address": addr_key,
                }

        # RS485 path: use module sense masks (already part of DI/AIO reads and DO writes).
        if self._force_rs485 and not self.rs485:
            return {"ok": False, "error": "RS485-only mode but RS485 backend not available"}

        if self.rs485:
            modules: Dict[str, Dict[str, Any]] = {}
            errs: Dict[str, str] = {}
            for m in self.cfg.modules:
                if m.module_num is None:
                    continue
                try:
                    res = self.read_module(m.id)
                except Exception as exc:
                    errs[str(m.module_num)] = str(exc)
                    modules[str(m.module_num)] = {
                        "module_id": m.id,
                        "type": m.type,
                        "address": m.address_hex,
                        "24v_a": None,
                        "24v_b": None,
                        "power_led": "off",
                        "comms_ok": False,
                        "error": str(exc),
                    }
                    continue

                power = res.get("power", {}) or {}
                modules[str(m.module_num)] = {
                    "module_id": m.id,
                    "type": m.type,
                    "address": m.address_hex,
                    "24v_a": power.get("sense1"),
                    "24v_b": power.get("sense2"),
                    "power_led": power.get("power_led"),
                    "comms_ok": res.get("comms_ok", False),
                    "last_error": self.get_last_error(m.id),
                }

            return {
                "ok": True,
                "source": "rs485",
                "modules": modules,
                "errors": errs if errs else None,
            }

        # If RS485 is not forced and not available, indicate lack of support
        return {"ok": False, "error": "hat status via RS485 not available"}

    def write_module(self, module_id: str, channel: int, value: Union[int, float]) -> Dict[str, Any]:
        """
        Write a single channel for DO (1-16) or AIO (1-8).

        For DO: `value` must be 0 or 1.
        For AIO: `value` is a voltage (float); converted to DAC counts and sent over RS485 when enabled.
        """
        idx = self._find_module_index(module_id)
        if idx < 0:
            raise ValueError(f"Module not found: {module_id}")

        m = self.cfg.modules[idx]

        if self._force_rs485 and not self._dev_mode and not self.rs485:
            return {"ok": False, "error": "RS485-only mode but RS485 backend not available"}

        if m.type == "do":
            # DO behaviour (existing)
            if not (1 <= channel <= 16):
                return {"ok": False, "error": "channel must be 1..16"}

            if int(value) not in (0, 1):
                return {"ok": False, "error": "value must be 0 or 1"}

            # Determine port and bit for DO channel
            if channel <= 8:
                port = "a"
                bit = channel - 1
            else:
                port = "b"
                bit = channel - 9

            # If running in dev/simulate mode, update the simulated dev data
            if self._dev_mode:
                addrk = m.address_hex.lower()
                dev = self._dev_data.get(addrk, {}) if isinstance(self._dev_data, dict) else {}
                try:
                    a = int(dev.get("gpio_a", 0))
                    b = int(dev.get("gpio_b", 0))
                except Exception:
                    a = 0
                    b = 0

                if port == "a":
                    cur = a
                else:
                    cur = b

                if int(value) == 1:
                    new = cur | (1 << bit)
                else:
                    new = cur & ~(1 << bit)

                if port == "a":
                    a = new & 0xFF
                else:
                    b = new & 0xFF

                dev_out = {"gpio_a": a, "gpio_b": b}
                self._dev_data[addrk] = dev_out
                try:
                    self._save_dev_data()
                except Exception:
                    pass

                channels: Dict[str, int] = {}
                for i in range(8):
                    channels[str(i + 1)] = 1 if ((a >> i) & 1) else 0
                for i in range(8):
                    channels[str(9 + i)] = 1 if ((b >> i) & 1) else 0

                return {
                    "ok": True,
                    "comms_ok": True,
                    "module_id": m.id,
                    "type": m.type,
                    "address": m.address_hex,
                    "ports": {"gpio_a": a, "gpio_b": b},
                    "channels": channels,
                    "power": self._sense_info(None, two_lines=True),
                    "comms_led": "green",
                }

                if self.rs485:
                    try:
                        fw_channel = channel - 1  # firmware uses 0-15
                        res = self.rs485.write_do(m.address_int(), fw_channel, bool(int(value)))
                        if not res.get("ok"):
                            self._set_last_error(module_id, res.get("error", "RS485 write failed"))
                            return {"ok": False, "error": res.get("error", "RS485 write failed")}
                        self._set_last_error(module_id, None)
                        return {
                            "ok": True,
                            "comms_ok": True,
                            "module_id": m.id,
                            "type": m.type,
                            "address": m.address_hex,
                            "channel": channel,
                            "state": res.get("actual"),
                            "sense_mask": res.get("sense_mask"),
                            "power": self._sense_info(res.get("sense_mask"), two_lines=True),
                            "comms_led": "green",
                            "raw": res.get("raw"),
                        }
                    except Exception as e:
                        self._set_last_error(module_id, f"RS485 DO write error: {e}")
                        return {"ok": False, "error": f"RS485 DO write error: {e}"}

            if self._force_rs485:
                return {"ok": False, "error": self._last_errors.get(module_id) or "RS485 DO write failed"}

            if not _HAS_SMBUS:
                return {"ok": False, "error": "smbus2 not installed on this system"}

            # MCP23017 registers
            MCP_GPIOA = 0x12
            MCP_GPIOB = 0x13
            MCP_OLATA = 0x14
            MCP_OLATB = 0x15

            try:
                with smbus2.SMBus(self.cfg.i2c_bus_num) as bus:
                    # try reading OLAT first (output latch), fallback to GPIO
                    try:
                        if port == "a":
                            cur = bus.read_byte_data(m.address_int(), MCP_OLATA)
                        else:
                            cur = bus.read_byte_data(m.address_int(), MCP_OLATB)
                    except Exception:
                        # fallback
                        if port == "a":
                            cur = bus.read_byte_data(m.address_int(), MCP_GPIOA)
                        else:
                            cur = bus.read_byte_data(m.address_int(), MCP_GPIOB)

                    # ensure the pin is configured as output in IODIR (clear bit)
                    MCP_IODIRA = 0x00
                    MCP_IODIRB = 0x01
                    try:
                        if port == "a":
                            iodir = bus.read_byte_data(m.address_int(), MCP_IODIRA)
                        else:
                            iodir = bus.read_byte_data(m.address_int(), MCP_IODIRB)
                        # if the bit is set (input) clear it to make output
                        if (iodir >> bit) & 1:
                            new_iodir = iodir & ~(1 << bit)
                            if port == "a":
                                bus.write_byte_data(m.address_int(), MCP_IODIRA, new_iodir & 0xFF)
                            else:
                                bus.write_byte_data(m.address_int(), MCP_IODIRB, new_iodir & 0xFF)
                    except Exception:
                        # best-effort; continue even if IODIR can't be read/written
                        pass

                    if int(value) == 1:
                        new = cur | (1 << bit)
                    else:
                        new = cur & ~(1 << bit)

                    # write back to OLAT register to update outputs
                    if port == "a":
                        bus.write_byte_data(m.address_int(), MCP_OLATA, new & 0xFF)
                    else:
                        bus.write_byte_data(m.address_int(), MCP_OLATB, new & 0xFF)

                    # read back GPIO to provide updated state
                    a = bus.read_byte_data(m.address_int(), MCP_GPIOA)
                    b = bus.read_byte_data(m.address_int(), MCP_GPIOB)

                channels: Dict[str, int] = {}
                for i in range(8):
                    channels[str(i + 1)] = 1 if ((a >> i) & 1) else 0
                for i in range(8):
                    channels[str(9 + i)] = 1 if ((b >> i) & 1) else 0

                return {
                    "ok": True,
                    "comms_ok": True,
                    "module_id": m.id,
                    "type": m.type,
                    "address": m.address_hex,
                    "ports": {"gpio_a": a, "gpio_b": b},
                    "channels": channels,
                    "power": self._sense_info(None, two_lines=True),
                    "comms_led": "green",
                }

            except Exception as e:
                self._set_last_error(module_id, f"I2C write error: {e}")
                return {"ok": False, "error": f"I2C write error: {e}"}

        elif m.type == "aio":
            # AIO: ASCII command 'OUT{ch}:{voltage}'
            try:
                ch = int(channel)
            except Exception:
                return {"ok": False, "error": "invalid channel"}

            if not (1 <= ch <= 8):
                return {"ok": False, "error": "channel must be 1..8 for AIO"}

            try:
                voltage = float(value)
            except Exception:
                return {"ok": False, "error": "invalid voltage value"}

            # If running in dev/simulate mode, update the simulated AIO channels
            if self._dev_mode:
                addrk = m.address_hex.lower()
                dev = self._dev_data.get(addrk, {}) if isinstance(self._dev_data, dict) else {}
                chans = [0.0] * 8
                try:
                    existing = dev.get("channels", [])
                    for i, v in enumerate(existing[:8]):
                        chans[i] = float(v)
                except Exception:
                    pass

                try:
                    chans[ch - 1] = float(voltage)
                except Exception:
                    pass

                dev_out = {"channels": chans, "raw_response": ",".join(str(v) for v in chans)}
                self._dev_data[addrk] = dev_out
                try:
                    self._save_dev_data()
                except Exception:
                    pass

                channels: Dict[str, float] = {}
                for i in range(8):
                    channels[str(i + 1)] = chans[i]

                self._set_last_error(module_id, None)
                return {
                    "ok": True,
                    "comms_ok": True,
                    "module_id": m.id,
                    "type": m.type,
                    "address": m.address_hex,
                    "raw_response": dev_out["raw_response"],
                    "channels": channels,
                    "power": self._sense_info(None, two_lines=True),
                    "comms_led": "green",
                }

            if self.rs485:
                try:
                    counts = self._voltage_to_counts(voltage, m.id, ch)
                    # AO channels in firmware are 8..15; map UI 1..8 -> firmware 8..15
                    fw_ch = 7 + ch
                    res = self.rs485.write_aio_channel(m.address_int(), fw_ch, counts)
                    if not res.get("ok"):
                        self._set_last_error(module_id, res.get("error", "RS485 write failed"))
                        return {"ok": False, "error": res.get("error", "RS485 write failed")}
                    returned_counts = int(res.get("value12", counts))
                    self._set_last_error(module_id, None)
                    return {
                        "ok": True,
                        "comms_ok": True,
                        "module_id": m.id,
                        "type": m.type,
                        "address": m.address_hex,
                        "channel": ch,
                        "voltage": self._counts_to_voltage(returned_counts, m.id, ch, direction="out"),
                        "value12": returned_counts,
                        "sense_mask": res.get("sense_mask"),
                        "power": self._sense_info(res.get("sense_mask"), two_lines=True),
                        "comms_led": "green",
                        "raw": res.get("raw"),
                    }
                except Exception as e:
                    self._set_last_error(module_id, f"RS485 AIO write error: {e}")
                    return {"ok": False, "error": f"RS485 AIO write error: {e}"}

            if self._force_rs485:
                return {"ok": False, "error": self._last_errors.get(module_id) or "RS485 AIO write failed"}

            # Fall back to legacy placeholder if RS485 unavailable
            s = f"{voltage},{voltage},{voltage},{voltage},{voltage},{voltage},{voltage},{voltage}"
            parts = [p.strip() for p in s.split(",") if p.strip()]
            values: List[float] = []
            for p in parts:
                try:
                    values.append(float(p))
                except Exception:
                    values.append(float("nan"))

            channels: Dict[str, float] = {}
            max_ch = min(len(values), 8)
            for i in range(max_ch):
                channels[str(i + 1)] = values[i]

            return {"ok": True, "module_id": m.id, "type": m.type, "address": m.address_hex, "raw_response": s, "channels": channels}

        elif m.type == "i2c":
            return {"ok": False, "error": "I2C module write not supported over RS485 yet"}

        else:
            return {"ok": False, "error": "write not supported for this module type"}


# -----------------------------
# Simple CLI smoke test
# -----------------------------

if __name__ == "__main__":
    b = HomeControllerBackend()
    print("Config:", b.config_path)
    print("Modules:")
    for m in b.list_modules():
        print(" -", m)

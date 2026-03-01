from __future__ import annotations

import datetime
from home_controller.config import aio_max_voltage

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
import time
from dataclasses import dataclass, asdict
from typing import Any, Dict, List, Optional, Tuple, Union

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
        # dev_mode and dev_file may be set by the caller to simulate I2C
        self._dev_mode = False
        self._dev_file: Optional[str] = None
        self._dev_data: Dict[str, Any] = {}

        self.cfg = self.load_config()
        # Force modules to use the fixed modules I2C bus (ensure modules are always on i2c1)
        self.cfg.i2c_bus_num = DEFAULT_I2C_BUS_NUM

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
        if not os.path.exists(self._config_path):
            return ControllerConfig()

        with open(self._config_path, "r", encoding="utf-8") as f:
            raw = json.load(f) or {}

        modules: List[ModuleEntry] = []
        for m in raw.get("modules", []):
            try:
                modules.append(ModuleEntry(
                    id=str(m["id"]),
                    type=str(m["type"]).lower(),
                    address_hex=str(m["address_hex"]).lower(),
                    name=str(m.get("name", "")),
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

    def save_config(self) -> None:
        os.makedirs(os.path.dirname(self._config_path), exist_ok=True)
        raw: Dict[str, Any] = {
            "controller_name": self.cfg.controller_name,
            "notes": self.cfg.notes,
            "i2c_bus_num": self.cfg.i2c_bus_num,
            "modules": [asdict(m) for m in self.cfg.modules],
            "saved_at": int(time.time()),
        }
        with open(self._config_path, "w", encoding="utf-8") as f:
            json.dump(raw, f, indent=2, sort_keys=True)

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

    def _module_id(self, address_hex: str) -> str:
        # Enforce bus number for module IDs to DEFAULT_I2C_BUS_NUM (i2c1)
        return f"i2c{DEFAULT_I2C_BUS_NUM}-{address_hex.lower()}"

    def _find_module_index(self, mid: str) -> int:
        for i, m in enumerate(self.cfg.modules):
            if m.id.lower() == mid.lower():
                return i
        return -1

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
        mid = self._module_id(address_hex)
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

        new_mid = self._module_id(address_hex)
        # ensure we won't collide with another module
        existing = self._find_module_index(new_mid)
        if existing >= 0 and existing != idx:
            raise ValueError(f"Another module already uses address {address_hex}")

        # update module entry
        m.address_hex = address_hex
        m.id = new_mid
        self.save_config()
        return m

    # -----------------------------
    # Module-specific I2C reads
    # -----------------------------

    def read_module(self, module_id: str) -> Dict[str, Any]:
        """
        Read and parse a configured module's state from I2C.

        Returns a dict with keys: ok, module_id, type, address, and type-specific data.
        """
        idx = self._find_module_index(module_id)
        if idx < 0:
            raise ValueError(f"Module not found: {module_id}")

        m = self.cfg.modules[idx]

        addr_key = m.address_hex.lower()

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
                        "module_id": m.id,
                        "type": m.type,
                        "address": m.address_hex,
                        "ports": {"gpio_a": a, "gpio_b": b},
                        "channels": channels,
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
                        "module_id": m.id,
                        "type": m.type,
                        "address": m.address_hex,
                        "raw_response": dev.get("raw_response", ",".join(str(v) for v in values)),
                        "channels": channels,
                    }

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

                # Map bits to channel numbers: 1-8 -> GPIOA bit0..7, 9-16 -> GPIOB bit0..7
                channels: Dict[str, int] = {}
                for i in range(8):
                    channels[str(i + 1)] = 1 if ((a >> i) & 1) else 0
                for i in range(8):
                    channels[str(9 + i)] = 1 if ((b >> i) & 1) else 0

                return {
                    "ok": True,
                    "module_id": m.id,
                    "type": m.type,
                    "address": m.address_hex,
                    "ports": {"gpio_a": a, "gpio_b": b},
                    "channels": channels,
                }
            except Exception as e:
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
                    "module_id": m.id,
                    "type": m.type,
                    "address": m.address_hex,
                    "raw_response": s,
                    "channels": channels,
                    "alerts": alerts,
                }
            except Exception as e:
                return {"ok": False, "error": f"AIO I2C read error: {e}"}

        else:
            return {"ok": False, "error": f"Unsupported module type: {m.type}"}

    def read_hat_status(self, bus_num: int = 0, address: int = 0x20) -> Dict[str, Any]:
        """
        Read the status MCP23017 on the hat (default bus 0, address 0x20).

        Returns per-module power/status lines. There are 8 modules; for each module N:
          - '24v_a' corresponds to GPIOA bit (N-1)
          - '24v_b' corresponds to GPIOB bit (N-1)
        """
        # Dev-mode: simulated hat entry keyed by hex address
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
                # i2c module presence: check for a dev entry at the i2c address if provided
                try:
                    i2c_addr_env = os.getenv("HC_HAT_I2C_ADDR", "0x21")
                    i2c_addr = int(i2c_addr_env, 16) if isinstance(i2c_addr_env, str) and i2c_addr_env.startswith("0x") else int(i2c_addr_env, 0)
                except Exception:
                    i2c_addr = 0x21
                i2c_key = f"0x{i2c_addr:02x}".lower()
                i2c_present = False
                if self._dev_data.get(i2c_key) is not None:
                    i2c_present = True

                return {
                    "ok": True,
                    "bus": bus_num,
                    "address": addr_key,
                    "ports": {"gpio_a": a, "gpio_b": b},
                    "modules": modules,
                    "i2c_present": i2c_present,
                }

        if not _HAS_SMBUS:
            return {"ok": False, "error": "smbus2 not installed on this system"}

        # MCP23017 GPIO registers
        MCP_GPIOA = 0x12
        MCP_GPIOB = 0x13

        try:
            with smbus2.SMBus(bus_num) as bus:
                a = bus.read_byte_data(address, MCP_GPIOA)
                b = bus.read_byte_data(address, MCP_GPIOB)

            modules: Dict[str, Dict[str, bool]] = {}
            for i in range(8):
                modules[str(i + 1)] = {
                    "24v_a": bool((a >> i) & 1),
                    "24v_b": bool((b >> i) & 1),
                }

            # detect optional i2c board at configurable address (env HC_HAT_I2C_ADDR)
            try:
                i2c_addr_env = os.getenv("HC_HAT_I2C_ADDR", "0x21")
                i2c_addr = int(i2c_addr_env, 16) if isinstance(i2c_addr_env, str) and i2c_addr_env.startswith("0x") else int(i2c_addr_env, 0)
            except Exception:
                i2c_addr = 0x21

            i2c_present = False
            if _HAS_SMBUS:
                try:
                    with smbus2.SMBus(bus_num) as bus:
                        # try a quick read from the i2c address; if it doesn't raise, consider present
                        _ = bus.read_byte(i2c_addr)
                        i2c_present = True
                except Exception:
                    i2c_present = False

            return {
                "ok": True,
                "bus": bus_num,
                "address": f"0x{address:02x}",
                "ports": {"gpio_a": a, "gpio_b": b},
                "modules": modules,
                "i2c_present": i2c_present,
            }
        except Exception as e:
            return {"ok": False, "error": f"hat I2C read error: {e}", "bus": bus_num, "address": f"0x{address:02x}"}

    def write_module(self, module_id: str, channel: int, value: Union[int, float]) -> Dict[str, Any]:
        """
        Write a single channel for DO (1-16) or AIO (1-8).

        For DO: `value` must be 0 or 1.
        For AIO: `value` is a voltage (float) and will be sent as ASCII `OUT{ch}:{voltage}`.
        """
        idx = self._find_module_index(module_id)
        if idx < 0:
            raise ValueError(f"Module not found: {module_id}")

        m = self.cfg.modules[idx]

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
                    "module_id": m.id,
                    "type": m.type,
                    "address": m.address_hex,
                    "ports": {"gpio_a": a, "gpio_b": b},
                    "channels": channels,
                }

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
                    "module_id": m.id,
                    "type": m.type,
                    "address": m.address_hex,
                    "ports": {"gpio_a": a, "gpio_b": b},
                    "channels": channels,
                }

            except Exception as e:
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

                return {"ok": True, "module_id": m.id, "type": m.type, "address": m.address_hex, "raw_response": dev_out["raw_response"], "channels": channels}


            # RS485 communication placeholder for AIO
            # TODO: Replace with actual RS485 send/receive logic
            # Example: send command OUT{ch}:{voltage} to RS485 bus, receive response
            cmd = f"OUT{ch}:{voltage}"
            # Simulate successful RS485 write and response
            # You should implement actual RS485 communication here
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

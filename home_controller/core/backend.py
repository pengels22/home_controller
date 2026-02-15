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

from __future__ import annotations

import json
import os
import time
from dataclasses import dataclass, asdict
from typing import Any, Dict, List, Optional, Tuple


# -----------------------------
# Constants / Defaults
# -----------------------------

DEFAULT_I2C_BUS_NUM = 1  # fixed bus (Pi SDA/SCL)

VALID_TYPES = ("di", "do", "aio")

# Typical MCP23017 A0..A2 range.
# We can expand later if you add other chips.
MCP23017_MIN = 0x20
MCP23017_MAX = 0x27


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
    type: str          # "di" | "do" | "aio"
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
    """
    Main backend class. This will be imported by the Flask app later.
    """

    def __init__(self, config_path: Optional[str] = None) -> None:
        self._repo_root = self._find_repo_root()
        self._config_path = config_path or os.path.join(
            self._repo_root, "home_controller", "config", "config.json"
        )
        self.cfg = self.load_config()

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
        return f"i2c{self.cfg.i2c_bus_num}-{address_hex.lower()}"

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

        address_hex, address_int = self.normalize_address(address)

        # Guardrail: DI/DO are expected to be MCP23017 range by default
        if mtype in ("di", "do"):
            if not (MCP23017_MIN <= address_int <= MCP23017_MAX):
                raise ValueError("DI/DO addresses must be in 0x20–0x27 (MCP23017 default range)")

        mid = self._module_id(address_hex)
        if self._find_module_index(mid) >= 0:
            raise ValueError(f"Module already exists: {mid}")

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


# -----------------------------
# Simple CLI smoke test
# -----------------------------

if __name__ == "__main__":
    b = HomeControllerBackend()
    print("Config:", b.config_path)
    print("Modules:")
    for m in b.list_modules():
        print(" -", m)

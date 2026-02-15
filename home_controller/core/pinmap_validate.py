from __future__ import annotations

import os
from typing import Any, Dict, Tuple, List
import yaml

from .registry import get_known_modules

def _load_yaml(path: str) -> Dict[str, Any]:
    with open(path, "r", encoding="utf-8") as f:
        return yaml.safe_load(f) or {}

def _repo_root() -> str:
    # file is home_controller/core/pinmap_validate.py -> go up 2 levels
    return os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))

def _abs(path: str) -> str:
    return os.path.join(_repo_root(), path)

def _load_contract(contract_ref_from_pinmap: str, pinmap_abs_path: str) -> Dict[str, Any]:
    # contract_ref is relative to the pinmap file location
    pinmap_dir = os.path.dirname(pinmap_abs_path)
    contract_abs = os.path.abspath(os.path.join(pinmap_dir, contract_ref_from_pinmap))
    return _load_yaml(contract_abs)

def _get_pin_net(pinmap: Dict[str, Any], pin: int) -> str:
    pins = pinmap.get("pins", {}) or {}
    entry = pins.get(pin) or pins.get(str(pin)) or {}
    net = entry.get("net")
    return str(net) if net is not None else ""

def validate() -> Tuple[bool, List[str]]:
    errors: List[str] = []
    contract_cache: Dict[str, Any] = {}

    module_pinmaps: Dict[str, Dict[str, Any]] = {}

    for mod in get_known_modules():
        pm_abs = _abs(mod.pinmap_path)
        if not os.path.exists(pm_abs):
            errors.append(f"[MISSING] {mod.module_type}: {mod.pinmap_path}")
            continue
        pinmap = _load_yaml(pm_abs)
        module_pinmaps[mod.module_type] = pinmap

        cref = pinmap.get("contract_ref")
        if not cref:
            errors.append(f"[{mod.module_type}] pinmap missing contract_ref")
            continue

        key = f"{pm_abs}::{cref}"
        if key not in contract_cache:
            contract_cache[key] = _load_contract(cref, pm_abs)
        contract = contract_cache[key]

        # Contract checks
        # 1) pin 22 must be NC
        net22 = _get_pin_net(pinmap, 22).upper()
        if net22 not in ("NC", ""):
            errors.append(f"[{mod.module_type}] Pin 22 must be NC (got '{_get_pin_net(pinmap,22)}')")

        # 2) Must define all pins 1..30 (even if placeholder)
        for p in range(1, 31):
            if _get_pin_net(pinmap, p) == "":
                errors.append(f"[{mod.module_type}] Pin {p} net is missing/blank")

        # 3) Reserved pins 21..30 must match contract names in spirit (allow RESERVED_* or NC)
        # We enforce exact reserved net strings here for determinism.
        reserved_expected = {
            21: "RESERVED_21",
            22: "NC",
            23: "RESERVED_23",
            24: "RESERVED_24",
            25: "RESERVED_25",
            26: "RESERVED_26",
            27: "RESERVED_27",
            28: "RESERVED_28",
            29: "RESERVED_29",
            30: "RESERVED_30",
        }
        for p, exp in reserved_expected.items():
            got = _get_pin_net(pinmap, p).upper()
            if got != exp:
                errors.append(f"[{mod.module_type}] Pin {p} reserved mismatch: expected '{exp}', got '{_get_pin_net(pinmap,p)}'")

    # Cross-module equality checks for pins 21..30
    if module_pinmaps:
        for p in range(21, 31):
            seen: Dict[str, str] = {m: _get_pin_net(pm, p) for m, pm in module_pinmaps.items()}
            unique = set(v.upper() for v in seen.values())
            if len(unique) > 1:
                errors.append(f"[CROSS] Pin {p} differs across modules: " + ", ".join([f"{k}='{v}'" for k,v in seen.items()]))

    ok = (len(errors) == 0)
    return ok, errors

def diff_io_pins() -> str:
    # Show nets for pins 5..20 for each module, side-by-side (no tables needed, just readable text)
    module_pinmaps: Dict[str, Dict[str, Any]] = {}
    for mod in get_known_modules():
        pm_abs = _abs(mod.pinmap_path)
        if os.path.exists(pm_abs):
            module_pinmaps[mod.module_type] = _load_yaml(pm_abs)

    lines: List[str] = []
    lines.append("IO pin diff (pins 5–20):")
    for p in range(5, 21):
        parts = []
        for m in ("aio", "di", "do"):
            pm = module_pinmaps.get(m, {})
            parts.append(f"{m}:{_get_pin_net(pm,p)}")
        lines.append(f"  Pin {p:>2}: " + " | ".join(parts))
    return "\n".join(lines)

if __name__ == "__main__":
    ok, errs = validate()
    print(diff_io_pins())
    print("")
    if ok:
        print("PASS: pinmaps conform to contract.")
    else:
        print("FAIL:")
        for e in errs:
            print(" - " + e)
        raise SystemExit(1)

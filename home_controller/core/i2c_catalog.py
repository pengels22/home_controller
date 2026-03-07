"""
Canonical list of supported I2C sensors for the RS485 I2C module.

Edit `home_controller/i2c_sensors.csv` to add/remove sensors; both the
server UI and backend helpers load from that single source of truth.
"""

from __future__ import annotations

import csv
from pathlib import Path
from typing import Dict, List

BASE_DIR = Path(__file__).resolve().parents[1]
CATALOG_CSV = BASE_DIR / "i2c_sensors.csv"


def load_catalog() -> List[Dict[str, str]]:
    items: List[Dict[str, str]] = []
    if not CATALOG_CSV.exists():
        return items
    with open(CATALOG_CSV, "r", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        for row in reader:
            # normalize keys
            row = {k.strip(): (v.strip() if isinstance(v, str) else v) for k, v in row.items()}
            items.append(row)
    return items


def id_to_name_map() -> Dict[int, str]:
    out: Dict[int, str] = {}
    for row in load_catalog():
        try:
            sid = int(str(row.get("id", "0")).strip(), 0)
        except Exception:
            continue
        name = row.get("name") or f"0x{sid:02x}"
        out[sid] = name
    return out


def id_to_default_addr_map() -> Dict[int, str]:
    out: Dict[int, str] = {}
    for row in load_catalog():
        try:
            sid = int(str(row.get("id", "0")).strip(), 0)
        except Exception:
            continue
        addr = row.get("default_address") or ""
        out[sid] = addr
    return out

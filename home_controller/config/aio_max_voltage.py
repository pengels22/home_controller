import os
import json
from typing import Dict, Any

DEFAULT_MAX_V = 24.0  # volts, applied to all channels by default
CHANNELS = [str(i) for i in range(1, 9)]


def get_aio_config_path(module_id: str) -> str:
    base = os.path.dirname(__file__)
    return os.path.join(base, f"AIO_{module_id}.json")


def _with_defaults(data: Dict[str, Any]) -> Dict[str, Any]:
    data = data if isinstance(data, dict) else {}
    for key in ("in", "out"):
        section = data.get(key) if isinstance(data.get(key), dict) else {}
        for ch in CHANNELS:
            try:
                v = float(section.get(ch, DEFAULT_MAX_V))
            except Exception:
                v = DEFAULT_MAX_V
            section[ch] = v
        data[key] = section
    return data


def load_aio_max_voltage(module_id: str) -> Dict[str, Any]:
    path = get_aio_config_path(module_id)
    if not os.path.exists(path):
        return _with_defaults({"in": {}, "out": {}})
    try:
        with open(path, "r", encoding="utf-8") as f:
            raw = json.load(f)
        return _with_defaults(raw)
    except Exception:
        return _with_defaults({"in": {}, "out": {}})


def save_aio_max_voltage(module_id: str, data: Dict[str, Any]):
    data = _with_defaults(data)
    path = get_aio_config_path(module_id)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)

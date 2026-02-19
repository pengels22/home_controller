import os
import json
from typing import Dict, Any

def get_aio_config_path(i2c_addr: str) -> str:
    base = os.path.dirname(__file__)
    return os.path.join(base, f"AIO_{i2c_addr}.json")

def load_aio_max_voltage(i2c_addr: str) -> Dict[str, Any]:
    path = get_aio_config_path(i2c_addr)
    if not os.path.exists(path):
        return {"in": {}, "out": {}}
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)

def save_aio_max_voltage(i2c_addr: str, data: Dict[str, Any]):
    path = get_aio_config_path(i2c_addr)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)

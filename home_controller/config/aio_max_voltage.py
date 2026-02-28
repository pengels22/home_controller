import os
import json
from typing import Dict, Any

def get_aio_config_path(module_id: str) -> str:
    base = os.path.dirname(__file__)
    return os.path.join(base, f"AIO_{module_id}.json")

def load_aio_max_voltage(module_id: str) -> Dict[str, Any]:
    path = get_aio_config_path(module_id)
    if not os.path.exists(path):
        return {"in": {}, "out": {}}
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)

def save_aio_max_voltage(module_id: str, data: Dict[str, Any]):
    path = get_aio_config_path(module_id)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)

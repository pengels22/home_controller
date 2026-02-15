from __future__ import annotations
import json
import os
from typing import Any, Dict

def repo_root() -> str:
    return os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))

def config_path() -> str:
    return os.path.join(repo_root(), "home_controller", "config", "config.json")

def load_config() -> Dict[str, Any]:
    path = config_path()
    if not os.path.exists(path):
        return {"controller_name": "Home Controller", "notes": ""}
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)

def save_config(cfg: Dict[str, Any]) -> None:
    path = config_path()
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(cfg, f, indent=2, sort_keys=True)

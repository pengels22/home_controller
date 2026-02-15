from dataclasses import dataclass
from typing import Dict, List

@dataclass(frozen=True)
class ModuleInfo:
    module_type: str   # "aio" | "di" | "do"
    pinmap_path: str

def get_known_modules() -> List[ModuleInfo]:
    return [
        ModuleInfo("aio", "home_controller/modules/aio/pinmap.yaml"),
        ModuleInfo("di",  "home_controller/modules/di/pinmap.yaml"),
        ModuleInfo("do",  "home_controller/modules/do/pinmap.yaml"),
    ]

def as_dict() -> Dict[str, str]:
    return {m.module_type: m.pinmap_path for m in get_known_modules()}

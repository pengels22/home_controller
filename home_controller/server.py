#!/usr/bin/env python3
from __future__ import annotations

import os
import json
from pathlib import Path

from flask import (
    Flask,
    jsonify,
    request,
    render_template,
    send_from_directory,
    abort,
)

from home_controller.core.backend import HomeControllerBackend

# ------------------------------------------------------------
# Paths (absolute, based on this file)
# ------------------------------------------------------------
BASE_DIR = Path(__file__).resolve().parent  # .../home_controller/
TEMPLATES_DIR = BASE_DIR / "templates"
STATIC_DIR = BASE_DIR / "static"

# UI labels storage (module + channel naming)
LABELS_DIR = BASE_DIR / "config"
LABELS_FILE = LABELS_DIR / "ui_labels.json"


def _load_labels() -> dict:
    try:
        if not LABELS_FILE.exists():
            return {}
        with open(LABELS_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def _save_labels(data: dict) -> None:
    LABELS_DIR.mkdir(parents=True, exist_ok=True)
    tmp = LABELS_FILE.with_suffix(".tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, sort_keys=True)
    tmp.replace(LABELS_FILE)


# ------------------------------------------------------------
# Flask app
# ------------------------------------------------------------
app = Flask(
    __name__,
    template_folder=str(TEMPLATES_DIR),
    static_folder=str(STATIC_DIR),
)

backend = HomeControllerBackend()


# ------------------------------------------------------------
# Health check (API)
# ------------------------------------------------------------
@app.get("/")
def root():
    return jsonify(
        {
            "service": "home_controller",
            "status": "running",
            "controller_name": backend.cfg.controller_name,
            "modules": len(backend.list_modules()),
        }
    )


# ------------------------------------------------------------
# UI pages
# ------------------------------------------------------------
@app.get("/ui")
def ui_index():
    return render_template("index.html")


@app.get("/ui/add")
def ui_add():
    return render_template("add_module.html")


# ------------------------------------------------------------
# Modules API
# ------------------------------------------------------------
@app.get("/modules")
def modules_list():
    return jsonify(
        [
            {
                "id": m.id,
                "type": m.type,
                "address": m.address_hex,
                "name": m.name,
            }
            for m in backend.list_modules()
        ]
    )


@app.post("/modules/add")
def modules_add():
    data = request.get_json(force=True, silent=True) or {}
    try:
        m = backend.add_module(
            mtype=str(data.get("type", "")),
            address=str(data.get("address", "")),
            name=str(data.get("name", "")),
        )
        return jsonify(
            {
                "ok": True,
                "module": {
                    "id": m.id,
                    "type": m.type,
                    "address": m.address_hex,
                    "name": m.name,
                },
            }
        )
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 400


@app.post("/modules/remove")
def modules_remove():
    data = request.get_json(force=True, silent=True) or {}
    try:
        mid = str(data.get("id", ""))
        backend.remove_module(mid)

        # also remove any stored labels for this module
        labels = _load_labels()
        if mid in labels:
            labels.pop(mid, None)
            _save_labels(labels)

        return jsonify({"ok": True})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 400


@app.post("/modules/rename")
def modules_rename():
    data = request.get_json(force=True, silent=True) or {}
    try:
        backend.rename_module(
            module_id=str(data.get("id", "")),
            new_name=str(data.get("name", "")),
        )
        return jsonify({"ok": True})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 400


# ------------------------------------------------------------
# Labels API (module + channel naming for reports)
# Stores per-module:
#  {
#    "<module_id>": {
#      "module_name": "Optional override",
#      "channels": { "1": "Door", "2": "Window", ... }
#    }
#  }
# ------------------------------------------------------------
@app.get("/labels/<module_id>")
def labels_get(module_id: str):
    labels = _load_labels()
    return jsonify({"ok": True, "module_id": module_id, "labels": labels.get(module_id, {})})


@app.post("/labels/set")
def labels_set():
    data = request.get_json(force=True, silent=True) or {}
    module_id = str(data.get("module_id", "")).strip()
    if not module_id:
        return jsonify({"ok": False, "error": "module_id required"}), 400

    module_name = str(data.get("module_name", "")).strip()
    channels = data.get("channels", {})

    # normalize channels to {"1":"name",...} only (strings)
    ch_out: dict[str, str] = {}
    if isinstance(channels, dict):
        for k, v in channels.items():
            ks = str(k).strip()
            vs = str(v).strip()
            if ks.isdigit():
                # allow blank names (store as "")
                ch_out[ks] = vs

    labels = _load_labels()
    labels[module_id] = {
        "module_name": module_name,
        "channels": ch_out,
    }
    _save_labels(labels)

    return jsonify({"ok": True})


# ------------------------------------------------------------
# Serve module SVGs from /home_controller/modules/<type>/*.svg
# Expected:
#   home_controller/modules/di/DI.svg
#   home_controller/modules/do/DO.svg
#   home_controller/modules/aio/AIO.svg
# ------------------------------------------------------------
@app.get("/modules/svg/<module_type>")
def module_svg(module_type: str):
    module_type = (module_type or "").strip().lower()

    svg_map = {
        "di": ("di", "DI.svg"),
        "do": ("do", "DO.svg"),
        "aio": ("aio", "AIO.svg"),
    }

    if module_type not in svg_map:
        abort(404)

    folder, filename = svg_map[module_type]
    svg_dir = BASE_DIR / "modules" / folder

    if not (svg_dir / filename).exists():
        abort(404)

    return send_from_directory(str(svg_dir), filename, mimetype="image/svg+xml")


# ------------------------------------------------------------
# Run
# ------------------------------------------------------------
if __name__ == "__main__":
    host = os.getenv("HC_HOST", "0.0.0.0")
    port = int(os.getenv("HC_PORT", "8080"))
    print(f"Home Controller running on http://{host}:{port}")
    app.run(host=host, port=port, debug=True)

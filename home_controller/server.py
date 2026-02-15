#!/usr/bin/env python3
"""
home_controller/server.py

Minimal Flask wrapper around the HomeControllerBackend.

This exposes a very small API so we can confirm:
- backend loads correctly
- config file is written
- modules can be added/removed
- future GUI will talk to this layer
"""

from __future__ import annotations

from flask import Flask, jsonify, request
from home_controller.core.backend import HomeControllerBackend

app = Flask(
    __name__,
    template_folder="templates",
    static_folder="static"
)
backend = HomeControllerBackend()


# -------------------------
# Health check
# -------------------------

@app.get("/")
def root():
    return jsonify({
        "service": "home_controller",
        "status": "running",
        "controller_name": backend.cfg.controller_name,
        "modules": len(backend.list_modules())
    })


# -------------------------
# List modules
# -------------------------

@app.get("/modules")
def modules_list():
    return jsonify([
        {
            "id": m.id,
            "type": m.type,
            "address": m.address_hex,
            "name": m.name,
        }
        for m in backend.list_modules()
    ])


# -------------------------
# Add module (manual)
# -------------------------

@app.post("/modules/add")
def modules_add():
    data = request.get_json(force=True)

    try:
        m = backend.add_module(
            mtype=data.get("type", ""),
            address=data.get("address", ""),
            name=data.get("name", ""),
        )
        return jsonify({
            "ok": True,
            "module": {
                "id": m.id,
                "type": m.type,
                "address": m.address_hex,
                "name": m.name,
            }
        })
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 400


# -------------------------
# Remove module
# -------------------------

@app.post("/modules/remove")
def modules_remove():
    data = request.get_json(force=True)
    try:
        backend.remove_module(data.get("id", ""))
        return jsonify({"ok": True})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 400


# -------------------------
# Rename module
# -------------------------

@app.post("/modules/rename")
def modules_rename():
    data = request.get_json(force=True)
    try:
        backend.rename_module(
            module_id=data.get("id", ""),
            new_name=data.get("name", ""),
        )
        return jsonify({"ok": True})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 400


# -------------------------
# Run server
# -------------------------

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=8080, debug=True)


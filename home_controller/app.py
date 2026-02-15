from __future__ import annotations

from flask import Flask, render_template, request, redirect
import yaml

from .core.registry import get_known_modules
from .core.storage import load_config, save_config, config_path
from .core.pinmap_validate import validate

def create_app():
    app = Flask(
        __name__,
        template_folder="web/templates",
        static_folder="web/static",
    )

    @app.get("/")
    def dashboard():
        ok, errs = validate()
        status = "OK" if ok else f"Errors: {len(errs)}"
        validator = "PASS" if ok else "FAIL (see terminal via pinmap_validate)"
        return render_template("dashboard.html", title="Dashboard", status=status, validator=validator)

    @app.get("/modules")
    def modules():
        return render_template("modules.html", title="Modules", modules=get_known_modules())

    @app.get("/modules/<module_type>")
    def module_detail(module_type: str):
        mods = {m.module_type: m for m in get_known_modules()}
        if module_type not in mods:
            return ("Not found", 404)

        pinmap_path = mods[module_type].pinmap_path
        with open(pinmap_path, "r", encoding="utf-8") as f:
            pinmap = yaml.safe_load(f) or {}

        pins = pinmap.get("pins", {}) or {}
        lines = []
        for p in range(1, 31):
            entry = pins.get(p) or pins.get(str(p)) or {}
            net = entry.get("net", "")
            lines.append(f"Pin {p:>2}: {net}")
        pin_lines = "\n".join(lines)

        return render_template(
            "module_detail.html",
            title=f"Module {module_type.upper()}",
            module_type=module_type,
            pinmap_path=pinmap_path,
            pinmap=pinmap,
            pin_lines=pin_lines,
        )

    @app.get("/config")
    def config_get():
        cfg = load_config()
        return render_template("config.html", title="Config", cfg=cfg, cfg_path=config_path())

    @app.post("/config")
    def config_post():
        cfg = load_config()
        cfg["controller_name"] = request.form.get("controller_name", cfg.get("controller_name", "Home Controller"))
        cfg["notes"] = request.form.get("notes", cfg.get("notes", ""))
        save_config(cfg)
        return redirect("/config")

    return app

if __name__ == "__main__":
    create_app().run(host="0.0.0.0", port=5000, debug=True)

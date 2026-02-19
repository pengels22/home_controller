#!/usr/bin/env python3
from __future__ import annotations

import os
import json
from pathlib import Path
import socket
import subprocess
import time
from typing import Set, Tuple, Optional

from flask import (
    Flask,
    jsonify,
    request,
    render_template,
    send_from_directory,
    abort,
)
import traceback


from home_controller.core.backend import HomeControllerBackend
# ------------------------------------------------------------
# AIO max voltage config API (moved to bottom)
# ------------------------------------------------------------
from home_controller.config import aio_max_voltage



def _parse_i2c_address(addr_str: str) -> int:
    """
    Accepts '0x20', '20', '32' etc.
    If it includes 0x -> hex.
    If it is all hex digits -> treat as hex (common for i2c).
    If it is decimal digits only -> decimal.
    """
    s = (addr_str or "").strip().lower()
    if not s:
        raise ValueError("address is empty")

    if s.startswith("0x"):
        v = int(s, 16)
    elif all(c in "0123456789abcdef" for c in s) and any(c in "abcdef" for c in s):
        # has hex letters => hex
        v = int(s, 16)
    elif all(c in "0123456789abcdef" for c in s) and len(s) <= 2:
        # ambiguous "20" — in I2C land people usually mean hex
        v = int(s, 16)
    else:
        # decimal
        v = int(s, 10)

    if v < 0x03 or v > 0x77:
        raise ValueError(f"address out of 7-bit range: {hex(v)}")
    return v


def _scan_i2c_addresses(bus: int, cache_seconds: float = 1.5) -> Tuple[Set[int], Optional[str]]:
    """
    Returns (set_of_detected_addresses, error_string_or_None)

    Uses `i2cdetect -y <bus>` if available.
    Caches results briefly to avoid hammering the bus.
    """
    global _I2C_CACHE

    now = time.time()
    last_ts, last_addrs, last_err = _I2C_CACHE
    if (now - last_ts) < cache_seconds:
        return set(last_addrs), last_err

    # Ensure device exists (Linux i2c-dev)
    devnode = f"/dev/i2c-{bus}"
    if not Path(devnode).exists():
        err = f"{devnode} not found (enable I2C + i2c-dev on this system)"
        _I2C_CACHE = (now, set(), err)
        return set(), err

    try:
        # i2cdetect output is the most compatible / least dependency approach
        r = subprocess.run(
            ["i2cdetect", "-y", str(bus)],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            timeout=2.5,
        )
        if r.returncode != 0:
            err = (r.stderr or r.stdout or "").strip() or "i2cdetect failed"
            _I2C_CACHE = (now, set(), err)
            return set(), err

        addrs: Set[int] = set()
        for line in (r.stdout or "").splitlines():
            line = line.strip()
            # rows look like: "20: -- -- 22 -- -- -- -- --"
            if len(line) < 3 or ":" not in line:
                continue
            prefix, rest = line.split(":", 1)
            prefix = prefix.strip()
            if len(prefix) != 2:
                continue

            tokens = rest.strip().split()
            for t in tokens:
                tt = t.strip().lower()
                if tt in ("--", "uu"):
                    continue
                # actual addresses appear as two hex digits (e.g. '20', '3c')
                if len(tt) == 2 and all(c in "0123456789abcdef" for c in tt):
                    addrs.add(int(tt, 16))

        _I2C_CACHE = (now, set(addrs), None)
        return addrs, None

    except FileNotFoundError:
        err = "i2cdetect not installed (install `i2c-tools`)"
        _I2C_CACHE = (now, set(), err)
        return set(), err
    except Exception as e:
        err = f"i2c scan error: {e}"
        _I2C_CACHE = (now, set(), err)
        return set(), err


def get_lan_ip() -> str:
    """
    Best-effort LAN IP detection.
    This uses a UDP "connect" trick (no packets required) to learn the outbound interface IP.
    Falls back to hostname lookup.
    """
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        try:
            return socket.gethostbyname(socket.gethostname())
        except Exception:
            return "0.0.0.0"


def internet_ok_tcp() -> bool:
    """
    More reliable than ping permissions:
    try a TCP connect to 8.8.8.8:53 (DNS).
    """
    try:
        with socket.create_connection(("8.8.8.8", 53), timeout=1.5):
            return True
    except Exception:
        return False


# ------------------------------------------------------------
# Health check (API)
# ------------------------------------------------------------

@app.get("/api/aio_max_voltage/<module_id>")
def api_get_aio_max_voltage(module_id: str):
    # Find module by id and get its I2C address
    idx = backend._find_module_index(module_id)
    if idx < 0:
        return jsonify({"ok": False, "error": "module not found"}), 404
    m = backend.cfg.modules[idx]
    if m.type != "aio":
        return jsonify({"ok": False, "error": "not an AIO module"}), 400
    data = aio_max_voltage.load_aio_max_voltage(m.address_hex)
    return jsonify({"ok": True, "data": data})

@app.post("/api/aio_max_voltage/<module_id>")
def api_set_aio_max_voltage(module_id: str):
    idx = backend._find_module_index(module_id)
    if idx < 0:
        return jsonify({"ok": False, "error": "module not found"}), 404
    m = backend.cfg.modules[idx]
    if m.type != "aio":
        return jsonify({"ok": False, "error": "not an AIO module"}), 400
    data = request.get_json(force=True, silent=True) or {}
    # Expect {"in": {...}, "out": {...}}
    if not ("in" in data and "out" in data):
        return jsonify({"ok": False, "error": "missing in/out blocks"}), 400
    aio_max_voltage.save_aio_max_voltage(m.address_hex, data)
    return jsonify({"ok": True})
#!/usr/bin/env python3
from __future__ import annotations

import os
import json
from pathlib import Path
import socket
import subprocess
import time
from typing import Set, Tuple, Optional

from flask import (
    Flask,
    jsonify,
    request,
    render_template,
    send_from_directory,
    abort,
)
import traceback

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

# I2C bus to scan (Pi default is usually 1)
I2C_BUS = int(os.getenv("HC_I2C_BUS", "1"))

# Small cache so we don't run i2cdetect constantly
_I2C_CACHE: Tuple[float, Set[int], Optional[str]] = (0.0, set(), None)  # (ts, addrs, err)


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

import sys

# Backend instance. Support developer simulation mode via `-dev` flag or env var.
args = [a.lower() for a in sys.argv[1:]]
DEV_MODE = any(a in ("-dev", "--dev", "dev") for a in args) or os.getenv("HC_DEV", "0").lower() in ("1", "true", "yes")
backend = HomeControllerBackend()
if DEV_MODE:
    dev_file = os.getenv("HC_DEV_FILE", None)
    backend.enable_dev_mode(dev_file)
    print(f"DEV MODE enabled; dev file={backend._dev_file}")


# ------------------------------------------------------------
# Helpers
# ------------------------------------------------------------
@app.after_request
def _no_cache_for_api(resp):
    # Prevent stale head/IP/network/I2C status in the browser
    if request.path.startswith("/api/") or request.path == "/":
        resp.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
        resp.headers["Pragma"] = "no-cache"
        resp.headers["Expires"] = "0"
    return resp

@app.get("/")
def root():
    # Serve the main UI by default
    try:
        return render_template("index.html")
    except Exception:
        # fallback to JSON health if template rendering fails
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
# I2C scan API
# ------------------------------------------------------------
@app.get("/api/i2c_scan")
def api_i2c_scan():
    addrs, err = _scan_i2c_addresses(I2C_BUS)
    return jsonify(
        {
            "ok": err is None,
            "bus": I2C_BUS,
            "addresses": [f"0x{a:02x}" for a in sorted(addrs)],
            "error": err,
            "ts": int(time.time()),
        }
    )


# ------------------------------------------------------------
# Modules API
# ------------------------------------------------------------
@app.get("/modules")
def modules_list():
    addrs, _err = _scan_i2c_addresses(I2C_BUS)
    present_hex = {f"0x{a:02x}" for a in addrs}

    out = []
    for m in backend.list_modules():
        # m.address_hex assumed like "0x20"
        addr_hex = str(m.address_hex).lower().strip()
        out.append(
            {
                "id": m.id,
                "type": m.type,
                "address": addr_hex,
                "name": m.name,
                "present": addr_hex in present_hex,
            }
        )
    return jsonify(out)


@app.post("/modules/add")
def modules_add():
    data = request.get_json(force=True, silent=True) or {}
    try:
        # Address validation: confirm it exists on the bus
        addr_str = str(data.get("address", "")).strip()
        addr_val = _parse_i2c_address(addr_str)
        addr_hex = f"0x{addr_val:02x}"

        # Allow bypass for bench/testing if user really wants it
        skip_check = bool(data.get("skip_i2c_check", False))

        if not skip_check:
            addrs, err = _scan_i2c_addresses(I2C_BUS)
            if err is not None:
                return jsonify({"ok": False, "error": f"I2C scan failed: {err}"}), 400
            if addr_val not in addrs:
                return jsonify(
                    {
                        "ok": False,
                        "error": f"Address {addr_hex} not found on I2C bus {I2C_BUS}",
                        "bus": I2C_BUS,
                        "seen": [f"0x{a:02x}" for a in sorted(addrs)],
                    }
                ), 400

        m = backend.add_module(
            mtype=str(data.get("type", "")),
            address=addr_hex,  # normalize to 0xNN
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

        labels = _load_labels()
        if mid in labels:
            labels.pop(mid, None)
            _save_labels(labels)

        return jsonify({"ok": True})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 400


@app.post("/modules/change_address")
def modules_change_address():
    data = request.get_json(force=True, silent=True) or {}
    try:
        mid = str(data.get("id", "")).strip()
        new_addr = str(data.get("address", "")).strip()
        if not mid:
            return jsonify({"ok": False, "error": "module id required"}), 400
        if not new_addr:
            return jsonify({"ok": False, "error": "address required"}), 400

        # perform the address change in backend
        try:
            updated = backend.change_module_address(mid, new_addr)
        except Exception as e:
            return jsonify({"ok": False, "error": str(e)}), 400

        # move any saved labels for the module to the new id
        try:
            labels = _load_labels()
            if mid in labels:
                labels[updated.id] = labels.pop(mid)
                _save_labels(labels)
        except Exception:
            pass

        return jsonify({"ok": True, "module": {"id": updated.id, "address": updated.address_hex, "type": updated.type}})
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
# Labels API
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

    ch_out: dict[str, str] = {}
    if isinstance(channels, dict):
        for k, v in channels.items():
            ks = str(k).strip()
            vs = str(v).strip()
            if ks.isdigit():
                ch_out[ks] = vs

    labels = _load_labels()
    labels[module_id] = {
        "module_name": module_name,
        "channels": ch_out,
    }
    _save_labels(labels)

    return jsonify({"ok": True})


# ------------------------------------------------------------
# Serve module SVGs
# ------------------------------------------------------------
@app.get("/modules/svg/<module_type>")
def module_svg(module_type: str):
    module_type = (module_type or "").strip().lower()

    svg_map = {
        "di": ("di", "DI.svg"),
        "do": ("do", "DO.svg"),
        "aio": ("aio", "AIO.svg"),
        "head": ("head", "HEAD.svg"),  # optional if you want server-served HEAD.svg later
        "i2c": ("i2c", "I2C_EXPANDER.svg"),
        # Support alternate names for the expander SVG
        "i2c_expander": ("i2c", "I2C_EXPANDER.svg"),
        "ext": ("i2c", "I2C_EXPANDER.svg"),
    }

    if module_type not in svg_map:
        abort(404)

    folder, filename = svg_map[module_type]
    svg_dir = BASE_DIR / "modules" / folder

    if not (svg_dir / filename).exists():
        abort(404)

    return send_from_directory(str(svg_dir), filename, mimetype="image/svg+xml")


# ------------------------------------------------------------
# Head module status endpoint
# ------------------------------------------------------------
@app.get("/api/head_status")
def head_status():
    ip = get_lan_ip()
    online = internet_ok_tcp()

    return jsonify(
        {
            "server_running": True,
            "internet_ok": bool(online),
            "ip": ip,
            "ts": int(time.time()),
        }
    )


# ------------------------------------------------------------
# GUI helpers API
# ------------------------------------------------------------
@app.get("/api/gui/modules")
def api_gui_modules():
    """Return ordered modules for GUI: head (if any) then slots 1..N.

    Each entry includes slot number, id, type, name, address, present,
    and channel counts for in/out so the UI can build controls.
    """
    mods = backend.list_modules()
    # prefer head first if present
    head = [m for m in mods if m.type == "head"]
    others = [m for m in mods if m.type != "head"]
    ordered = head + others

    addrs, _err = _scan_i2c_addresses(I2C_BUS)
    present = {f"0x{a:02x}" for a in addrs}
    # If running in dev mode, treat addresses found in dev data as present too
    try:
        if backend._dev_mode:
            dev_addrs = {str(k).lower() for k in backend._dev_data.keys()}
            present = present.union(dev_addrs)
    except Exception:
        pass

    out = []
    for i, m in enumerate(ordered, start=1):
        mtype = m.type
        if mtype == "di":
            ch_in = 16
            ch_out = 0
        elif mtype == "do":
            ch_in = 0
            ch_out = 16
        elif mtype == "aio":
            ch_in = 8
            ch_out = 8
        else:
            ch_in = 0
            ch_out = 0

        out.append(
            {
                "slot": i,
                "id": m.id,
                "type": mtype,
                "name": m.name,
                "address": m.address_hex,
                "present": m.address_hex.lower() in present,
                "channels_in": ch_in,
                "channels_out": ch_out,
            }
        )

    return jsonify(out)


@app.post("/api/gui/action")
def api_gui_action():
    """Perform a GUI action: read or write a module channel.

    Payload: { module_id, action: "read"|"write", channel: int, value }
    """
    data = request.get_json(force=True, silent=True) or {}
    module_id = str(data.get("module_id", "")).strip()
    action = str(data.get("action", "read")).strip().lower()

    if not module_id:
        return jsonify({"ok": False, "error": "module_id required"}), 400

    if action == "read":
        try:
            res = backend.read_module(module_id)
            return jsonify(res)
        except Exception as e:
            tb = traceback.format_exc()
            print(tb)
            return jsonify({"ok": False, "error": str(e), "trace": tb}), 400

    elif action == "write":
        try:
            channel = int(data.get("channel", -1))
        except Exception:
            return jsonify({"ok": False, "error": "invalid channel"}), 400

        value = data.get("value")
        try:
            res = backend.write_module(module_id=module_id, channel=channel, value=value)
            return jsonify(res)
        except Exception as e:
            tb = traceback.format_exc()
            print(tb)
            return jsonify({"ok": False, "error": str(e), "trace": tb}), 400

    else:
        return jsonify({"ok": False, "error": "unknown action"}), 400


# ------------------------------------------------------------
# Simple GUI page
# ------------------------------------------------------------
@app.get("/ui/gui")
def ui_gui():
    return render_template("gui_panel.html")



# ------------------------------------------------------------
# Hat MCP23017 status (i2c0)
# ------------------------------------------------------------
@app.get("/api/hat_status")
def api_hat_status():
    # default address: 0x20 (A0..A2 pulled to GND)
    try:
        addr_env = os.getenv("HC_HAT_ADDR", "0x20")
        if isinstance(addr_env, str) and addr_env.startswith("0x"):
            addr = int(addr_env, 16)
        else:
            addr = int(addr_env, 0)
    except Exception:
        addr = 0x20

    try:
        res = backend.read_hat_status(bus_num=0, address=addr)
        return jsonify(res)
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


# ------------------------------------------------------------
# Module read endpoint (module-specific parsing)
# ------------------------------------------------------------
@app.get("/api/module_read/<module_id>")
def api_module_read(module_id: str):
    try:
        res = backend.read_module(module_id)
        return jsonify(res)
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 400


@app.post("/api/module_write")
def api_module_write():
    data = request.get_json(force=True, silent=True) or {}
    module_id = str(data.get("module_id", "")).strip()
    if not module_id:
        return jsonify({"ok": False, "error": "module_id required"}), 400

    # Individual channel write: { module_id, channel: 1-16 (or 1-8 for AIO), value }
    try:
        channel = int(data.get("channel", -1))
    except Exception:
        channel = -1

    # determine module type
    idx = backend._find_module_index(module_id)
    if idx < 0:
        return jsonify({"ok": False, "error": "module not found"}), 400
    mtype = backend.cfg.modules[idx].type

    # parse value based on module type
    if mtype == "do":
        try:
            value = int(data.get("value", -1))
        except Exception:
            value = -1
        if not (1 <= channel <= 16) or value not in (0, 1):
            return jsonify({"ok": False, "error": "invalid channel or value for DO"}), 400

    elif mtype == "aio":
        try:
            # allow numeric or string float
            value = float(data.get("value", "nan"))
        except Exception:
            return jsonify({"ok": False, "error": "invalid voltage value for AIO"}), 400
        if not (1 <= channel <= 8):
            return jsonify({"ok": False, "error": "invalid channel for AIO"}), 400

    else:
        return jsonify({"ok": False, "error": "module type does not support writes"}), 400

    try:
        res = backend.write_module(module_id=module_id, channel=channel, value=value)
        return jsonify(res)
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 400


# ------------------------------------------------------------
# Run
# ------------------------------------------------------------
if __name__ == "__main__":
    host = os.getenv("HC_HOST", "0.0.0.0")
    port = int(os.getenv("HC_PORT", "8080"))
    debug = os.getenv("HC_DEBUG", "0").lower() in ("1", "true", "yes", "on")

    print(f"Home Controller running on http://{host}:{port}")
    app.run(host=host, port=port, debug=debug)

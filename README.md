# Home Controller

Python/Flask application and RS485 backend for monitoring and controlling Home Controller modules (DI/DO/AIO, RS485-to-I2C bridge, Generator).

## Features
- REST-ish API and lightweight web UI for module add/read/write and configuration.
- RS485-first design (direct I2C access is disabled in code; only the RS485 bridge path is used).
- Per-module configs and labels persisted under `config/`.
- Dev/simulation mode for offline testing.
- Reference firmware sources for RP2040-based modules in `core/module_firmware/*.ino`.

## Project layout
- `server.py` – Flask app and routes.
- `core/backend.py` – high-level module logic (RS485, dev-mode, config I/O).
- `core/backend_core.py` – low-level RS485 framing helpers.
- `Generator Pi/generator_backend.py` – RS485 generator helper intended for the Generator Pi (replaces the old GenMon TCP helper). Head communicates to generator via the RS485 trunk, not HTTP.
- `core/i2c_catalog.py` + `i2c_sensors.csv` – I2C sensor metadata (used by the RS485-to-I2C bridge UI).
- `config/` – runtime configuration:
  - `config.json` main controller/modules list.
  - `i2c_module_ch_config.json` (formerly expansion_config) reserved for legacy expander data.
  - `ui_labels.json` channel/module labels.
  - `dev_i2c.json` dev-mode simulated data.
  - `aio_max_voltage.py` AIO scaling helpers.
- `web/static`, `web/templates` – front-end assets.
- `modules/` – SVGs for module artwork.
- `hardware/schematics/` – PDFs for each board:
  - `Head Module.pdf`
  - `DI Module.pdf`
  - `DO Module.pdf`
  - `AIO Module.pdf`
  - `485 Module.pdf`
  - `i2c Module.pdf`
  - `Generator Module.pdf`
  - `GREM Module.pdf`

## Requirements
Python 3.10+ recommended. Install Python deps:

```bash
pip install -r requirements.txt
```

System tools (only if you ever re-enable direct I2C access):
- `i2c-tools` for `i2cdetect`
- Linux i2c-dev kernel support

## Running
From the directory **above** this package:

```bash
python -m home_controller.server
```

Environment options:
- `HC_HOST` (default `0.0.0.0`)
- `HC_PORT` (default `8080`)
- `HC_DEBUG=1` to enable Flask debug
- `HC_RS485_ENABLE` (default `1`) – keep enabled; I2C fallback is disabled in code.
- `HC_DEV=1` and optional `HC_DEV_FILE=/path/to/dev_i2c.json` to enable simulation mode.
- (GenMon TCP helper removed; generator control is RS485-only now.)

## Notable API routes
- `/api/module_read/<module_id>` – read a module via RS485.
- `/api/module_write` – write DO/AIO (`POST {module_id, channel, value}`).
- `/api/expansion_config` – get/set expander config.
- `/api/aio_max_voltage/<module_id>` – get/set per-channel max voltages.
- `/api/hat_status` – power/sense summary derived from module RS485 responses.
- `/api/genmon/<id>/status` and `/api/genmon/<id>/contacts` – generator status/contacts via RS485 trunk to Generator Pi.
- `/ui` – main web UI.
- `/ui/add` – add module page.
- `/ui/gui` – simplified GUI panel.

## Dev mode (simulation)
```
export HC_DEV=1
python -m home_controller.server
```
The server will read/write simulated data in `config/dev_i2c.json`.

## Firmware
Reference RP2040 sketches live in `core/module_firmware/`:
- `DI_core.ino`, `DO_core.ino`, `AIO_core.ino`, `I2C_core.ino`, `RS485_core.ino`, `gen_core.ino`
  - `gen_core.ino` now includes Evolution/Nexus support plus Evo2 encapsulated unlock (AES) and auto controller-type detection (flags bit0=plain, bit1=Evo2).

## Configuration files
- `config/config.json` – module list (ids like `rs485-0x50`, `i2c1-0x30` for bridge modules).
- `config/expansion_config.json` – expander address/name mapping.
- `config/ui_labels.json` – user-facing labels for modules/channels.
- `config/dev_i2c.json` – simulated device data for dev mode.
- `config/aio_max_voltage.py` – helper to persist AIO voltage limits.

## Notes
- RS485-only: direct I2C reads are intentionally disabled; the I2C bridge module remains supported over RS485.
- Generator control: head talks RS485 half-duplex to the Generator Pi, which forwards generator commands downstream; dry contacts are handled locally on the Generator Pi. Evo2 controllers are supported via encapsulated AES unlock in `gen_core.ino`.
- If you need pure I2C operation, re-enable it in `core/backend.py` and install `smbus2` + system i2c tools.

## License
Not specified. Add your license text if needed.

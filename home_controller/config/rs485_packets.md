# RS485 Packet Reference

All legacy module links (DI/DO/AIO/I2C/RS485 hub) use a simple XOR CRC of all previous bytes. Generator (FD485) frames use CRC‑16/CCITT‑FALSE.

## Legacy Modules (XOR CRC)

| Firmware | Direction | Bytes | Layout (byte order) | Notes |
| --- | --- | --- | --- | --- |
| **DI_core.ino** | Request | 5 | `0xAA, addr, ch, CMD_READ=0x00, crc` | `ch=0xFE` reads inputs 0–7 in data byte; `ch=0xFF` reads 8–15. |
| | Reply | 6 | `0x55, addr, ch, value, senseMask, crc` | `value` bit per channel; `senseMask` shows sense/health. |
| **DO_core.ino** | Request | 5 | `0xAA, addr, ch, cmd, crc` | `cmd=0` off, `cmd!=0` on. |
| | Reply | 6 | `0x55, addr, ch, actual_state, senseMask, crc` | No read-only request; every request sets state. |
| **AIO_core.ino** | Request | 7 | `0xAA, addr, ch, cmd, d0, d1, crc` | `cmd 0x00=READ, 0x01=WRITE`; 12‑bit value = `d0 | ((d1 & 0x0F) << 8)`. |
| | Reply | 8 | `0x55, addr, ch, cmd, d0, d1, senseMask, crc` | `senseMask` flags sensor/ADC status. |
| **I2C_core.ino** | Request | 9 | `0xAA, addr, cmd, type, i2c, p0, p1, p2, crc` | `type` = sensor type, `i2c` = I2C addr, params in `p0..p2`. |
| | Reply | 12 | `0x55, addr, cmd, type, i2c, field, d0, d1, d2, d3, status, crc` | Multiple 12B frames may follow per request. |
| **RS485_core.ino (4‑bus expander)** | Upstream req | `5 + len` | `0xAA, moduleAddr, bus, len, payload..., crc` | `bus` selects downstream RS485 bus 0‑3. |
| | Upstream reply | `6 + len` | `0x55, moduleAddr, bus, len, payload..., status, crc` | `status` is last byte before crc. |

## Generator (FD485 framing, CRC16)

Frame: `SYNC(0xAA55) | ver | msg_type | src | dst | seq | len | payload... | CRC16`

- `ver = 0x01`
- CRC16 is CCITT‑FALSE over all bytes except the CRC itself.

### Message types

| Value | Name | Purpose |
| --- | --- | --- |
| 0x01 | `MSG_TELEM` | Periodic telemetry (1 Hz). Payload = `TelemetryV1`. |
| 0x02 | `MSG_CMD` | Command from head ➜ generator module. Payload = `CmdPayload`. |
| 0x03 | `MSG_ACK` | ACK/NAK in response to a command. |

### Command payload (MSG_CMD)

`[cmd, flags, param1_lo, param1_hi, param2_lo, param2_hi, token0, token1, token2, token3]`

| Cmd | Meaning | Params |
| --- | --- | --- |
| 0x01 | START | none |
| 0x02 | STOP | none |
| 0x03 | EXERCISE (no transfer) | none |
| 0x04 | EXERCISE (with transfer) | none |
| 0x05 | CLEAR_ALARM | none |
| 0x06 | SET_MODE | `param1: 1=OFF, 2=AUTO, 3=MANUAL` |
| 0x08 | LOCKOUT | none |
| 0x09 | UNLOCKOUT | none |
| 0x0A | SNAPSHOT | none |

ACK payload = `[result]` where `result` is `0=OK, 1=INVALID_CMD, 2=LOCKED_OUT, 3=GEN_COMMS, 4=REJECTED, 5=TIMEOUT`.

### Telemetry payload (TelemetryV1, little‑endian)

| Field | Type/Units | Notes |
| --- | --- | --- |
| `uptime_s` | u32 seconds | Module uptime. |
| `batt_mv` | u16 mV | Battery voltage. |
| `eng_temp_c_x10` | s16 °C×10 | Engine temp. |
| `gen_v_l1_x10` | u16 V×10 | Generator L1. |
| `gen_v_l2_x10` | u16 V×10 | Generator L2. |
| `util_v_l1_x10` | u16 V×10 | Utility L1. |
| `util_v_l2_x10` | u16 V×10 | Utility L2. |
| `amps_l1_x100` | u16 A×100 | Final L1 current. |
| `amps_l2_x100` | u16 A×100 | Final L2 current. |
| `amps_flags` | u8 bitfield | Validity bits (see firmware). |
| `amps_src` | u8 packed | 2 bits per leg: 0=NONE,1=CTRL,2=CT,3=BLEND. |
| `hz_x100` | u16 Hz×100 | Line frequency. |
| `rpm` | u16 | Engine RPM. |
| `run_seconds` | u32 s | Runtime counter. |
| `alarm_code` | u16 | Active alarm. |
| `warn_code` | u16 | Active warning. |
| `state` | u8 | 0 UNKNOWN, 1 STOPPED, 2 STARTING, 3 RUNNING, 4 COOLDOWN, 5 EXERCISE, 6 ALARM, 7 WARNING. |
| `mode` | u8 | 0 UNKNOWN, 1 OFF, 2 AUTO, 3 MANUAL. |
| `flags` | u16 | Misc flags. |
| `poll_ms` | u16 ms | Generac poll interval. |
| `good_frames` | u16 | Telemetry frames sent OK. |
| `bad_frames` | u16 | Telemetry frames with CRC/parse errors. |


/*
  XIAO RP2040 - Generac Maintenance Port -> FD485 Gateway with CT fallback
  - FD485 framing: SYNC(0xAA55) + ver + msg_type + src/dst + seq + len + payload + CRC16
  - Telemetry @ 1 Hz
  - Commands: Start/Stop/Exercise/ClearAlarm/SetMode/Lockout
  - External CT RMS always measured on A2/A3
  - Final amps per leg:
      if ctrl valid and ct valid -> avg
      else if ctrl valid -> ctrl
      else if ct valid -> ct
      else 0
  - "Generac poll" is a scaffold: implement poll + parse in pollGenerac()/parseGeneracFrame()
*/

#include <Arduino.h>

// ------------------------- USER CONFIG -------------------------

// Module addressing (matches your RS485 addressing scheme)
static const uint8_t MODULE_ID_XIAO = 0x20;
static const uint8_t CABINET_ID     = 0x01;

// FD485 protocol
static const uint16_t SYNC_WORD = 0xAA55;
static const uint8_t  PROTO_VER = 0x01;

// UART assignments (Arduino-Pico / Earle Philhower core):
//   Serial1 and Serial2 typically map to UART0 and UART1.
// Adjust if your core differs.
// FD485 bus UART
#define FD485_SERIAL   Serial1
// Generac RS232 UART (via MAX3232)
#define GEN_SERIAL     Serial2

// Baud rates
static const uint32_t FD485_BAUD = 250000;    // fast & reliable for short runs
static const uint32_t GEN_BAUD_1 = 115200;    // common
static const uint32_t GEN_BAUD_2 = 9600;      // fallback

// Telemetry interval
static const uint32_t TELEMETRY_PERIOD_MS = 1000;

// Controller timeout to mark controller-derived values invalid
static const uint32_t CTRL_GOOD_TIMEOUT_MS = 3000;

// CT measurement
static const uint8_t  CT_PIN_L1 = A2;
static const uint8_t  CT_PIN_L2 = A3;
static const uint16_t CT_SAMPLE_RATE_HZ = 4000;      // 4 kHz sampling
static const uint16_t CT_WINDOW_MS      = 250;       // 250 ms RMS window
static const float    CT_NOISE_FLOOR_A   = 0.20f;     // below this -> 0
static const float    CT_MAX_A           = 200.0f;    // clamp/invalid above this
static const float    CT_CAL_L1_A_PER_COUNT = 0.020f; // *** set this by calibration ***
static const float    CT_CAL_L2_A_PER_COUNT = 0.020f; // *** set this by calibration ***
static const uint16_t ADC_MAX_COUNTS = 4095;          // 12-bit
static const uint16_t ADC_CLIP_MARGIN = 20;           // near-rail counts

// Optional: lockout (software)
static bool g_lockout = false;

// ------------------------- PROTOCOL DEFINITIONS -------------------------

enum MsgType : uint8_t {
  MSG_TELEM  = 0x01,
  MSG_CMD    = 0x02,
  MSG_ACKNAK = 0x03
};

enum CmdCode : uint8_t {
  CMD_START          = 0x01,
  CMD_STOP           = 0x02,
  CMD_EXERCISE_NO_XFER= 0x03,
  CMD_EXERCISE_XFER   = 0x04,
  CMD_CLEAR_ALARM    = 0x05,
  CMD_SET_MODE       = 0x06, // param1 = 1 OFF, 2 AUTO, 3 MANUAL
  CMD_LOCKOUT        = 0x08,
  CMD_UNLOCKOUT      = 0x09,
  CMD_SNAPSHOT       = 0x0A
};

enum AckResult : uint8_t {
  ACK_OK               = 0,
  ACK_ERR_INVALID_CMD  = 1,
  ACK_ERR_LOCKED_OUT   = 2,
  ACK_ERR_GEN_COMMS    = 3,
  ACK_ERR_REJECTED     = 4,
  ACK_ERR_TIMEOUT      = 5
};

enum AmpSource2b : uint8_t {
  SRC_NONE  = 0,
  SRC_CTRL  = 1,
  SRC_CT    = 2,
  SRC_BLEND = 3
};

// amps_flags bits
static const uint8_t AMP_CTRL_L1_VALID = (1u << 0);
static const uint8_t AMP_CT_L1_VALID   = (1u << 1);
static const uint8_t AMP_CTRL_L2_VALID = (1u << 2);
static const uint8_t AMP_CT_L2_VALID   = (1u << 3);

// state/mode enums (yours to refine)
enum GenState : uint8_t {
  GEN_UNKNOWN = 0,
  GEN_STOPPED = 1,
  GEN_STARTING= 2,
  GEN_RUNNING = 3,
  GEN_COOLDOWN= 4,
  GEN_EXERCISE= 5,
  GEN_ALARM   = 6,
  GEN_WARNING = 7
};

enum GenMode : uint8_t {
  MODE_UNKNOWN= 0,
  MODE_OFF    = 1,
  MODE_AUTO   = 2,
  MODE_MANUAL = 3
};

// Telemetry payload (packed) - keep stable
typedef struct __attribute__((packed)) {
  uint32_t uptime_s;

  uint16_t batt_mv;           // mV
  int16_t  eng_temp_c_x10;    // °C x10

  uint16_t gen_v_l1_x10;      // V x10
  uint16_t gen_v_l2_x10;      // V x10
  uint16_t util_v_l1_x10;     // V x10
  uint16_t util_v_l2_x10;     // V x10

  uint16_t amps_l1_x100;      // FINAL A x100
  uint16_t amps_l2_x100;      // FINAL A x100
  uint8_t  amps_flags;        // validity bits
  uint8_t  amps_src;          // 2 bits per leg: L1 bits0-1, L2 bits2-3

  uint16_t hz_x100;           // Hz x100
  uint16_t rpm;

  uint32_t run_seconds;

  uint16_t alarm_code;
  uint16_t warn_code;

  uint8_t  state;
  uint8_t  mode;

  uint16_t flags;             // general flags (bitfield)
  uint16_t poll_ms;

  uint16_t good_frames;
  uint16_t bad_frames;
} TelemetryV1;

// ------------------------- RUNTIME STATE -------------------------

static TelemetryV1 g_t = {0};
static uint8_t g_seq_tx = 0;

// "Controller-derived" current (from Generac poll)
static uint16_t g_ctrl_a_l1_x100 = 0;
static uint16_t g_ctrl_a_l2_x100 = 0;
static uint32_t g_last_ctrl_good_ms = 0;

// External CT RMS
static uint16_t g_ct_a_l1_x100 = 0;
static uint16_t g_ct_a_l2_x100 = 0;
static bool g_ct_l1_ok = false;
static bool g_ct_l2_ok = false;

// Telemetry counters
static uint16_t g_good_frames = 0;
static uint16_t g_bad_frames = 0;

// Snapshot request
static volatile bool g_force_snapshot = false;

// ------------------------- CRC16 (CCITT-FALSE) -------------------------

static uint16_t crc16_ccitt_false(const uint8_t* data, size_t len) {
  uint16_t crc = 0xFFFF;
  for (size_t i = 0; i < len; i++) {
    crc ^= (uint16_t)data[i] << 8;
    for (uint8_t b = 0; b < 8; b++) {
      if (crc & 0x8000) crc = (crc << 1) ^ 0x1021;
      else              crc = (crc << 1);
    }
  }
  return crc;
}

// ------------------------- PACKING HELPERS -------------------------

static inline uint8_t pack_src(AmpSource2b l1, AmpSource2b l2) {
  return (uint8_t)((l1 & 0x3) | ((l2 & 0x3) << 2));
}

static inline bool amps_valid_u16_x100(uint16_t a_x100) {
  return (a_x100 <= 20000);
}

static inline uint16_t avg_u16_round(uint16_t a, uint16_t b) {
  return (uint16_t)((a + b + 1) / 2);
}

// ------------------------- CT RMS SAMPLING -------------------------

typedef struct {
  uint32_t sumsq;     // sum of squared centered samples
  uint32_t n;         // sample count
  uint32_t clip;      // clipped samples
  uint16_t minv;
  uint16_t maxv;
} CtAccum;

static CtAccum acc_l1, acc_l2;

static void ctAccumReset(CtAccum &a) {
  a.sumsq = 0;
  a.n = 0;
  a.clip = 0;
  a.minv = 0xFFFF;
  a.maxv = 0;
}

// Estimate midpoint for biased AC input
static inline int32_t center_sample(uint16_t s) {
  // If you bias to mid-supply, midpoint ~ ADC_MAX/2
  // If you have a different bias, you can adapt by tracking running mean.
  const int32_t mid = ADC_MAX_COUNTS / 2;
  return (int32_t)s - mid;
}

static void sampleCTOnce() {
  uint16_t s1 = analogRead(CT_PIN_L1);
  uint16_t s2 = analogRead(CT_PIN_L2);

  // clip detect
  if (s1 < ADC_CLIP_MARGIN || s1 > (ADC_MAX_COUNTS - ADC_CLIP_MARGIN)) acc_l1.clip++;
  if (s2 < ADC_CLIP_MARGIN || s2 > (ADC_MAX_COUNTS - ADC_CLIP_MARGIN)) acc_l2.clip++;

  acc_l1.minv = min(acc_l1.minv, s1);
  acc_l1.maxv = max(acc_l1.maxv, s1);
  acc_l2.minv = min(acc_l2.minv, s2);
  acc_l2.maxv = max(acc_l2.maxv, s2);

  int32_t c1 = center_sample(s1);
  int32_t c2 = center_sample(s2);

  acc_l1.sumsq += (uint32_t)(c1 * c1);
  acc_l2.sumsq += (uint32_t)(c2 * c2);
  acc_l1.n++;
  acc_l2.n++;
}

static void computeCT() {
  // validity based on clip ratio
  auto computeOne = [](CtAccum &a, float cal_a_per_count, bool &ok_out, uint16_t &amps_x100_out) {
    ok_out = false;
    amps_x100_out = 0;

    if (a.n < 10) return;

    float clip_frac = (float)a.clip / (float)a.n;
    if (clip_frac > 0.01f) {
      // too much clipping => invalid
      return;
    }

    float mean_sq = (float)a.sumsq / (float)a.n;
    float rms_counts = sqrtf(mean_sq);

    float amps = rms_counts * cal_a_per_count;

    // noise floor
    if (amps < CT_NOISE_FLOOR_A) amps = 0.0f;

    // sanity
    if (amps < 0.0f || amps > CT_MAX_A) return;

    uint16_t ax100 = (uint16_t)lroundf(amps * 100.0f);
    if (!amps_valid_u16_x100(ax100)) return;

    ok_out = true;
    amps_x100_out = ax100;
  };

  computeOne(acc_l1, CT_CAL_L1_A_PER_COUNT, g_ct_l1_ok, g_ct_a_l1_x100);
  computeOne(acc_l2, CT_CAL_L2_A_PER_COUNT, g_ct_l2_ok, g_ct_a_l2_x100);
}

// ------------------------- AMPS BLENDING -------------------------

static void fillFinalAmps(uint32_t now_ms) {
  bool ctrl_age_ok = (now_ms - g_last_ctrl_good_ms) < CTRL_GOOD_TIMEOUT_MS;

  // validate ctrl readings too
  bool ctrl_l1_ok = ctrl_age_ok && amps_valid_u16_x100(g_ctrl_a_l1_x100);
  bool ctrl_l2_ok = ctrl_age_ok && amps_valid_u16_x100(g_ctrl_a_l2_x100);

  // CT already has ok flags + range checks
  bool ct_l1_ok = g_ct_l1_ok && amps_valid_u16_x100(g_ct_a_l1_x100);
  bool ct_l2_ok = g_ct_l2_ok && amps_valid_u16_x100(g_ct_a_l2_x100);

  // L1
  uint16_t out_l1 = 0;
  AmpSource2b src_l1 = SRC_NONE;
  if (ctrl_l1_ok && ct_l1_ok) {
    out_l1 = avg_u16_round(g_ctrl_a_l1_x100, g_ct_a_l1_x100);
    src_l1 = SRC_BLEND;
  } else if (ctrl_l1_ok) {
    out_l1 = g_ctrl_a_l1_x100;
    src_l1 = SRC_CTRL;
  } else if (ct_l1_ok) {
    out_l1 = g_ct_a_l1_x100;
    src_l1 = SRC_CT;
  }

  // L2
  uint16_t out_l2 = 0;
  AmpSource2b src_l2 = SRC_NONE;
  if (ctrl_l2_ok && ct_l2_ok) {
    out_l2 = avg_u16_round(g_ctrl_a_l2_x100, g_ct_a_l2_x100);
    src_l2 = SRC_BLEND;
  } else if (ctrl_l2_ok) {
    out_l2 = g_ctrl_a_l2_x100;
    src_l2 = SRC_CTRL;
  } else if (ct_l2_ok) {
    out_l2 = g_ct_a_l2_x100;
    src_l2 = SRC_CT;
  }

  uint8_t flags = 0;
  if (ctrl_l1_ok) flags |= AMP_CTRL_L1_VALID;
  if (ct_l1_ok)   flags |= AMP_CT_L1_VALID;
  if (ctrl_l2_ok) flags |= AMP_CTRL_L2_VALID;
  if (ct_l2_ok)   flags |= AMP_CT_L2_VALID;

  g_t.amps_l1_x100 = out_l1;
  g_t.amps_l2_x100 = out_l2;
  g_t.amps_flags   = flags;
  g_t.amps_src     = pack_src(src_l1, src_l2);
}

// ------------------------- FD485 FRAME TX -------------------------

static void sendFrame(uint8_t msg_type, uint8_t dst_id, const uint8_t* payload, uint8_t payload_len) {
  // Header: SYNC(2) + ver(1) + type(1) + src(1) + dst(1) + seq(1) + len(1) = 8 bytes
  uint8_t hdr[8];
  hdr[0] = (uint8_t)(SYNC_WORD >> 8);
  hdr[1] = (uint8_t)(SYNC_WORD & 0xFF);
  hdr[2] = PROTO_VER;
  hdr[3] = msg_type;
  hdr[4] = MODULE_ID_XIAO;
  hdr[5] = dst_id;
  hdr[6] = g_seq_tx++;
  hdr[7] = payload_len;

  // CRC over header+payload
  // We'll compute in two passes (simple)
  uint16_t crc = 0xFFFF;
  crc = crc16_ccitt_false(hdr, sizeof(hdr));
  // crc16 function above is not incremental; simplest: build buffer.
  // For small payload, just build buffer:
  uint8_t buf[8 + 255];
  memcpy(buf, hdr, 8);
  if (payload_len) memcpy(buf + 8, payload, payload_len);
  crc = crc16_ccitt_false(buf, 8 + payload_len);

  FD485_SERIAL.write(hdr, 8);
  if (payload_len) FD485_SERIAL.write(payload, payload_len);
  FD485_SERIAL.write((uint8_t)(crc >> 8));
  FD485_SERIAL.write((uint8_t)(crc & 0xFF));
}

// ------------------------- FD485 RX PARSER -------------------------

typedef struct {
  uint8_t  buf[8 + 255 + 2]; // hdr + payload + crc
  uint16_t idx;
  uint16_t needed;
  bool     syncing;
} RxState;

static RxState rx = {{0}, 0, 0, true};

static void rxReset() {
  rx.idx = 0;
  rx.needed = 0;
  rx.syncing = true;
}

static bool rxTryParseOne() {
  while (FD485_SERIAL.available()) {
    uint8_t b = (uint8_t)FD485_SERIAL.read();

    if (rx.syncing) {
      // Find 0xAA 0x55
      if (rx.idx == 0) {
        if (b == 0xAA) {
          rx.buf[rx.idx++] = b;
        }
      } else if (rx.idx == 1) {
        if (b == 0x55) {
          rx.buf[rx.idx++] = b;
          rx.syncing = false;
          rx.needed = 8; // need full header first
        } else {
          rx.idx = 0;
        }
      }
      continue;
    }

    rx.buf[rx.idx++] = b;

    // After header received, determine total needed
    if (rx.idx == 8) {
      uint8_t payload_len = rx.buf[7];
      rx.needed = 8 + payload_len + 2; // hdr + payload + crc
      if (rx.needed > sizeof(rx.buf)) {
        rxReset();
        g_bad_frames++;
        continue;
      }
    }

    if (rx.needed && rx.idx >= rx.needed) {
      // Validate CRC
      uint16_t got = ((uint16_t)rx.buf[rx.needed - 2] << 8) | rx.buf[rx.needed - 1];
      uint16_t calc = crc16_ccitt_false(rx.buf, rx.needed - 2);
      if (got != calc) {
        g_bad_frames++;
        rxReset();
        return false;
      }

      // Validate basics
      uint8_t ver = rx.buf[2];
      uint8_t type = rx.buf[3];
      uint8_t src = rx.buf[4];
      uint8_t dst = rx.buf[5];
      uint8_t seq = rx.buf[6];
      uint8_t len = rx.buf[7];
      (void)src; (void)seq;

      if (ver != PROTO_VER) {
        g_bad_frames++;
        rxReset();
        return false;
      }

      // Only process if addressed to us or broadcast
      if (!(dst == MODULE_ID_XIAO || dst == 0xFF)) {
        rxReset();
        return false;
      }

      // Handle command
      if (type == MSG_CMD) {
        if (len < 2) {
          g_bad_frames++;
        } else {
          const uint8_t* pl = rx.buf + 8;
          uint8_t cmd = pl[0];
          uint8_t cmd_flags = pl[1];
          uint16_t param1 = (len >= 4) ? (uint16_t)(pl[2] | (pl[3] << 8)) : 0;
          uint16_t param2 = (len >= 6) ? (uint16_t)(pl[4] | (pl[5] << 8)) : 0;
          uint32_t token  = (len >= 10) ? (uint32_t)(pl[6] | (pl[7] << 8) | (pl[8] << 16) | (pl[9] << 24)) : 0;
          (void)cmd_flags; (void)param2; (void)token;

          // Execute
          uint8_t result = ACK_OK;
          uint16_t detail = 0;

          if (cmd == CMD_LOCKOUT) {
            g_lockout = true;
          } else if (cmd == CMD_UNLOCKOUT) {
            g_lockout = false;
          } else if (cmd == CMD_SNAPSHOT) {
            g_force_snapshot = true;
          } else {
            if (g_lockout) {
              result = ACK_ERR_LOCKED_OUT;
            } else {
              // Forward to generator port
              bool ok = false;
              switch (cmd) {
                case CMD_START:           ok = genCommandStart(); break;
                case CMD_STOP:            ok = genCommandStop(); break;
                case CMD_EXERCISE_NO_XFER:ok = genCommandExercise(false); break;
                case CMD_EXERCISE_XFER:   ok = genCommandExercise(true);  break;
                case CMD_CLEAR_ALARM:     ok = genCommandClearAlarm(); break;
                case CMD_SET_MODE:        ok = genCommandSetMode(param1); break;
                default:
                  result = ACK_ERR_INVALID_CMD;
                  break;
              }
              if (result == ACK_OK && !ok) {
                result = ACK_ERR_GEN_COMMS;
                detail = 1;
              }
            }
          }

          // ACK/NAK response
          uint8_t ackpl[8];
          ackpl[0] = cmd;
          ackpl[1] = result;
          ackpl[2] = (uint8_t)(detail & 0xFF);
          ackpl[3] = (uint8_t)(detail >> 8);
          // echo original seq not stored; if you want it, pass seq in header or include in payload
          ackpl[4] = 0; ackpl[5] = 0; ackpl[6] = 0; ackpl[7] = 0;
          sendFrame(MSG_ACKNAK, CABINET_ID, ackpl, sizeof(ackpl));

          // After any command, force a snapshot
          g_force_snapshot = true;
        }
      }

      g_good_frames++;
      rxReset();
      return true;
    }
  }
  return false;
}

// ------------------------- GENERAC POLL SCAFFOLD -------------------------
// These are intentionally "stubs" until you finalize your exact maintenance-port frames.
// The rest of the system (FD485 + CT + blending) is complete.

static uint32_t g_last_gen_poll_ms = 0;
static uint8_t  g_gen_baud_mode = 0; // 0=115200, 1=9600

static void setGenBaud(uint8_t mode) {
  g_gen_baud_mode = mode;
  GEN_SERIAL.end();
  delay(20);
  GEN_SERIAL.begin((mode == 0) ? GEN_BAUD_1 : GEN_BAUD_2);
}

// Replace with your real poll frame(s)
static void pollGenerac() {
  // Example: if you have a binary poll request, write it here.
  // For now, we just "ping" by reading any available data.
  // You will implement:
  //  1) GEN_SERIAL.write(poll_frame,...)
  //  2) read response into buffer
  //  3) parseGeneracFrame(buffer, len)
}

static bool parseGeneracFrame(const uint8_t* buf, size_t len) {
  // TODO: implement with your real protocol.
  // When you do, update:
  //  - g_t.batt_mv
  //  - g_t.eng_temp_c_x10
  //  - g_t.gen_v_l1_x10 / gen_v_l2_x10
  //  - g_t.util_v_l1_x10 / util_v_l2_x10
  //  - g_ctrl_a_l1_x100 / g_ctrl_a_l2_x100 (if present)
  //  - g_t.hz_x100, g_t.rpm, g_t.state, g_t.mode, alarm_code, warn_code
  //
  // On a successful parse, set:
  //  g_last_ctrl_good_ms = millis();
  // and return true.
  (void)buf; (void)len;
  return false;
}

// Optional: auto-fallback baud if nothing valid after N seconds
static void maybeRotateGenBaud(uint32_t now_ms) {
  static uint32_t last_switch_ms = 0;
  // If we haven't had a good controller poll in 10s, toggle baud
  if ((now_ms - g_last_ctrl_good_ms) > 10000 && (now_ms - last_switch_ms) > 10000) {
    setGenBaud(g_gen_baud_mode ? 0 : 1);
    last_switch_ms = now_ms;
  }
}

// ------------------------- GENERAC COMMAND STUBS -------------------------
// Replace these with the real maintenance-port command frames.
// For now they just return false to indicate not implemented.

bool genCommandStart() {
  // TODO send "start" command over GEN_SERIAL and confirm
  return false;
}
bool genCommandStop() {
  // TODO
  return false;
}
bool genCommandExercise(bool withTransfer) {
  (void)withTransfer;
  // TODO
  return false;
}
bool genCommandClearAlarm() {
  // TODO
  return false;
}
bool genCommandSetMode(uint16_t mode) {
  (void)mode;
  // TODO
  return false;
}

// ------------------------- TELEMETRY BUILD + SEND -------------------------

static void updateTelemetryBase(uint32_t now_ms) {
  g_t.uptime_s = now_ms / 1000;

  // You will be filling these from parseGeneracFrame() later:
  // g_t.batt_mv, g_t.eng_temp_c_x10, volts, hz, rpm, state, mode, alarms...

  // Always blend amps using latest ctrl + CT
  fillFinalAmps(now_ms);

  // basic counters
  g_t.good_frames = g_good_frames;
  g_t.bad_frames  = g_bad_frames;
}

static void sendTelemetry() {
  // Send the packed TelemetryV1 as payload
  sendFrame(MSG_TELEM, CABINET_ID, (const uint8_t*)&g_t, (uint8_t)sizeof(TelemetryV1));
}

// ------------------------- MAIN LOOP -------------------------

void setup() {
  delay(200);

  analogReadResolution(12);

  // Start FD485 UART
  FD485_SERIAL.begin(FD485_BAUD);

  // Start GEN UART
  GEN_SERIAL.begin(GEN_BAUD_1);

  ctAccumReset(acc_l1);
  ctAccumReset(acc_l2);

  // Initialize defaults
  g_t.state = GEN_UNKNOWN;
  g_t.mode  = MODE_UNKNOWN;
  g_t.flags = 0;

  g_last_ctrl_good_ms = 0;
}

void loop() {
  uint32_t now_ms = millis();

  // 1) FD485 RX parse (commands)
  rxTryParseOne();

  // 2) CT sampling at CT_SAMPLE_RATE_HZ for CT_WINDOW_MS windows
  static uint32_t next_ct_us = 0;
  static uint32_t window_start_ms = 0;

  uint32_t now_us = micros();
  if ((int32_t)(now_us - next_ct_us) >= 0) {
    next_ct_us = now_us + (1000000UL / CT_SAMPLE_RATE_HZ);
    sampleCTOnce();
  }

  if (window_start_ms == 0) window_start_ms = now_ms;
  if ((now_ms - window_start_ms) >= CT_WINDOW_MS) {
    computeCT();
    ctAccumReset(acc_l1);
    ctAccumReset(acc_l2);
    window_start_ms = now_ms;
  }

  // 3) Poll generator (scaffold)
  if ((now_ms - g_last_gen_poll_ms) >= 250) { // internal poll tick, you choose
    g_last_gen_poll_ms = now_ms;
    maybeRotateGenBaud(now_ms);
    pollGenerac();
    // If you implement pollGenerac reading frames, call parseGeneracFrame(...) there.
  }

  // 4) Telemetry stream
  static uint32_t last_telem_ms = 0;
  if (g_force_snapshot || (now_ms - last_telem_ms) >= TELEMETRY_PERIOD_MS) {
    g_force_snapshot = false;
    last_telem_ms = now_ms;

    updateTelemetryBase(now_ms);
    sendTelemetry();
  }
}
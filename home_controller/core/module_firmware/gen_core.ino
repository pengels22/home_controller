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
static const uint32_t GEN_BAUD_1 = 115200;    // legacy fast baud (not common on maintenance port)
static const uint32_t GEN_BAUD_2 = 9600;      // legacy slow baud

// Telemetry interval
static const uint32_t TELEMETRY_PERIOD_MS = 1000;

// Controller timeout to mark controller-derived values invalid
static const uint32_t CTRL_GOOD_TIMEOUT_MS = 3000;

// Generac maintenance-port (Modbus RTU) defaults (pulled from Generator project)
static const uint8_t  GEN_MODBUS_ID    = 0x9D;   // Evolution/Nexus default slave ID
static const uint32_t GEN_MODBUS_BAUD  = 9600;   // maintenance port speed
static const uint32_t GEN_MODBUS_RX_TIMEOUT_MS = 120; // wait per transaction
static const bool     GEN_EVO2 = true;      // set true for Evolution 2 controllers (encapsulated writes)

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

// Modbus RTU CRC16 (poly 0xA001, little-endian on the wire)
static uint16_t modbus_crc16(const uint8_t* data, size_t len) {
  uint16_t crc = 0xFFFF;
  for (size_t i = 0; i < len; i++) {
    crc ^= data[i];
    for (uint8_t b = 0; b < 8; b++) {
      if (crc & 0x0001) crc = (crc >> 1) ^ 0xA001;
      else              crc >>= 1;
    }
  }
  return crc;
}

// ------------------------------------------------------------
// Tiny AES-128 (encrypt only, CBC) - trimmed for firmware use
// Source derived from tiny-AES-c (public domain)
// ------------------------------------------------------------

static const uint8_t sbox[256] = {
  // 0     1    2    3    4    5    6    7    8    9    A    B    C    D    E    F
  0x63,0x7c,0x77,0x7b,0xf2,0x6b,0x6f,0xc5,0x30,0x01,0x67,0x2b,0xfe,0xd7,0xab,0x76,
  0xca,0x82,0xc9,0x7d,0xfa,0x59,0x47,0xf0,0xad,0xd4,0xa2,0xaf,0x9c,0xa4,0x72,0xc0,
  0xb7,0xfd,0x93,0x26,0x36,0x3f,0xf7,0xcc,0x34,0xa5,0xe5,0xf1,0x71,0xd8,0x31,0x15,
  0x04,0xc7,0x23,0xc3,0x18,0x96,0x05,0x9a,0x07,0x12,0x80,0xe2,0xeb,0x27,0xb2,0x75,
  0x09,0x83,0x2c,0x1a,0x1b,0x6e,0x5a,0xa0,0x52,0x3b,0xd6,0xb3,0x29,0xe3,0x2f,0x84,
  0x53,0xd1,0x00,0xed,0x20,0xfc,0xb1,0x5b,0x6a,0xcb,0xbe,0x39,0x4a,0x4c,0x58,0xcf,
  0xd0,0xef,0xaa,0xfb,0x43,0x4d,0x33,0x85,0x45,0xf9,0x02,0x7f,0x50,0x3c,0x9f,0xa8,
  0x51,0xa3,0x40,0x8f,0x92,0x9d,0x38,0xf5,0xbc,0xb6,0xda,0x21,0x10,0xff,0xf3,0xd2,
  0xcd,0x0c,0x13,0xec,0x5f,0x97,0x44,0x17,0xc4,0xa7,0x7e,0x3d,0x64,0x5d,0x19,0x73,
  0x60,0x81,0x4f,0xdc,0x22,0x2a,0x90,0x88,0x46,0xee,0xb8,0x14,0xde,0x5e,0x0b,0xdb,
  0xe0,0x32,0x3a,0x0a,0x49,0x06,0x24,0x5c,0xc2,0xd3,0xac,0x62,0x91,0x95,0xe4,0x79,
  0xe7,0xc8,0x37,0x6d,0x8d,0xd5,0x4e,0xa9,0x6c,0x56,0xf4,0xea,0x65,0x7a,0xae,0x08,
  0xba,0x78,0x25,0x2e,0x1c,0xa6,0xb4,0xc6,0xe8,0xdd,0x74,0x1f,0x4b,0xbd,0x8b,0x8a,
  0x70,0x3e,0xb5,0x66,0x48,0x03,0xf6,0x0e,0x61,0x35,0x57,0xb9,0x86,0xc1,0x1d,0x9e,
  0xe1,0xf8,0x98,0x11,0x69,0xd9,0x8e,0x94,0x9b,0x1e,0x87,0xe9,0xce,0x55,0x28,0xdf,
  0x8c,0xa1,0x89,0x0d,0xbf,0xe6,0x42,0x68,0x41,0x99,0x2d,0x0f,0xb0,0x54,0xbb,0x16
};

static uint8_t xtime(uint8_t x) { return (uint8_t)((x<<1) ^ ((x>>7) * 0x1b)); }
static uint8_t mul(uint8_t x, uint8_t y) {
  return (uint8_t)(((y & 1) * x) ^
                   ((y>>1 & 1) * xtime(x)) ^
                   ((y>>2 & 1) * xtime(xtime(x))) ^
                   ((y>>3 & 1) * xtime(xtime(xtime(x)))) ^
                   ((y>>4 & 1) * xtime(xtime(xtime(xtime(x))))));
}

static void SubBytes(uint8_t* state) { for (int i=0;i<16;i++) state[i]=sbox[state[i]]; }
static void ShiftRows(uint8_t* s) {
  uint8_t t;
  t = s[1]; s[1]=s[5]; s[5]=s[9]; s[9]=s[13]; s[13]=t;
  t = s[2]; s[2]=s[10]; s[10]=t; t=s[6]; s[6]=s[14]; s[14]=t;
  t = s[3]; s[3]=s[15]; s[15]=s[11]; s[11]=s[7]; s[7]=t;
}
static void MixColumns(uint8_t* s) {
  for (int c=0;c<4;c++) {
    int i = c*4;
    uint8_t a0=s[i],a1=s[i+1],a2=s[i+2],a3=s[i+3];
    uint8_t r0 = mul(a0,2)^mul(a1,3)^a2^a3;
    uint8_t r1 = a0^mul(a1,2)^mul(a2,3)^a3;
    uint8_t r2 = a0^a1^mul(a2,2)^mul(a3,3);
    uint8_t r3 = mul(a0,3)^a1^a2^mul(a3,2);
    s[i]=r0; s[i+1]=r1; s[i+2]=r2; s[i+3]=r3;
  }
}

static void AddRoundKey(uint8_t* state, const uint8_t* roundKey) {
  for (int i=0;i<16;i++) state[i] ^= roundKey[i];
}

static void KeyExpansion(const uint8_t* key, uint8_t* roundKeys) {
  // roundKeys must be 176 bytes (11 round keys)
  static const uint8_t Rcon[11] = {0x00,0x01,0x02,0x04,0x08,0x10,0x20,0x40,0x80,0x1B,0x36};
  memcpy(roundKeys, key, 16);
  uint8_t temp[4];
  int bytesGen = 16;
  int rconIter = 1;
  while (bytesGen < 176) {
    for (int i=0;i<4;i++) temp[i] = roundKeys[bytesGen - 4 + i];
    if (bytesGen % 16 == 0) {
      // rotate
      uint8_t t = temp[0]; temp[0]=temp[1]; temp[1]=temp[2]; temp[2]=temp[3]; temp[3]=t;
      // sub
      for (int i=0;i<4;i++) temp[i] = sbox[temp[i]];
      temp[0] ^= Rcon[rconIter++];
    }
    for (int i=0;i<4;i++) {
      roundKeys[bytesGen] = roundKeys[bytesGen - 16] ^ temp[i];
      bytesGen++;
    }
  }
}

static void aes128_encrypt_block(uint8_t* block, const uint8_t* roundKeys) {
  AddRoundKey(block, roundKeys);
  for (int r=1;r<=9;r++) {
    SubBytes(block);
    ShiftRows(block);
    MixColumns(block);
    AddRoundKey(block, roundKeys + 16*r);
  }
  SubBytes(block);
  ShiftRows(block);
  AddRoundKey(block, roundKeys + 160);
}

static void aes128_cbc_encrypt(uint8_t* data, size_t len, const uint8_t* key, const uint8_t* iv) {
  uint8_t rk[176];
  KeyExpansion(key, rk);
  uint8_t prev[16];
  memcpy(prev, iv, 16);
  for (size_t offset=0; offset < len; offset += 16) {
    uint8_t* blk = data + offset;
    for (int i=0;i<16;i++) blk[i] ^= prev[i];
    aes128_encrypt_block(blk, rk);
    memcpy(prev, blk, 16);
  }
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

// ------------------------- GENERAC MODBUS HELPERS -------------------------
// Minimal Modbus RTU read (function 0x03) to pull base registers exposed by Generac
// Evolution/Nexus controllers. Derived from the public Generator project:
//   https://github.com/jgyates/Generator (GNU GPLv2)
// Notes:
//   - This does NOT implement the encrypted "encapsulated" EVO2 unlock sequence; it
//     targets the common unencapsulated register set. Many controllers still answer
//     these reads. If yours requires encapsulation, this will simply time out.
//   - We keep this tiny: no retries/backoff; the head-end will see missing data as
//     comms failures in telemetry counts.

static bool modbusReadRegisters(uint8_t slave, uint16_t reg, uint16_t words, uint16_t* out_buf, size_t out_cap) {
  if (words == 0 || out_buf == nullptr || out_cap < words) return false;

  uint8_t req[8];
  req[0] = slave;
  req[1] = 0x03; // Read Holding Registers
  req[2] = (uint8_t)(reg >> 8);
  req[3] = (uint8_t)(reg & 0xFF);
  req[4] = (uint8_t)(words >> 8);
  req[5] = (uint8_t)(words & 0xFF);
  uint16_t crc = modbus_crc16(req, 6);
  req[6] = (uint8_t)(crc & 0xFF);       // CRC low
  req[7] = (uint8_t)(crc >> 8);         // CRC high

  // Flush any stale bytes
  while (GEN_SERIAL.available()) GEN_SERIAL.read();
  GEN_SERIAL.write(req, sizeof(req));
  GEN_SERIAL.flush();

  const uint32_t start_ms = millis();
  const size_t expected = (size_t)(3 + (words * 2) + 2); // addr + func + bytecount + data + crc
  uint8_t resp[3 + 2 * 16 + 2]; // supports up to 16 words safely
  size_t idx = 0;

  while ((millis() - start_ms) < GEN_MODBUS_RX_TIMEOUT_MS) {
    while (GEN_SERIAL.available()) {
      if (idx >= sizeof(resp)) break;
      resp[idx++] = (uint8_t)GEN_SERIAL.read();
      if (idx >= expected) break;
    }
    if (idx >= expected) break;
    delayMicroseconds(300);
  }

  if (idx < expected) return false;
  // Basic validation
  if (resp[0] != slave || resp[1] != 0x03 || resp[2] != (words * 2)) return false;
  uint16_t rcrc = (uint16_t)resp[expected - 2] | ((uint16_t)resp[expected - 1] << 8);
  uint16_t ccrc = modbus_crc16(resp, expected - 2);
  if (rcrc != ccrc) return false;

  for (uint16_t i = 0; i < words; i++) {
    uint8_t hi = resp[3 + (i * 2)];
    uint8_t lo = resp[3 + (i * 2) + 1];
    out_buf[i] = (uint16_t)((hi << 8) | lo);
  }
  return true;
}

// Modbus RTU write single register (function 0x06)
static bool modbusWriteRegister(uint8_t slave, uint16_t reg, uint16_t value);
static bool modbusWriteRegisters(uint8_t slave, uint16_t reg, const uint8_t* data_bytes, uint16_t byte_len);

// Try plain write; if GEN_EVO2 is true or plain fails, fall back to Evo2 encapsulated write.
static bool modbusWriteRegisterAuto(uint8_t slave, uint16_t reg, uint16_t value);

// Controller type detection
enum GenCtrlType : uint8_t { GEN_TYPE_UNKNOWN=0, GEN_TYPE_PLAIN=1, GEN_TYPE_EVO2=2 };
static GenCtrlType g_gen_type = GEN_TYPE_UNKNOWN;

static void detect_controller_type() {
  // Try plain read of reg 0x0000
  uint16_t regbuf[1] = {0};
  bool plain_ok = modbusReadRegisters(GEN_MODBUS_ID, 0x0000, 1, regbuf, 1);
  if (plain_ok) {
    g_gen_type = GEN_TYPE_PLAIN;
    return;
  }
  // Try Evo2 unlock + read via encapsulated write (use a harmless write to 0x0000)
  uint8_t pkt[8];
  size_t plen = buildWriteSingleFrame(GEN_MODBUS_ID, 0x0000, 0x0000, pkt);
  if (evo2_unlock_and_send(pkt, plen)) {
    g_gen_type = GEN_TYPE_EVO2;
    return;
  }
  g_gen_type = GEN_TYPE_UNKNOWN;
}

static bool modbusWriteRegister(uint8_t slave, uint16_t reg, uint16_t value) {
  uint8_t req[8];
  req[0] = slave;
  req[1] = 0x06; // Write Single Register
  req[2] = (uint8_t)(reg >> 8);
  req[3] = (uint8_t)(reg & 0xFF);
  req[4] = (uint8_t)(value >> 8);
  req[5] = (uint8_t)(value & 0xFF);
  uint16_t crc = modbus_crc16(req, 6);
  req[6] = (uint8_t)(crc & 0xFF); // CRC low
  req[7] = (uint8_t)(crc >> 8);   // CRC high

  while (GEN_SERIAL.available()) GEN_SERIAL.read();
  GEN_SERIAL.write(req, sizeof(req));
  GEN_SERIAL.flush();

  const uint32_t start_ms = millis();
  uint8_t resp[8] = {0};
  size_t idx = 0;
  while ((millis() - start_ms) < GEN_MODBUS_RX_TIMEOUT_MS) {
    while (GEN_SERIAL.available()) {
      resp[idx++] = (uint8_t)GEN_SERIAL.read();
      if (idx >= sizeof(resp)) break;
    }
    if (idx >= sizeof(resp)) break;
    delayMicroseconds(300);
  }
  if (idx < sizeof(resp)) return false;
  // Validate echo
  uint16_t rcrc = (uint16_t)resp[7] << 8 | resp[6];
  uint16_t ccrc = modbus_crc16(resp, 6);
  if (rcrc != ccrc) return false;
  if (resp[0] != slave || resp[1] != 0x06) return false;
  if (resp[2] != req[2] || resp[3] != req[3]) return false;
  return true;
}

// Evo2 encapsulation constants (from Generator)
static const uint8_t EVO2_IV[16] = {0xC0,0x94,0xFB,0xEB,0xF5,0x96,0x43,0x7F,0xA2,0x2E,0xFA,0x84,0xFC,0xC5,0x21,0x52};
static const uint8_t EVO2_KEYS[16][16] = {
 {0x4A,0x2A,0xA3,0xE4,0x7E,0xE0,0x42,0x2C,0xA4,0xBC,0x8D,0x1D,0x52,0xDE,0xD9,0x69},
 {0xEE,0xFA,0x10,0x27,0x80,0xE7,0x4F,0x03,0xB7,0xD0,0x32,0x58,0xC4,0xD7,0xF8,0xE5},
 {0xFD,0x79,0xA9,0xCF,0xCF,0x94,0x40,0x1D,0x9A,0x65,0xA4,0x7C,0x97,0xB3,0x0C,0xC2},
 {0x55,0x99,0xF2,0xFB,0x0D,0x70,0x49,0x1A,0xBC,0x85,0xF4,0x58,0x9E,0xC1,0x11,0x48},
 {0xDB,0xCF,0x82,0x6F,0x42,0xE8,0x41,0xDE,0xBD,0x64,0xBB,0xAC,0x16,0xFB,0xB4,0xD3},
 {0x84,0xA1,0xA5,0xF7,0x26,0xA3,0x47,0xFE,0x8A,0x0F,0xB5,0xF1,0xC1,0x9E,0xA3,0xCF},
 {0x20,0x9C,0xD8,0xDF,0xAB,0x2E,0x47,0x3E,0xA2,0xBF,0xFE,0xEA,0xC1,0xD4,0x87,0x8E},
 {0xEF,0xA6,0x7A,0xD0,0x81,0xBC,0x42,0xEB,0xB4,0xDE,0x51,0xAE,0x1A,0x04,0x73,0xA7},
 {0x17,0x3E,0x13,0x55,0x77,0xC3,0x4D,0x46,0xAB,0x2C,0x5A,0xD7,0x95,0x25,0xE7,0x62},
 {0xCC,0x8D,0x8F,0x2A,0x3B,0x1B,0x44,0x96,0xBD,0x8B,0x78,0x78,0xF8,0xB2,0xAF,0x43},
 {0xA8,0x50,0x14,0xDD,0xE5,0x38,0x42,0xDD,0xA5,0xE9,0xA9,0xAD,0xB1,0xD4,0x84,0xAE},
 {0x24,0x43,0xCE,0xF9,0x55,0xCC,0x42,0xDA,0x95,0x77,0xF9,0xED,0xEA,0xE4,0x1A,0xA1},
 {0x3A,0xC2,0x6F,0x6A,0xFE,0x08,0x40,0xC1,0x80,0x46,0x39,0x95,0x69,0x1D,0x85,0x2E},
 {0xA2,0x42,0x7B,0x25,0x57,0x05,0x43,0x35,0xB4,0x79,0x0A,0x64,0x66,0x00,0x07,0xF6},
 {0xFD,0xB5,0xCF,0x6C,0x7D,0xE6,0x42,0xA7,0x92,0xB4,0x3C,0xC9,0xC7,0x7B,0x92,0x57},
 {0xC7,0x39,0x70,0xD5,0xFC,0xCA,0x43,0x0C,0x8E,0xCD,0xEA,0x54,0xAF,0x88,0xA3,0x67}
};

static void nybble_swap(uint8_t* buf, size_t len) {
  for (size_t i=0;i<len;i++) buf[i] = (uint8_t)(((buf[i] & 0x0F) << 4) | ((buf[i] & 0xF0) >> 4));
}

// Build raw Modbus write-single packet (address, func, reg, val, crc) for encapsulation
static size_t buildWriteSingleFrame(uint8_t slave, uint16_t reg, uint16_t value, uint8_t* out) {
  out[0] = slave;
  out[1] = 0x06;
  out[2] = (uint8_t)(reg >> 8);
  out[3] = (uint8_t)(reg & 0xFF);
  out[4] = (uint8_t)(value >> 8);
  out[5] = (uint8_t)(value & 0xFF);
  uint16_t crc = modbus_crc16(out, 6);
  out[6] = (uint8_t)(crc & 0xFF);
  out[7] = (uint8_t)(crc >> 8);
  return 8;
}

static bool evo2_unlock_and_send(const uint8_t* master_pkt, size_t master_len) {
  // Pad master packet to minimum 32 bytes and block multiple
  uint8_t mp[64] = {0};
  size_t padded = master_len;
  if (padded < 32) padded = 32;
  if (padded % 16) padded = (padded + 15) & ~((size_t)15);
  if (padded > sizeof(mp)) padded = sizeof(mp);
  memcpy(mp, master_pkt, master_len);

  // Encrypt MP
  aes128_cbc_encrypt(mp, padded, EVO2_KEYS[0], EVO2_IV);

  // Frame A (SN + encrypted master) with prefix 0xF1 0x01
  uint8_t sn[16] = {0x00,0x00,0x00,0x05,0x06,0x02,0x04,0x04,0x01,0xE3,0x00,0x00,0x00,0x00,0x00,0x00};
  uint8_t frameA[2 + 16 + 64] = {0};
  frameA[0] = 0xF1; frameA[1] = 0x01;
  memcpy(frameA + 2, sn, 16);
  size_t fa_len = 2 + 16 + padded;
  memcpy(frameA + 18, mp, padded);
  nybble_swap(frameA, fa_len);
  if (!modbusWriteRegisters(GEN_MODBUS_ID, 0xEA60, frameA, (uint16_t)fa_len)) return false;

  // Frame B (encrypted master only) with prefix 0xF1 0x02
  uint8_t frameB[2 + 64] = {0};
  frameB[0] = 0xF1; frameB[1] = 0x02;
  memcpy(frameB + 2, mp, padded);
  size_t fb_len = 2 + padded;
  nybble_swap(frameB, fb_len);
  if (!modbusWriteRegisters(GEN_MODBUS_ID, 0xEA60, frameB, (uint16_t)fb_len)) return false;

  return true;
}

static bool modbusWriteRegisterAuto(uint8_t slave, uint16_t reg, uint16_t value) {
  // Try plain first unless GEN_EVO2 is forced
  if (!GEN_EVO2) {
    return modbusWriteRegister(slave, reg, value);
  }
  // Build master packet
  uint8_t pkt[8];
  size_t plen = buildWriteSingleFrame(slave, reg, value, pkt);
  if (evo2_unlock_and_send(pkt, plen)) return true;
  // Fallback: try plain
  return modbusWriteRegister(slave, reg, value);
}
// Modbus RTU write multiple registers (function 0x10)
static bool modbusWriteRegisters(uint8_t slave, uint16_t reg, const uint8_t* data_bytes, uint16_t byte_len) {
  if (byte_len == 0 || (byte_len % 2) != 0) return false;
  uint16_t qty = byte_len / 2;
  uint8_t hdr_len = 7;
  uint8_t buf[7 + 2 + 252]; // addr func reg(2) qty(2) bytecnt + data + crc(2)
  buf[0] = slave;
  buf[1] = 0x10;
  buf[2] = (uint8_t)(reg >> 8);
  buf[3] = (uint8_t)(reg & 0xFF);
  buf[4] = (uint8_t)(qty >> 8);
  buf[5] = (uint8_t)(qty & 0xFF);
  buf[6] = (uint8_t)byte_len;
  memcpy(buf + 7, data_bytes, byte_len);
  uint16_t crc = modbus_crc16(buf, 7 + byte_len);
  buf[7 + byte_len] = (uint8_t)(crc & 0xFF);
  buf[7 + byte_len + 1] = (uint8_t)(crc >> 8);

  while (GEN_SERIAL.available()) GEN_SERIAL.read();
  GEN_SERIAL.write(buf, 7 + byte_len + 2);
  GEN_SERIAL.flush();

  const uint32_t start_ms = millis();
  // Response echo is 8 bytes: addr func reg qty crc
  uint8_t resp[8] = {0};
  size_t idx = 0;
  while ((millis() - start_ms) < GEN_MODBUS_RX_TIMEOUT_MS) {
    while (GEN_SERIAL.available()) {
      resp[idx++] = (uint8_t)GEN_SERIAL.read();
      if (idx >= sizeof(resp)) break;
    }
    if (idx >= sizeof(resp)) break;
    delayMicroseconds(300);
  }
  if (idx < sizeof(resp)) return false;
  uint16_t rcrc = (uint16_t)resp[7] << 8 | resp[6];
  uint16_t ccrc = modbus_crc16(resp, 6);
  if (rcrc != ccrc) return false;
  if (resp[0] != slave || resp[1] != 0x10) return false;
  if (resp[2] != buf[2] || resp[3] != buf[3]) return false;
  return true;
}

// Generac indexed write helper (mirrors Generator WriteIndexedRegister)
static bool genIndexedCommand(uint16_t reg, bool hasValue, uint16_t value) {
  // If value present, write it to register 0x0004, then write target register to 0x0003
  if (hasValue) {
    if (!modbusWriteRegisterAuto(GEN_MODBUS_ID, 0x0004, value)) return false;
  }
  return modbusWriteRegisterAuto(GEN_MODBUS_ID, 0x0003, reg);
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

// ------------------------- GENERAC POLL -------------------------
// Minimal Modbus RTU poll of core registers using Generator register map.
// This is intentionally lean but provides real telemetry for the RS485 bridge.

static uint32_t g_last_gen_poll_ms = 0;
static uint8_t  g_gen_baud_mode = 0; // 0=9600 (Modbus default), 1=115200 (legacy/alt)

static void setGenBaud(uint8_t mode) {
  g_gen_baud_mode = mode;
  GEN_SERIAL.end();
  delay(20);
  GEN_SERIAL.begin((mode == 0) ? GEN_MODBUS_BAUD : GEN_BAUD_1);
}

static bool parseGeneracFrame(const uint8_t* buf, size_t len) {
  // Placeholder kept for future expanded protocol support.
  (void)buf; (void)len;
  return false;
}

// Read a handful of base registers defined in Generator's Evolution map.
static void pollGenerac() {
  // Registers:
  // 0x0007 RPM
  // 0x0008 Frequency (0.1 Hz units)
  // 0x0009 Utility Voltage (V)
  // 0x000A Battery Voltage (0.1 V)
  // 0x000B/0x000C Run Hours (hi/lo)
  // 0x0012 Generator Output Voltage (V)

  uint16_t regs[8] = {0};
  bool ok = modbusReadRegisters(GEN_MODBUS_ID, 0x0007, 6, regs, 8);
  bool ok_vout = false;
  uint16_t reg_vout = 0;

  if (ok) {
    ok_vout = modbusReadRegisters(GEN_MODBUS_ID, 0x0012, 1, &reg_vout, 1);
  } else {
    // If first block failed, still try voltage-only read in case controller limits block size.
    ok_vout = modbusReadRegisters(GEN_MODBUS_ID, 0x0012, 1, &reg_vout, 1);
  }

  if (!ok && !ok_vout) {
    return; // no valid data
  }

  uint32_t now_ms = millis();

  if (ok) {
    uint16_t rpm = regs[0];
    uint16_t hz_tenths = regs[1];
    uint16_t util_v = regs[2];
    uint16_t batt_tenths = regs[3];
    uint32_t run_hours = ((uint32_t)regs[4] << 16) | regs[5];

    g_t.rpm = rpm;
    g_t.hz_x100 = (uint16_t)(hz_tenths * 10); // 0.1 Hz -> x100
    g_t.util_v_l1_x10 = (uint16_t)(util_v * 10);
    g_t.util_v_l2_x10 = g_t.util_v_l1_x10;
    g_t.batt_mv = (uint16_t)(batt_tenths * 100); // 0.1 V -> mV
    g_t.run_seconds = run_hours * 3600UL;

    // Simple state/mode inference
    if (rpm > 0) {
      g_t.state = GEN_RUNNING;
      g_t.mode  = MODE_AUTO; // best-effort guess
    } else {
      g_t.state = GEN_STOPPED;
      g_t.mode  = MODE_AUTO;
    }

    g_last_ctrl_good_ms = now_ms;
  }

  if (ok_vout) {
    uint16_t gv = reg_vout;
    uint16_t gv_x10 = (uint16_t)(gv * 10); // volts -> x10
    g_t.gen_v_l1_x10 = gv_x10;
    g_t.gen_v_l2_x10 = gv_x10;
  }
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
  // remote start -> indexed register 0x0001
  return genIndexedCommand(0x0001, false, 0);
}
bool genCommandStop() {
  // remote stop -> indexed register 0x0000
  return genIndexedCommand(0x0000, false, 0);
}
bool genCommandExercise(bool withTransfer) {
  // 0x0003 = exercise (quiet), 0x0002 = start + transfer
  uint16_t reg = withTransfer ? 0x0002 : 0x0003;
  return genIndexedCommand(reg, false, 0);
}
bool genCommandClearAlarm() {
  // reset alarm -> indexed register 0x000D
  return genIndexedCommand(0x000D, false, 0);
}
bool genCommandSetMode(uint16_t mode) {
  // 1=OFF -> 0x0010, 2=AUTO -> 0x000F, 3=MANUAL -> 0x000E
  uint16_t reg = 0;
  if (mode == 1) reg = 0x0010;
  else if (mode == 2) reg = 0x000F;
  else if (mode == 3) reg = 0x000E;
  else return false;
  return genIndexedCommand(reg, false, 0);
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
  // expose controller type in flags (bit0=plain, bit1=evo2)
  uint16_t f = g_t.flags & ~0x3;
  if (g_gen_type == GEN_TYPE_PLAIN) f |= 0x1;
  else if (g_gen_type == GEN_TYPE_EVO2) f |= 0x2;
  g_t.flags = f;
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
  GEN_SERIAL.begin(GEN_MODBUS_BAUD); // default to 9600 Modbus maintenance port

  ctAccumReset(acc_l1);
  ctAccumReset(acc_l2);

  // Initialize defaults
  g_t.state = GEN_UNKNOWN;
  g_t.mode  = MODE_UNKNOWN;
  g_t.flags = 0;

  g_last_ctrl_good_ms = 0;

  detect_controller_type();
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

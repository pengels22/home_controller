#include <Arduino.h>
#include <Wire.h>
#include <Adafruit_MCP4728.h>

/*
  RP2040 AIO Module
  - RS-485 via MAX13487E (AutoDirection, no DIR pin)
  - UART: TX=P0, RX=P1
  - Address: 0x40 + DIP(3-bit)
      DIP order: P26(bit0), P27(bit1), P2(bit2)
      pullups; switch ON pulls LOW => bit=1
  - Sense (opto, ACTIVE-HIGH):
      P28 HIGH => allow channels 0..7 (AI)
      P29 HIGH => allow channels 8..15 (AO)
      If LOW => that bank forced to 0 / writes ignored; AO bank forced OFF
  - AI: ADS7828 (8ch 12-bit)  channels 0..7
  - AO: 2x MCP4728 (8ch 12-bit) channels 8..15
      AO0..3 -> DAC1 A..D
      AO4..7 -> DAC2 A..D

  Request frame (7 bytes): [0xAA][addr][ch][cmd][d0][d1][crc]
    value12 = d0 | ((d1 & 0x0F) << 8)
    crc = XOR of first 6 bytes

  Reply frame (8 bytes): [0x55][addr][ch][cmd][d0][d1][senseMask][crc]
    crc = XOR of first 7 bytes
    senseMask bit0=sense1(P28), bit1=sense2(P29)

  cmd:
    0x00 READ  (AI or AO)
    0x01 WRITE (AO only; AI writes ignored)
*/

static const uint8_t BASE_ADDR = 0x40;  // <-- confirmed

// DIP switches
static const int PIN_DIP0 = 26;
static const int PIN_DIP1 = 27;
static const int PIN_DIP2 = 2;

// Sense lines
static const int PIN_SENSE1 = 28;
static const int PIN_SENSE2 = 29;

// RS485 UART
static HardwareSerial &RS485 = Serial1;
static const uint32_t RS485_BAUD = 115200;
static const int PIN_UART_TX = 0; // P0
static const int PIN_UART_RX = 1; // P1

// I2C addresses (adjust if strapped differently)
static const uint8_t ADS7828_ADDR = 0x48;
static const uint8_t DAC1_ADDR    = 0x60;
static const uint8_t DAC2_ADDR    = 0x61;

// Protocol
static const uint8_t PREAMBLE       = 0xAA;
static const uint8_t REPLY_PREAMBLE = 0x55;
static const uint8_t CMD_READ       = 0x00;
static const uint8_t CMD_WRITE      = 0x01;

static const uint8_t CH_AI_MIN = 0;
static const uint8_t CH_AI_MAX = 7;
static const uint8_t CH_AO_MIN = 8;
static const uint8_t CH_AO_MAX = 15;

// Globals
static uint8_t deviceAddr = 0;

Adafruit_MCP4728 dac1;
Adafruit_MCP4728 dac2;

static uint16_t ao_set[8] = {0}; // cached AO setpoints (0..4095)

// RX state machine
static uint8_t rx_state = 0;
static uint8_t b_addr=0, b_ch=0, b_cmd=0, b_d0=0, b_d1=0, b_crc=0;

// CRC helpers
static inline uint8_t xcrc6(uint8_t b0,uint8_t b1,uint8_t b2,uint8_t b3,uint8_t b4,uint8_t b5) {
  return (uint8_t)(b0 ^ b1 ^ b2 ^ b3 ^ b4 ^ b5);
}
static inline uint8_t xcrc7(uint8_t b0,uint8_t b1,uint8_t b2,uint8_t b3,uint8_t b4,uint8_t b5,uint8_t b6) {
  return (uint8_t)(b0 ^ b1 ^ b2 ^ b3 ^ b4 ^ b5 ^ b6);
}

static uint8_t readDip3() {
  uint8_t b0 = (digitalRead(PIN_DIP0) == LOW) ? 1 : 0;
  uint8_t b1 = (digitalRead(PIN_DIP1) == LOW) ? 1 : 0;
  uint8_t b2 = (digitalRead(PIN_DIP2) == LOW) ? 1 : 0;
  return (uint8_t)((b0<<0) | (b1<<1) | (b2<<2));
}

static inline bool sense1High(){ return digitalRead(PIN_SENSE1) == HIGH; }
static inline bool sense2High(){ return digitalRead(PIN_SENSE2) == HIGH; }

static inline uint8_t senseMask() {
  return (sense1High() ? 0x01 : 0x00) | (sense2High() ? 0x02 : 0x00);
}

static inline bool bankAllowed(uint8_t ch) {
  return (ch < 8) ? sense1High() : sense2High();
}

static inline uint16_t clamp12(uint16_t v) { return (v > 4095) ? 4095 : v; }

static inline uint16_t pack12(uint8_t d0, uint8_t d1) {
  return (uint16_t)(d0 | ((uint16_t)(d1 & 0x0F) << 8));
}
static inline void unpack12(uint16_t v, uint8_t &d0, uint8_t &d1) {
  v = clamp12(v);
  d0 = (uint8_t)(v & 0xFF);
  d1 = (uint8_t)((v >> 8) & 0x0F);
}

// ADS7828 single-ended read (12-bit)
static uint16_t ads7828Read(uint8_t ch) {
  ch &= 0x07;
  // SD=1 single-ended, C2..C0=ch, PD1..PD0=11 no power-down
  uint8_t cmd = (uint8_t)(0x80 | (ch << 4) | 0x0C);

  Wire.beginTransmission(ADS7828_ADDR);
  Wire.write(cmd);
  if (Wire.endTransmission(false) != 0) return 0;

  if (Wire.requestFrom((int)ADS7828_ADDR, 2) != 2) return 0;

  uint8_t msb = Wire.read();
  uint8_t lsb = Wire.read();
  uint16_t raw16 = (uint16_t)((msb << 8) | lsb);
  return (raw16 >> 4) & 0x0FFF; // left-justified -> 12-bit
}

static bool setDacChannel(uint8_t ao_index /*0..7*/, uint16_t value12) {
  value12 = clamp12(value12);
  ao_set[ao_index] = value12;

  // If sense2 drops, we drive 0 anyway
  if (!sense2High()) value12 = 0;

  Adafruit_MCP4728 *d = (ao_index < 4) ? &dac1 : &dac2;
  uint8_t ch = ao_index % 4;

  MCP4728_channel_t c =
    (ch == 0) ? MCP4728_CHANNEL_A :
    (ch == 1) ? MCP4728_CHANNEL_B :
    (ch == 2) ? MCP4728_CHANNEL_C :
                MCP4728_CHANNEL_D;

  return d->setChannelValue(c, value12);
}

static void forceAllAOOff() {
  for (uint8_t i = 0; i < 8; i++) {
    Adafruit_MCP4728 *d = (i < 4) ? &dac1 : &dac2;
    uint8_t ch = i % 4;

    MCP4728_channel_t c =
      (ch == 0) ? MCP4728_CHANNEL_A :
      (ch == 1) ? MCP4728_CHANNEL_B :
      (ch == 2) ? MCP4728_CHANNEL_C :
                  MCP4728_CHANNEL_D;

    d->setChannelValue(c, 0);
  }
}

static void clearAOcache() {
  for (uint8_t i = 0; i < 8; i++) ao_set[i] = 0;
}

static void sendReply(uint8_t addr, uint8_t ch, uint8_t cmd, uint16_t value12) {
  uint8_t d0, d1;
  unpack12(value12, d0, d1);
  uint8_t sm  = senseMask();
  uint8_t crc = xcrc7(REPLY_PREAMBLE, addr, ch, cmd, d0, d1, sm);

  uint8_t pkt[8] = { REPLY_PREAMBLE, addr, ch, cmd, d0, d1, sm, crc };
  RS485.write(pkt, sizeof(pkt));
  RS485.flush();
}

static void handleRequest(uint8_t addr, uint8_t ch, uint8_t cmd, uint16_t value12) {
  if (addr != deviceAddr) return;

  // Split-bank gating: if bank not allowed, report 0 and ignore writes
  if (!bankAllowed(ch)) {
    sendReply(addr, ch, cmd, 0);
    return;
  }

  // AI 0..7
  if (ch <= CH_AI_MAX) {
    if (cmd == CMD_READ) {
      uint16_t v = ads7828Read(ch);
      sendReply(addr, ch, cmd, v);
    } else {
      // Ignore writes to AI
      sendReply(addr, ch, cmd, 0);
    }
    return;
  }

  // AO 8..15
  if (ch >= CH_AO_MIN && ch <= CH_AO_MAX) {
    uint8_t ao_index = (uint8_t)(ch - CH_AO_MIN);

    if (cmd == CMD_READ) {
      // Report cached setpoint (0 if bank gating handled above)
      sendReply(addr, ch, cmd, ao_set[ao_index]);
      return;
    }

    if (cmd == CMD_WRITE) {
      setDacChannel(ao_index, value12);
      sendReply(addr, ch, cmd, ao_set[ao_index]);
      return;
    }

    sendReply(addr, ch, cmd, 0);
    return;
  }

  // Unknown channel
  sendReply(addr, ch, cmd, 0);
}

void setup() {
  Serial.begin(115200);
  delay(150);

  pinMode(PIN_DIP0, INPUT_PULLUP);
  pinMode(PIN_DIP1, INPUT_PULLUP);
  pinMode(PIN_DIP2, INPUT_PULLUP);

  pinMode(PIN_SENSE1, INPUT_PULLUP);
  pinMode(PIN_SENSE2, INPUT_PULLUP);

  deviceAddr = (uint8_t)(BASE_ADDR + readDip3());

  Wire.begin();

  // Init DACs (safe if one missing; you’ll see a Serial warning)
  if (!dac1.begin(DAC1_ADDR, &Wire)) Serial.println("WARN: DAC1 not found");
  if (!dac2.begin(DAC2_ADDR, &Wire)) Serial.println("WARN: DAC2 not found");

  // Safe boot: clear cache and force outputs to 0
  clearAOcache();
  forceAllAOOff();

  RS485.setTX(PIN_UART_TX);
  RS485.setRX(PIN_UART_RX);
  RS485.begin(RS485_BAUD);

  Serial.printf("AIO boot: addr=0x%02X senseMask=0x%02X\n", deviceAddr, senseMask());
}

void loop() {
  // If AO bank loses power, force outputs off and drop cached setpoints
  static bool sense2_prev = false;
  bool sense2_now = sense2High();
  if (!sense2_now) {
    if (sense2_prev) {
      clearAOcache();   // require fresh writes after power/sense loss
    }
    forceAllAOOff();
  }
  sense2_prev = sense2_now;

  // Parse request: [AA][addr][ch][cmd][d0][d1][crc]
  while (RS485.available() > 0) {
    int bi = RS485.read();
    if (bi < 0) break;
    uint8_t b = (uint8_t)bi;

    switch (rx_state) {
      case 0: if (b == PREAMBLE) rx_state = 1; break;
      case 1: b_addr = b; rx_state = 2; break;
      case 2: b_ch   = b; rx_state = 3; break;
      case 3: b_cmd  = b; rx_state = 4; break;
      case 4: b_d0   = b; rx_state = 5; break;
      case 5: b_d1   = b; rx_state = 6; break;
      case 6:
        b_crc = b;
        if (b_crc == xcrc6(PREAMBLE, b_addr, b_ch, b_cmd, b_d0, b_d1)) {
          uint16_t v12 = pack12(b_d0, b_d1);
          handleRequest(b_addr, b_ch, b_cmd, v12);
        }
        rx_state = 0;
        break;
      default:
        rx_state = 0;
        break;
    }
  }

  delay(2);
}

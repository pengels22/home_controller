#include <Arduino.h>
#include <Wire.h>
#include <Adafruit_MCP23X17.h>

// ---------------- Address ----------------
static const uint8_t BASE_ADDR = 0x20; // DI base

// DIP: P26=bit0, P27=bit1, P2=bit2 (pullups; ON pulls LOW => bit=1)
static const int PIN_DIP0 = 26;
static const int PIN_DIP1 = 27;
static const int PIN_DIP2 = 2;

// Sense (ACTIVE-HIGH opto): P28 bank 0..7, P29 bank 8..15
static const int PIN_SENSE1 = 28;
static const int PIN_SENSE2 = 29;

// ---------------- RS485 (MAX13487E AutoDirection) ----------------
static HardwareSerial &RS485 = Serial1;
static const uint32_t RS485_BAUD = 115200;
static const int PIN_UART_TX = 0; // P0
static const int PIN_UART_RX = 1; // P1

// ---------------- MCP23017 ----------------
static const uint8_t MCP_ADDR = 0x20;
Adafruit_MCP23X17 mcp;

static const bool INPUTS_ACTIVE_LOW = false; // your optos are active-high
static const bool MCP_PULLUPS_ENABLE = false;

// ---------------- Protocol ----------------
static const uint8_t PREAMBLE = 0xAA;
static const uint8_t REPLY_PREAMBLE = 0x55;

static const uint8_t CMD_READ = 0x00;

// Special channels for 16-bit read in 2 polls:
static const uint8_t CH_READ_LO = 0xFE; // returns inputs 0..7 in data
static const uint8_t CH_READ_HI = 0xFF; // returns inputs 8..15 in data

static inline uint8_t xcrc4(uint8_t b0, uint8_t b1, uint8_t b2, uint8_t b3) {
  return (uint8_t)(b0 ^ b1 ^ b2 ^ b3);
}
static inline uint8_t xcrc5(uint8_t b0, uint8_t b1, uint8_t b2, uint8_t b3, uint8_t b4) {
  return (uint8_t)(b0 ^ b1 ^ b2 ^ b3 ^ b4);
}

// ---------------- Internal ----------------
static uint8_t deviceAddr = 0;

// RX state machine
static uint8_t rx_state = 0;
static uint8_t addr_b = 0, ch_b = 0, cmd_b = 0, crc_b = 0;

static uint8_t readDip3() {
  uint8_t b0 = (digitalRead(PIN_DIP0) == LOW) ? 1 : 0;
  uint8_t b1 = (digitalRead(PIN_DIP1) == LOW) ? 1 : 0;
  uint8_t b2 = (digitalRead(PIN_DIP2) == LOW) ? 1 : 0;
  return (uint8_t)((b0 << 0) | (b1 << 1) | (b2 << 2));
}

static inline bool sense1High() { return digitalRead(PIN_SENSE1) == HIGH; }
static inline bool sense2High() { return digitalRead(PIN_SENSE2) == HIGH; }

static inline uint8_t senseMask() {
  return (sense1High() ? 0x01 : 0x00) | (sense2High() ? 0x02 : 0x00);
}

static inline bool bankAllowed(uint8_t ch) {
  return (ch < 8) ? sense1High() : sense2High();
}

static uint16_t fastReadAllRaw() {
  return mcp.readGPIOAB(); // bit0..15 = ch0..15
}

static uint8_t readInputCh(uint8_t ch) {
  if (ch >= 16) return 0;
  if (!bankAllowed(ch)) return 0;

  uint16_t v = fastReadAllRaw();
  bool val = ((v >> ch) & 0x1) != 0;
  if (INPUTS_ACTIVE_LOW) val = !val;
  return val ? 1 : 0;
}

// Build a gated 16-bit bitmap then extract bytes
static uint16_t readAllBitmapGated() {
  uint16_t v = fastReadAllRaw();
  if (INPUTS_ACTIVE_LOW) v = (uint16_t)~v;

  if (!sense1High()) v &= 0xFF00; // clear 0..7
  if (!sense2High()) v &= 0x00FF; // clear 8..15

  return v;
}

static void sendReply(uint8_t addr, uint8_t ch, uint8_t data) {
  uint8_t sm = senseMask();
  uint8_t c = xcrc5(REPLY_PREAMBLE, addr, ch, data, sm);
  uint8_t pkt[6] = { REPLY_PREAMBLE, addr, ch, data, sm, c };
  RS485.write(pkt, sizeof(pkt));
  RS485.flush();
}

static void handleRequest(uint8_t addr, uint8_t ch, uint8_t cmd) {
  if (addr != deviceAddr) return;
  if (cmd != CMD_READ) return;

  uint8_t data = 0;

  if (ch == CH_READ_LO || ch == CH_READ_HI) {
    uint16_t bm = readAllBitmapGated();
    data = (ch == CH_READ_LO) ? (uint8_t)(bm & 0xFF) : (uint8_t)((bm >> 8) & 0xFF);
    sendReply(addr, ch, data);
    return;
  }

  // single channel read
  if (ch < 16) data = readInputCh(ch);
  sendReply(addr, ch, data);
}

static void initMcpInputs() {
  for (uint8_t ch = 0; ch < 16; ch++) {
    mcp.pinMode(ch, INPUT);
    if (MCP_PULLUPS_ENABLE) mcp.pullUp(ch, HIGH);
  }
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
  if (!mcp.begin_I2C(MCP_ADDR, &Wire)) {
    Serial.println("ERROR: MCP23017 not found. Halting.");
    while (true) delay(500);
  }
  initMcpInputs();

  RS485.setTX(PIN_UART_TX);
  RS485.setRX(PIN_UART_RX);
  RS485.begin(RS485_BAUD);

  Serial.printf("DI boot: addr=0x%02X senseMask=0x%02X\n", deviceAddr, senseMask());
}

void loop() {
  // Parse request: [AA][addr][ch][cmd][crc]
  while (RS485.available() > 0) {
    int bi = RS485.read();
    if (bi < 0) break;
    uint8_t b = (uint8_t)bi;

    switch (rx_state) {
      case 0: if (b == PREAMBLE) rx_state = 1; break;
      case 1: addr_b = b; rx_state = 2; break;
      case 2: ch_b   = b; rx_state = 3; break;
      case 3: cmd_b  = b; rx_state = 4; break;
      case 4:
        crc_b = b;
        if (crc_b == xcrc4(PREAMBLE, addr_b, ch_b, cmd_b)) {
          handleRequest(addr_b, ch_b, cmd_b);
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
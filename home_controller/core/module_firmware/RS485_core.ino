#include <Arduino.h>
#include <SPI.h>

/*
  ============================================================
  RP2040 RS485 EXPANSION MODULE
  ============================================================

  Based on your schematic:
    - Upstream RS485: direct to XIAO RP2040 via MAX13487E
      TX = P0
      RX = P1

    - Two SC16IS752 dual SPI->UART bridges:
      U1 = buses 0 and 1
      U2 = buses 2 and 3

      Bus 0 = U1 channel A -> MAX13487E U3 -> 1A/1B
      Bus 1 = U1 channel B -> MAX13487E U4 -> 2A/2B
      Bus 2 = U2 channel A -> MAX13487E U6 -> 3A/3B
      Bus 3 = U2 channel B -> MAX13487E U12 -> 4A/4B

    - SPI wiring:
      MOSI = P3
      MISO = P4
      SCK  = P2
      CS1  = P28  (U1)
      CS2  = P29  (U2)

    - Address DIP:
      P26 = bit0
      P27 = bit1
      (third DIP is not available separately because P2 is used for SPI SCK
       on this board, so this firmware uses only 2 DIP bits unless you later
       rework hardware)

  Module RS485 address:
    0x50 + DIP(2-bit currently implemented from P26/P27)

  Upstream request frame:
    [0xAA][module_addr][bus][len][payload...][crc]

  Upstream reply frame:
    [0x55][module_addr][bus][len][payload...][status][crc]

  CRC:
    XOR of all prior bytes in the frame

  Notes:
    - This is a transparent router. It forwards raw downstream packets.
    - The downstream module protocols remain unchanged.
    - Since the SC16IS752 has 64-byte FIFOs, keep payloads reasonably sized.
*/

// ---------------- User-config ----------------
static const uint8_t BASE_ADDR = 0x50;

static const int PIN_DIP0 = 26;   // bit0
static const int PIN_DIP1 = 27;   // bit1
// P2 is SPI SCK on this board, so not used as DIP here

static const int PIN_UP_TX = 0;   // XIAO TX -> upstream MAX13487E DI
static const int PIN_UP_RX = 1;   // XIAO RX <- upstream MAX13487E RO

static const int PIN_SPI_SCK  = 2;
static const int PIN_SPI_MOSI = 3;
static const int PIN_SPI_MISO = 4;

static const int PIN_CS1 = 28;    // U1 SC16IS752
static const int PIN_CS2 = 29;    // U2 SC16IS752

static const uint32_t UP_BAUD = 115200;
static const uint32_t DOWN_BAUD = 115200;
static const uint32_t SPI_HZ = 4000000;

static const size_t MAX_PAYLOAD = 96;
static const uint16_t DOWNSTREAM_REPLY_TIMEOUT_MS = 60;
static const uint16_t DOWNSTREAM_INTERBYTE_GAP_MS = 4;
static const uint16_t BUS_WRITE_TIMEOUT_MS = 20; // fail fast if a UART FIFO never frees

// ---------------- Upstream serial ----------------
static HardwareSerial &UP = Serial1;

// ---------------- Status codes ----------------
enum StatusCode : uint8_t {
  ST_OK        = 0x00,
  ST_BAD_BUS   = 0x01,
  ST_TIMEOUT   = 0x02,
  ST_BAD_CRC   = 0x03,
  ST_TOO_LONG  = 0x04
};

// ---------------- SC16IS752 register defs ----------------
// Common UART registers
static const uint8_t REG_RHR    = 0x00; // read
static const uint8_t REG_THR    = 0x00; // write
static const uint8_t REG_IER    = 0x01;
static const uint8_t REG_FCR    = 0x02; // write
static const uint8_t REG_IIR    = 0x02; // read
static const uint8_t REG_LCR    = 0x03;
static const uint8_t REG_MCR    = 0x04;
static const uint8_t REG_LSR    = 0x05;
static const uint8_t REG_MSR    = 0x06;
static const uint8_t REG_SPR    = 0x07;
static const uint8_t REG_TXLVL  = 0x08;
static const uint8_t REG_RXLVL  = 0x09;
static const uint8_t REG_IOCTRL = 0x0E;
static const uint8_t REG_EFCR   = 0x0F;

// Divisor latch regs when LCR[7]=1
static const uint8_t REG_DLL    = 0x00;
static const uint8_t REG_DLH    = 0x01;

// Channel IDs per datasheet
static const uint8_t CH_A = 0x00;
static const uint8_t CH_B = 0x01;

// ---------------- Bus mapping ----------------
struct BusMap {
  uint8_t csPin;
  uint8_t channel;
};

static const BusMap BUS_MAP[4] = {
  { PIN_CS1, CH_A }, // bus 0 = U1A
  { PIN_CS1, CH_B }, // bus 1 = U1B
  { PIN_CS2, CH_A }, // bus 2 = U2A
  { PIN_CS2, CH_B }  // bus 3 = U2B
};

// ---------------- Globals ----------------
static uint8_t g_moduleAddr = 0;

// Parser state
enum RxState : uint8_t {
  RX_WAIT_PREAMBLE = 0,
  RX_ADDR,
  RX_BUS,
  RX_LEN,
  RX_PAYLOAD,
  RX_CRC
};

static RxState rxState = RX_WAIT_PREAMBLE;
static uint8_t rxAddr = 0;
static uint8_t rxBus = 0;
static uint8_t rxLen = 0;
static uint8_t rxPayload[MAX_PAYLOAD];
static uint8_t rxIndex = 0;

// Bus error tracking
static uint16_t g_bus_err[4] = {0, 0, 0, 0};
static uint8_t g_bus_last_status[4] = {ST_OK, ST_OK, ST_OK, ST_OK};

// ============================================================
// Helpers
// ============================================================

static uint8_t readDip2() {
  uint8_t b0 = (digitalRead(PIN_DIP0) == LOW) ? 1 : 0;
  uint8_t b1 = (digitalRead(PIN_DIP1) == LOW) ? 1 : 0;
  return (uint8_t)((b0 << 0) | (b1 << 1));
}

static uint8_t crcXor(const uint8_t *buf, size_t len) {
  uint8_t c = 0;
  for (size_t i = 0; i < len; i++) c ^= buf[i];
  return c;
}

static void resetParser() {
  rxState = RX_WAIT_PREAMBLE;
  rxAddr = 0;
  rxBus = 0;
  rxLen = 0;
  rxIndex = 0;
}

// ============================================================
// SC16IS752 SPI access
// Datasheet SPI register address byte:
//   bit7   = R/W (1=read, 0=write)
//   bits6:3= register
//   bits2:1= channel (00=A, 01=B)
//   bit0   = 0
// ============================================================

static uint8_t scAddrByte(uint8_t reg, uint8_t channel, bool readOp) {
  return (uint8_t)((readOp ? 0x80 : 0x00) |
                   ((reg & 0x0F) << 3) |
                   ((channel & 0x03) << 1));
}

static uint8_t scReadReg(uint8_t csPin, uint8_t channel, uint8_t reg) {
  SPI.beginTransaction(SPISettings(SPI_HZ, MSBFIRST, SPI_MODE0));
  digitalWrite(csPin, LOW);
  SPI.transfer(scAddrByte(reg, channel, true));
  uint8_t v = SPI.transfer(0x00);
  digitalWrite(csPin, HIGH);
  SPI.endTransaction();
  return v;
}

static void scWriteReg(uint8_t csPin, uint8_t channel, uint8_t reg, uint8_t value) {
  SPI.beginTransaction(SPISettings(SPI_HZ, MSBFIRST, SPI_MODE0));
  digitalWrite(csPin, LOW);
  SPI.transfer(scAddrByte(reg, channel, false));
  SPI.transfer(value);
  digitalWrite(csPin, HIGH);
  SPI.endTransaction();
}

static void scWriteFIFO(uint8_t csPin, uint8_t channel, const uint8_t *data, size_t len) {
  SPI.beginTransaction(SPISettings(SPI_HZ, MSBFIRST, SPI_MODE0));
  digitalWrite(csPin, LOW);
  SPI.transfer(scAddrByte(REG_THR, channel, false));
  for (size_t i = 0; i < len; i++) {
    SPI.transfer(data[i]);
  }
  digitalWrite(csPin, HIGH);
  SPI.endTransaction();
}

static size_t scReadFIFO(uint8_t csPin, uint8_t channel, uint8_t *out, size_t len) {
  SPI.beginTransaction(SPISettings(SPI_HZ, MSBFIRST, SPI_MODE0));
  digitalWrite(csPin, LOW);
  SPI.transfer(scAddrByte(REG_RHR, channel, true));
  for (size_t i = 0; i < len; i++) {
    out[i] = SPI.transfer(0x00);
  }
  digitalWrite(csPin, HIGH);
  SPI.endTransaction();
  return len;
}

static void scSetBaud(uint8_t csPin, uint8_t channel, uint32_t baud) {
  // With your 14.7456 MHz oscillator and prescaler /1:
  // divisor = 14,745,600 / (16 * baud)
  uint16_t divisor = (uint16_t)(14745600UL / (16UL * baud));

  uint8_t oldLcr = scReadReg(csPin, channel, REG_LCR);
  scWriteReg(csPin, channel, REG_LCR, oldLcr | 0x80); // DLAB=1
  scWriteReg(csPin, channel, REG_DLL, (uint8_t)(divisor & 0xFF));
  scWriteReg(csPin, channel, REG_DLH, (uint8_t)((divisor >> 8) & 0xFF));
  scWriteReg(csPin, channel, REG_LCR, 0x03); // 8N1, DLAB=0
}

static void scInitOne(uint8_t csPin, uint8_t channel) {
  // FIFO enable + reset RX/TX FIFOs
  scWriteReg(csPin, channel, REG_FCR, 0x07);

  // 8N1
  scWriteReg(csPin, channel, REG_LCR, 0x03);

  // Normal mode, prescaler /1
  scWriteReg(csPin, channel, REG_MCR, 0x00);

  // No special auto RS485 features needed; transceivers handle direction
  scWriteReg(csPin, channel, REG_EFCR, 0x00);

  scSetBaud(csPin, channel, DOWN_BAUD);
}

static void scInitAll() {
  for (uint8_t i = 0; i < 4; i++) {
    scInitOne(BUS_MAP[i].csPin, BUS_MAP[i].channel);
  }
}

static uint8_t busTxLevel(uint8_t busNum) {
  if (busNum >= 4) return 0;
  return scReadReg(BUS_MAP[busNum].csPin, BUS_MAP[busNum].channel, REG_TXLVL);
}

static uint8_t busRxLevel(uint8_t busNum) {
  if (busNum >= 4) return 0;
  return scReadReg(BUS_MAP[busNum].csPin, BUS_MAP[busNum].channel, REG_RXLVL);
}

static bool busWrite(uint8_t busNum, const uint8_t *data, size_t len) {
  if (busNum >= 4) return false;
  if (len == 0) return true;

  const uint8_t cs = BUS_MAP[busNum].csPin;
  const uint8_t ch = BUS_MAP[busNum].channel;

  size_t sent = 0;
  uint32_t tStart = millis();
  while (sent < len) {
    uint8_t room = scReadReg(cs, ch, REG_TXLVL);
    if (room == 0) {
      if ((millis() - tStart) > BUS_WRITE_TIMEOUT_MS) {
        return false; // give up instead of hanging main loop
      }
      delay(1);
      continue;
    }

    uint8_t chunk = (uint8_t)min((size_t)room, len - sent);
    scWriteFIFO(cs, ch, data + sent, chunk);
    sent += chunk;
  }

  return true;
}

static size_t busRead(uint8_t busNum, uint8_t *out, size_t maxLen, uint16_t timeoutMs) {
  if (busNum >= 4 || maxLen == 0) return 0;

  const uint8_t cs = BUS_MAP[busNum].csPin;
  const uint8_t ch = BUS_MAP[busNum].channel;

  size_t total = 0;
  uint32_t tStart = millis();
  uint32_t tLastByte = 0;
  bool gotAny = false;

  while ((millis() - tStart) < timeoutMs) {
    uint8_t avail = scReadReg(cs, ch, REG_RXLVL);

    if (avail > 0) {
      if ((size_t)avail > (maxLen - total)) {
        avail = (uint8_t)(maxLen - total);
      }

      if (avail > 0) {
        scReadFIFO(cs, ch, out + total, avail);
        total += avail;
        gotAny = true;
        tLastByte = millis();

        if (total >= maxLen) break;
      }
    } else {
      if (gotAny && (millis() - tLastByte) >= DOWNSTREAM_INTERBYTE_GAP_MS) {
        break;
      }
      delay(1);
    }
  }

  return total;
}

// ============================================================
// Upstream reply
// [55][module_addr][bus][len][payload...][status][crc]
// ============================================================

static void sendReply(uint8_t busNum, const uint8_t *payload, uint8_t len, uint8_t status) {
  UP.write((uint8_t)0x55);
  UP.write(g_moduleAddr);
  UP.write(busNum);
  UP.write(len);

  uint8_t crc = 0x55 ^ g_moduleAddr ^ busNum ^ len;

  for (uint8_t i = 0; i < len; i++) {
    UP.write(payload[i]);
    crc ^= payload[i];
  }

  UP.write(status);
  crc ^= status;
  UP.write(crc);
  UP.flush();
}

// ============================================================
// Handle validated request
// ============================================================

static void handleRequest(uint8_t busNum, const uint8_t *payload, uint8_t len) {
  // Control channel: busNum = 0xFF reserved for hub diagnostics
  if (busNum == 0xFF) {
    if (len == 0) {
      sendReply(busNum, nullptr, 0, ST_BAD_BUS);
      return;
    }

    uint8_t cmd = payload[0];
    if (cmd == 0x01) {
      // Return per-bus error counters + last status (4x uint16 + 4x uint8)
      uint8_t out[12];
      for (uint8_t i = 0; i < 4; i++) {
        out[i * 2]     = (uint8_t)(g_bus_err[i] & 0xFF);
        out[i * 2 + 1] = (uint8_t)((g_bus_err[i] >> 8) & 0xFF);
      }
      out[8]  = g_bus_last_status[0];
      out[9]  = g_bus_last_status[1];
      out[10] = g_bus_last_status[2];
      out[11] = g_bus_last_status[3];
      sendReply(busNum, out, 12, ST_OK);
      return;
    } else if (cmd == 0x02) {
      for (uint8_t i = 0; i < 4; i++) {
        g_bus_err[i] = 0;
        g_bus_last_status[i] = ST_OK;
      }
      sendReply(busNum, nullptr, 0, ST_OK);
      return;
    }

    // Unknown control command
    sendReply(busNum, nullptr, 0, ST_BAD_BUS);
    return;
  }

  if (busNum >= 4) {
    sendReply(busNum, nullptr, 0, ST_BAD_BUS);
    return;
  }

  if (!busWrite(busNum, payload, len)) {
    g_bus_err[busNum]++;
    g_bus_last_status[busNum] = ST_BAD_BUS;
    sendReply(busNum, nullptr, 0, ST_BAD_BUS);
    return;
  }

  uint8_t replyBuf[MAX_PAYLOAD];
  size_t replyLen = busRead(busNum, replyBuf, sizeof(replyBuf), DOWNSTREAM_REPLY_TIMEOUT_MS);

  if (replyLen == 0) {
    g_bus_err[busNum]++;
    g_bus_last_status[busNum] = ST_TIMEOUT;
    sendReply(busNum, nullptr, 0, ST_TIMEOUT);
    return;
  }

  // success
  g_bus_last_status[busNum] = ST_OK;
  sendReply(busNum, replyBuf, (uint8_t)replyLen, ST_OK);
}

// ============================================================
// Setup
// ============================================================

void setup() {
  Serial.begin(115200);
  delay(150);

  pinMode(PIN_DIP0, INPUT_PULLUP);
  pinMode(PIN_DIP1, INPUT_PULLUP);

  g_moduleAddr = (uint8_t)(BASE_ADDR + readDip2());

  pinMode(PIN_CS1, OUTPUT);
  pinMode(PIN_CS2, OUTPUT);
  digitalWrite(PIN_CS1, HIGH);
  digitalWrite(PIN_CS2, HIGH);

  SPI.setSCK(PIN_SPI_SCK);
  SPI.setTX(PIN_SPI_MOSI);
  SPI.setRX(PIN_SPI_MISO);
  SPI.begin();

  scInitAll();

  UP.setTX(PIN_UP_TX);
  UP.setRX(PIN_UP_RX);
  UP.begin(UP_BAUD);

  Serial.printf("RS485 expander boot: addr=0x%02X\n", g_moduleAddr);
}

// ============================================================
// Main loop
// ============================================================

void loop() {
  while (UP.available() > 0) {
    int bi = UP.read();
    if (bi < 0) break;
    uint8_t b = (uint8_t)bi;

    switch (rxState) {
      case RX_WAIT_PREAMBLE:
        if (b == 0xAA) {
          resetParser();
          rxState = RX_ADDR;
        }
        break;

      case RX_ADDR:
        rxAddr = b;
        rxState = RX_BUS;
        break;

      case RX_BUS:
        rxBus = b;
        rxState = RX_LEN;
        break;

      case RX_LEN:
        rxLen = b;
        if (rxLen > MAX_PAYLOAD) {
          if (rxAddr == g_moduleAddr) {
            sendReply(rxBus, nullptr, 0, ST_TOO_LONG);
          }
          resetParser();
        } else if (rxLen == 0) {
          rxState = RX_CRC;
        } else {
          rxIndex = 0;
          rxState = RX_PAYLOAD;
        }
        break;

      case RX_PAYLOAD:
        rxPayload[rxIndex++] = b;
        if (rxIndex >= rxLen) {
          rxState = RX_CRC;
        }
        break;

      case RX_CRC: {
        uint8_t calc = 0xAA ^ rxAddr ^ rxBus ^ rxLen;
        for (uint8_t i = 0; i < rxLen; i++) calc ^= rxPayload[i];

        if (calc != b) {
          if (rxAddr == g_moduleAddr) {
            sendReply(rxBus, nullptr, 0, ST_BAD_CRC);
          }
          resetParser();
          break;
        }

        if (rxAddr == g_moduleAddr) {
          handleRequest(rxBus, rxPayload, rxLen);
        }

        resetParser();
        break;
      }

      default:
        resetParser();
        break;
    }
  }

  delay(1);
}

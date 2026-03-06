#include <Arduino.h>
#include <Wire.h>
#include <EEPROM.h>

#include <Adafruit_INA219.h>
#include <INA226_WE.h>
#include <Adafruit_ADS1X15.h>
#include <Adafruit_MCP23X17.h>
#include <Adafruit_BME280.h>
#include <Adafruit_BME680.h>
#include <Adafruit_SHT31.h>
#include <SparkFunHTU21D.h>

/*
  ============================================================
  XIAO RP2040 I2C MODULE BACKEND
  ============================================================

  RS485 base address:
    0x20 + DIP(3-bit)

  DIP addressing:
    P26 = bit0
    P27 = bit1
    P2  = bit2
    pullups enabled, switch ON pulls LOW => bit = 1

  RS485 transceiver:
    MAX13487E auto-direction
    TX = P0
    RX = P1

  I2C:
    Shared bus across multiple connectors
    Devices are identified by:
      - sensor type ID
      - I2C address

  Persistent registry:
    Stores configured devices across boots in EEPROM

  ============================================================
  REQUEST FRAME (9 bytes)
  ============================================================
    [0] 0xAA
    [1] rs485_addr
    [2] cmd
    [3] sensor_type
    [4] i2c_addr
    [5] p0
    [6] p1
    [7] p2
    [8] crc

    crc = XOR of bytes [0..7]

  ============================================================
  REPLY FRAME (12 bytes)
  ============================================================
    [0]  0x55
    [1]  rs485_addr
    [2]  cmd
    [3]  sensor_type
    [4]  i2c_addr
    [5]  field_id
    [6]  d0
    [7]  d1
    [8]  d2
    [9]  d3
    [10] status
    [11] crc

    crc = XOR of bytes [0..10]

  ============================================================
  SENSOR TYPE IDS
  ============================================================
    0x01 = INA219
    0x02 = INA226
    0x03 = ADS1115
    0x04 = TMP102
    0x05 = LM75
    0x06 = MCP23017
    0x07 = PCF8574
    0x08 = BME280
    0x09 = BME680
    0x0A = SHT31
    0x0B = HTU21D

  ============================================================
  COMMAND IDS
  ============================================================
    0x01 = REGISTER_DEVICE
    0x02 = UNREGISTER_DEVICE
    0x03 = GET_DEVICE
    0x04 = SAMPLE_DEVICE
    0x05 = SCAN_I2C
    0x06 = GPIO_READ
    0x07 = GPIO_WRITE
    0x08 = SAMPLE_ALL_REGISTERED
    0x09 = LIST_REGISTERED
    0x0A = CLEAR_REGISTRY

  ============================================================
  FIELD IDS
  ============================================================
    0x00 = none / generic
    0x01 = voltage_mV
    0x02 = current_mA
    0x03 = adc_ch0
    0x04 = adc_ch1
    0x05 = adc_ch2
    0x06 = adc_ch3
    0x07 = temperature_centiC
    0x08 = humidity_centiPct
    0x09 = pressure_Pa
    0x0A = gas_ohms
    0x0B = gpio_port_lo
    0x0C = gpio_port_hi
    0x0D = gpio_pin_state
    0x0E = scan_found
    0x0F = config_saved
    0x10 = config_deleted
    0x11 = registry_entry
    0x12 = registry_cleared

  ============================================================
  STATUS CODES
  ============================================================
    0x00 = OK
    0x01 = BAD_ARG
    0x02 = UNSUPPORTED
    0x03 = NOT_FOUND
    0x04 = READ_FAIL
    0x05 = WRITE_FAIL
    0x06 = BAD_CMD
    0x07 = BAD_CRC
    0x08 = REGISTRY_FULL
*/

// ===================== USER CONFIG =====================

static HardwareSerial &RS485 = Serial1;
static const uint32_t RS485_BAUD = 115200;
static const int PIN_UART_TX = 0; // P0
static const int PIN_UART_RX = 1; // P1

static const int PIN_DIP0 = 26;
static const int PIN_DIP1 = 27;
static const int PIN_DIP2 = 2;

static const uint8_t BASE_ADDR = 0x20;

static const uint8_t MAX_DEVICES = 16;
static const size_t EEPROM_BYTES = 1024;

// If needed, uncomment explicit Wire pin assignment for your XIAO board:
// static const int PIN_I2C_SDA = 6;
// static const int PIN_I2C_SCL = 7;

// ===================== IDS =====================

enum SensorType : uint8_t {
  SENSOR_NONE     = 0x00,
  SENSOR_INA219   = 0x01,
  SENSOR_INA226   = 0x02,
  SENSOR_ADS1115  = 0x03,
  SENSOR_TMP102   = 0x04,
  SENSOR_LM75     = 0x05,
  SENSOR_MCP23017 = 0x06,
  SENSOR_PCF8574  = 0x07,
  SENSOR_BME280   = 0x08,
  SENSOR_BME680   = 0x09,
  SENSOR_SHT31    = 0x0A,
  SENSOR_HTU21D   = 0x0B
};

enum CommandId : uint8_t {
  CMD_REGISTER_DEVICE      = 0x01,
  CMD_UNREGISTER_DEVICE    = 0x02,
  CMD_GET_DEVICE           = 0x03,
  CMD_SAMPLE_DEVICE        = 0x04,
  CMD_SCAN_I2C             = 0x05,
  CMD_GPIO_READ            = 0x06,
  CMD_GPIO_WRITE           = 0x07,
  CMD_SAMPLE_ALL_REGISTERED= 0x08,
  CMD_LIST_REGISTERED      = 0x09,
  CMD_CLEAR_REGISTRY       = 0x0A
};

enum FieldId : uint8_t {
  FIELD_NONE         = 0x00,
  FIELD_VOLTAGE_MV   = 0x01,
  FIELD_CURRENT_MA   = 0x02,
  FIELD_ADC_CH0      = 0x03,
  FIELD_ADC_CH1      = 0x04,
  FIELD_ADC_CH2      = 0x05,
  FIELD_ADC_CH3      = 0x06,
  FIELD_TEMP_CENTIC  = 0x07,
  FIELD_HUMI_CENTIP  = 0x08,
  FIELD_PRESSURE_PA  = 0x09,
  FIELD_GAS_OHMS     = 0x0A,
  FIELD_GPIO_PORT_LO = 0x0B,
  FIELD_GPIO_PORT_HI = 0x0C,
  FIELD_GPIO_PIN     = 0x0D,
  FIELD_SCAN_FOUND   = 0x0E,
  FIELD_CONFIG_SAVED = 0x0F,
  FIELD_CONFIG_DELETED = 0x10,
  FIELD_REGISTRY_ENTRY = 0x11,
  FIELD_REGISTRY_CLEARED = 0x12
};

enum StatusCode : uint8_t {
  ST_OK          = 0x00,
  ST_BAD_ARG     = 0x01,
  ST_UNSUPPORTED = 0x02,
  ST_NOT_FOUND   = 0x03,
  ST_READ_FAIL   = 0x04,
  ST_WRITE_FAIL  = 0x05,
  ST_BAD_CMD     = 0x06,
  ST_BAD_CRC     = 0x07,
  ST_REG_FULL    = 0x08
};

// ===================== REGISTRY =====================

struct DeviceConfig {
  uint8_t enabled;
  uint8_t type;
  uint8_t i2c_addr;
  uint8_t options;
};

struct RegistryStore {
  uint32_t magic;
  uint8_t version;
  uint8_t reserved[3];
  DeviceConfig devices[MAX_DEVICES];
  uint8_t crc;
};

static const uint32_t REG_MAGIC = 0x4932434D; // I2CM
static const uint8_t REG_VERSION = 1;

static RegistryStore g_reg;
static uint8_t g_deviceAddr = 0;

// ===================== RX BUFFER =====================

static uint8_t rxBuf[9];
static uint8_t rxCount = 0;

// ===================== HELPERS =====================

static uint8_t readDip3() {
  uint8_t b0 = (digitalRead(PIN_DIP0) == LOW) ? 1 : 0;
  uint8_t b1 = (digitalRead(PIN_DIP1) == LOW) ? 1 : 0;
  uint8_t b2 = (digitalRead(PIN_DIP2) == LOW) ? 1 : 0;
  return (uint8_t)((b0 << 0) | (b1 << 1) | (b2 << 2));
}

static uint8_t crc8_xor(const uint8_t *buf, size_t len) {
  uint8_t c = 0;
  for (size_t i = 0; i < len; i++) c ^= buf[i];
  return c;
}

static bool i2cPresent(uint8_t addr) {
  Wire.beginTransmission(addr);
  return (Wire.endTransmission() == 0);
}

static bool supportedType(uint8_t type) {
  switch (type) {
    case SENSOR_INA219:
    case SENSOR_INA226:
    case SENSOR_ADS1115:
    case SENSOR_TMP102:
    case SENSOR_LM75:
    case SENSOR_MCP23017:
    case SENSOR_PCF8574:
    case SENSOR_BME280:
    case SENSOR_BME680:
    case SENSOR_SHT31:
    case SENSOR_HTU21D:
      return true;
    default:
      return false;
  }
}

static void defaultRegistry() {
  memset(&g_reg, 0, sizeof(g_reg));
  g_reg.magic = REG_MAGIC;
  g_reg.version = REG_VERSION;
}

static uint8_t calcRegistryCRC(const RegistryStore &r) {
  const uint8_t *p = reinterpret_cast<const uint8_t*>(&r);
  uint8_t c = 0;
  for (size_t i = 0; i < sizeof(RegistryStore) - 1; i++) c ^= p[i];
  return c;
}

static void saveRegistry() {
  g_reg.crc = calcRegistryCRC(g_reg);
  EEPROM.put(0, g_reg);
  EEPROM.commit();
}

static bool loadRegistry() {
  EEPROM.get(0, g_reg);
  if (g_reg.magic != REG_MAGIC) return false;
  if (g_reg.version != REG_VERSION) return false;
  if (g_reg.crc != calcRegistryCRC(g_reg)) return false;
  return true;
}

static int findDevice(uint8_t type, uint8_t i2c_addr) {
  for (int i = 0; i < MAX_DEVICES; i++) {
    if (g_reg.devices[i].enabled &&
        g_reg.devices[i].type == type &&
        g_reg.devices[i].i2c_addr == i2c_addr) {
      return i;
    }
  }
  return -1;
}

static int findFreeDeviceSlot() {
  for (int i = 0; i < MAX_DEVICES; i++) {
    if (!g_reg.devices[i].enabled) return i;
  }
  return -1;
}

// ===================== REPLY =====================
// [55][addr][cmd][type][i2c][field][d0][d1][d2][d3][status][crc]

static void sendReply(uint8_t cmd, uint8_t sensor_type, uint8_t i2c_addr,
                      uint8_t field_id,
                      uint8_t d0, uint8_t d1, uint8_t d2, uint8_t d3,
                      uint8_t status) {
  uint8_t pkt[12] = {
    0x55, g_deviceAddr, cmd, sensor_type, i2c_addr, field_id,
    d0, d1, d2, d3, status, 0
  };
  pkt[11] = crc8_xor(pkt, 11);
  RS485.write(pkt, sizeof(pkt));
  RS485.flush();
}

static void sendReplyU32(uint8_t cmd, uint8_t sensor_type, uint8_t i2c_addr,
                         uint8_t field_id, int32_t value, uint8_t status) {
  uint32_t u = (uint32_t)value;
  sendReply(cmd, sensor_type, i2c_addr, field_id,
            (uint8_t)(u & 0xFF),
            (uint8_t)((u >> 8) & 0xFF),
            (uint8_t)((u >> 16) & 0xFF),
            (uint8_t)((u >> 24) & 0xFF),
            status);
}

// ===================== RAW SENSOR HELPERS =====================

static bool readTMP102(uint8_t addr, int32_t &temp_centi) {
  Wire.beginTransmission(addr);
  Wire.write(0x00);
  if (Wire.endTransmission(false) != 0) return false;
  if (Wire.requestFrom((int)addr, 2) != 2) return false;

  uint16_t raw = ((uint16_t)Wire.read() << 8) | Wire.read();
  raw >>= 4;
  int16_t signedRaw = (raw & 0x800) ? (raw | 0xF000) : raw;
  float tempC = signedRaw * 0.0625f;
  temp_centi = (int32_t)(tempC * 100.0f);
  return true;
}

static bool readLM75(uint8_t addr, int32_t &temp_centi) {
  Wire.beginTransmission(addr);
  Wire.write(0x00);
  if (Wire.endTransmission(false) != 0) return false;
  if (Wire.requestFrom((int)addr, 2) != 2) return false;

  uint16_t raw = ((uint16_t)Wire.read() << 8) | Wire.read();
  int16_t signedRaw = (int16_t)raw;
  float tempC = (signedRaw >> 7) * 0.5f;
  temp_centi = (int32_t)(tempC * 100.0f);
  return true;
}

static bool pcf8574ReadPort(uint8_t addr, uint8_t &value) {
  if (Wire.requestFrom((int)addr, 1) != 1) return false;
  value = Wire.read();
  return true;
}

static bool pcf8574WritePort(uint8_t addr, uint8_t value) {
  Wire.beginTransmission(addr);
  Wire.write(value);
  return Wire.endTransmission() == 0;
}

// ===================== SAMPLE DEVICE =====================

static uint8_t sampleDevice(uint8_t type, uint8_t i2c_addr) {
  if (!supportedType(type)) {
    sendReply(CMD_SAMPLE_DEVICE, type, i2c_addr, FIELD_NONE, 0,0,0,0, ST_UNSUPPORTED);
    return ST_UNSUPPORTED;
  }

  if (!i2cPresent(i2c_addr)) {
    sendReply(CMD_SAMPLE_DEVICE, type, i2c_addr, FIELD_NONE, 0,0,0,0, ST_NOT_FOUND);
    return ST_NOT_FOUND;
  }

  switch (type) {
    case SENSOR_INA219: {
      Adafruit_INA219 ina(i2c_addr);
      if (!ina.begin()) {
        sendReply(CMD_SAMPLE_DEVICE, type, i2c_addr, FIELD_NONE, 0,0,0,0, ST_READ_FAIL);
        return ST_READ_FAIL;
      }
      int32_t bus_mV = (int32_t)(ina.getBusVoltage_V() * 1000.0f);
      int32_t current_mA = (int32_t)(ina.getCurrent_mA());
      sendReplyU32(CMD_SAMPLE_DEVICE, type, i2c_addr, FIELD_VOLTAGE_MV, bus_mV, ST_OK);
      sendReplyU32(CMD_SAMPLE_DEVICE, type, i2c_addr, FIELD_CURRENT_MA, current_mA, ST_OK);
      return ST_OK;
    }

    case SENSOR_INA226: {
      INA226_WE ina(i2c_addr);
      if (!ina.init()) {
        sendReply(CMD_SAMPLE_DEVICE, type, i2c_addr, FIELD_NONE, 0,0,0,0, ST_READ_FAIL);
        return ST_READ_FAIL;
      }
      int32_t bus_mV = (int32_t)(ina.getBusVoltage_V() * 1000.0f);
      int32_t current_mA = (int32_t)(ina.getCurrent_mA());
      sendReplyU32(CMD_SAMPLE_DEVICE, type, i2c_addr, FIELD_VOLTAGE_MV, bus_mV, ST_OK);
      sendReplyU32(CMD_SAMPLE_DEVICE, type, i2c_addr, FIELD_CURRENT_MA, current_mA, ST_OK);
      return ST_OK;
    }

    case SENSOR_ADS1115: {
      Adafruit_ADS1115 ads;
      if (!ads.begin(i2c_addr)) {
        sendReply(CMD_SAMPLE_DEVICE, type, i2c_addr, FIELD_NONE, 0,0,0,0, ST_READ_FAIL);
        return ST_READ_FAIL;
      }
      sendReplyU32(CMD_SAMPLE_DEVICE, type, i2c_addr, FIELD_ADC_CH0, ads.readADC_SingleEnded(0), ST_OK);
      sendReplyU32(CMD_SAMPLE_DEVICE, type, i2c_addr, FIELD_ADC_CH1, ads.readADC_SingleEnded(1), ST_OK);
      sendReplyU32(CMD_SAMPLE_DEVICE, type, i2c_addr, FIELD_ADC_CH2, ads.readADC_SingleEnded(2), ST_OK);
      sendReplyU32(CMD_SAMPLE_DEVICE, type, i2c_addr, FIELD_ADC_CH3, ads.readADC_SingleEnded(3), ST_OK);
      return ST_OK;
    }

    case SENSOR_TMP102: {
      int32_t temp_centi = 0;
      if (!readTMP102(i2c_addr, temp_centi)) {
        sendReply(CMD_SAMPLE_DEVICE, type, i2c_addr, FIELD_NONE, 0,0,0,0, ST_READ_FAIL);
        return ST_READ_FAIL;
      }
      sendReplyU32(CMD_SAMPLE_DEVICE, type, i2c_addr, FIELD_TEMP_CENTIC, temp_centi, ST_OK);
      return ST_OK;
    }

    case SENSOR_LM75: {
      int32_t temp_centi = 0;
      if (!readLM75(i2c_addr, temp_centi)) {
        sendReply(CMD_SAMPLE_DEVICE, type, i2c_addr, FIELD_NONE, 0,0,0,0, ST_READ_FAIL);
        return ST_READ_FAIL;
      }
      sendReplyU32(CMD_SAMPLE_DEVICE, type, i2c_addr, FIELD_TEMP_CENTIC, temp_centi, ST_OK);
      return ST_OK;
    }

    case SENSOR_MCP23017: {
      Adafruit_MCP23X17 mcp;
      if (!mcp.begin_I2C(i2c_addr, &Wire)) {
        sendReply(CMD_SAMPLE_DEVICE, type, i2c_addr, FIELD_NONE, 0,0,0,0, ST_READ_FAIL);
        return ST_READ_FAIL;
      }
      uint16_t port = 0;
      for (uint8_t i = 0; i < 16; i++) {
        mcp.pinMode(i, INPUT);
        if (mcp.digitalRead(i)) port |= (1u << i);
      }
      sendReplyU32(CMD_SAMPLE_DEVICE, type, i2c_addr, FIELD_GPIO_PORT_LO, (int32_t)(port & 0xFF), ST_OK);
      sendReplyU32(CMD_SAMPLE_DEVICE, type, i2c_addr, FIELD_GPIO_PORT_HI, (int32_t)((port >> 8) & 0xFF), ST_OK);
      return ST_OK;
    }

    case SENSOR_PCF8574: {
      uint8_t val = 0;
      if (!pcf8574ReadPort(i2c_addr, val)) {
        sendReply(CMD_SAMPLE_DEVICE, type, i2c_addr, FIELD_NONE, 0,0,0,0, ST_READ_FAIL);
        return ST_READ_FAIL;
      }
      sendReplyU32(CMD_SAMPLE_DEVICE, type, i2c_addr, FIELD_GPIO_PORT_LO, val, ST_OK);
      return ST_OK;
    }

    case SENSOR_BME280: {
      Adafruit_BME280 bme;
      if (!bme.begin(i2c_addr, &Wire)) {
        sendReply(CMD_SAMPLE_DEVICE, type, i2c_addr, FIELD_NONE, 0,0,0,0, ST_READ_FAIL);
        return ST_READ_FAIL;
      }
      int32_t temp_centi = (int32_t)(bme.readTemperature() * 100.0f);
      int32_t humi_centi = (int32_t)(bme.readHumidity() * 100.0f);
      int32_t pres_pa = (int32_t)(bme.readPressure());
      sendReplyU32(CMD_SAMPLE_DEVICE, type, i2c_addr, FIELD_TEMP_CENTIC, temp_centi, ST_OK);
      sendReplyU32(CMD_SAMPLE_DEVICE, type, i2c_addr, FIELD_HUMI_CENTIP, humi_centi, ST_OK);
      sendReplyU32(CMD_SAMPLE_DEVICE, type, i2c_addr, FIELD_PRESSURE_PA, pres_pa, ST_OK);
      return ST_OK;
    }

    case SENSOR_BME680: {
      Adafruit_BME680 bme;
      if (!bme.begin(i2c_addr, &Wire)) {
        sendReply(CMD_SAMPLE_DEVICE, type, i2c_addr, FIELD_NONE, 0,0,0,0, ST_READ_FAIL);
        return ST_READ_FAIL;
      }
      bme.setTemperatureOversampling(BME680_OS_8X);
      bme.setHumidityOversampling(BME680_OS_2X);
      bme.setPressureOversampling(BME680_OS_4X);
      bme.setIIRFilterSize(BME680_FILTER_SIZE_3);
      bme.setGasHeater(320, 150);
      if (!bme.performReading()) {
        sendReply(CMD_SAMPLE_DEVICE, type, i2c_addr, FIELD_NONE, 0,0,0,0, ST_READ_FAIL);
        return ST_READ_FAIL;
      }
      sendReplyU32(CMD_SAMPLE_DEVICE, type, i2c_addr, FIELD_TEMP_CENTIC, (int32_t)(bme.temperature * 100.0f), ST_OK);
      sendReplyU32(CMD_SAMPLE_DEVICE, type, i2c_addr, FIELD_HUMI_CENTIP, (int32_t)(bme.humidity * 100.0f), ST_OK);
      sendReplyU32(CMD_SAMPLE_DEVICE, type, i2c_addr, FIELD_PRESSURE_PA, (int32_t)(bme.pressure), ST_OK);
      sendReplyU32(CMD_SAMPLE_DEVICE, type, i2c_addr, FIELD_GAS_OHMS, (int32_t)(bme.gas_resistance), ST_OK);
      return ST_OK;
    }

    case SENSOR_SHT31: {
      Adafruit_SHT31 sht;
      if (!sht.begin(i2c_addr)) {
        sendReply(CMD_SAMPLE_DEVICE, type, i2c_addr, FIELD_NONE, 0,0,0,0, ST_READ_FAIL);
        return ST_READ_FAIL;
      }
      sendReplyU32(CMD_SAMPLE_DEVICE, type, i2c_addr, FIELD_TEMP_CENTIC, (int32_t)(sht.readTemperature() * 100.0f), ST_OK);
      sendReplyU32(CMD_SAMPLE_DEVICE, type, i2c_addr, FIELD_HUMI_CENTIP, (int32_t)(sht.readHumidity() * 100.0f), ST_OK);
      return ST_OK;
    }

    case SENSOR_HTU21D: {
      HTU21D htu;
      if (!htu.begin()) {
        sendReply(CMD_SAMPLE_DEVICE, type, i2c_addr, FIELD_NONE, 0,0,0,0, ST_READ_FAIL);
        return ST_READ_FAIL;
      }
      sendReplyU32(CMD_SAMPLE_DEVICE, type, i2c_addr, FIELD_TEMP_CENTIC, (int32_t)(htu.readTemperature() * 100.0f), ST_OK);
      sendReplyU32(CMD_SAMPLE_DEVICE, type, i2c_addr, FIELD_HUMI_CENTIP, (int32_t)(htu.readHumidity() * 100.0f), ST_OK);
      return ST_OK;
    }

    default:
      sendReply(CMD_SAMPLE_DEVICE, type, i2c_addr, FIELD_NONE, 0,0,0,0, ST_UNSUPPORTED);
      return ST_UNSUPPORTED;
  }
}

// ===================== GPIO OPS =====================

static uint8_t gpioRead(uint8_t type, uint8_t i2c_addr, uint8_t pin) {
  if (type == SENSOR_MCP23017) {
    if (pin >= 16) return ST_BAD_ARG;
    Adafruit_MCP23X17 mcp;
    if (!mcp.begin_I2C(i2c_addr, &Wire)) return ST_READ_FAIL;
    mcp.pinMode(pin, INPUT);
    uint8_t val = mcp.digitalRead(pin) ? 1 : 0;
    sendReply(CMD_GPIO_READ, type, i2c_addr, FIELD_GPIO_PIN, val, pin, 0, 0, ST_OK);
    return ST_OK;
  }

  if (type == SENSOR_PCF8574) {
    if (pin >= 8) return ST_BAD_ARG;
    uint8_t port = 0;
    if (!pcf8574ReadPort(i2c_addr, port)) return ST_READ_FAIL;
    uint8_t val = (port >> pin) & 0x01;
    sendReply(CMD_GPIO_READ, type, i2c_addr, FIELD_GPIO_PIN, val, pin, 0, 0, ST_OK);
    return ST_OK;
  }

  return ST_UNSUPPORTED;
}

static uint8_t gpioWrite(uint8_t type, uint8_t i2c_addr, uint8_t pin, uint8_t value) {
  if (type == SENSOR_MCP23017) {
    if (pin >= 16) return ST_BAD_ARG;
    Adafruit_MCP23X17 mcp;
    if (!mcp.begin_I2C(i2c_addr, &Wire)) return ST_WRITE_FAIL;
    mcp.pinMode(pin, OUTPUT);
    mcp.digitalWrite(pin, value ? HIGH : LOW);
    sendReply(CMD_GPIO_WRITE, type, i2c_addr, FIELD_GPIO_PIN, value ? 1 : 0, pin, 0, 0, ST_OK);
    return ST_OK;
  }

  if (type == SENSOR_PCF8574) {
    if (pin >= 8) return ST_BAD_ARG;
    uint8_t port = 0xFF;
    if (!pcf8574ReadPort(i2c_addr, port)) return ST_READ_FAIL;
    if (value) port |= (1u << pin);
    else port &= ~(1u << pin);
    if (!pcf8574WritePort(i2c_addr, port)) return ST_WRITE_FAIL;
    sendReply(CMD_GPIO_WRITE, type, i2c_addr, FIELD_GPIO_PIN, value ? 1 : 0, pin, 0, 0, ST_OK);
    return ST_OK;
  }

  return ST_UNSUPPORTED;
}

// ===================== REGISTRY OPS =====================

static void registerDevice(uint8_t type, uint8_t i2c_addr, uint8_t options) {
  if (!supportedType(type)) {
    sendReply(CMD_REGISTER_DEVICE, type, i2c_addr, FIELD_CONFIG_SAVED, 0,0,0,0, ST_UNSUPPORTED);
    return;
  }

  int idx = findDevice(type, i2c_addr);
  if (idx < 0) idx = findFreeDeviceSlot();
  if (idx < 0) {
    sendReply(CMD_REGISTER_DEVICE, type, i2c_addr, FIELD_CONFIG_SAVED, 0,0,0,0, ST_REG_FULL);
    return;
  }

  g_reg.devices[idx].enabled = 1;
  g_reg.devices[idx].type = type;
  g_reg.devices[idx].i2c_addr = i2c_addr;
  g_reg.devices[idx].options = options;
  saveRegistry();

  sendReply(CMD_REGISTER_DEVICE, type, i2c_addr, FIELD_CONFIG_SAVED, 1, idx, options, 0, ST_OK);
}

static void unregisterDevice(uint8_t type, uint8_t i2c_addr) {
  int idx = findDevice(type, i2c_addr);
  if (idx < 0) {
    sendReply(CMD_UNREGISTER_DEVICE, type, i2c_addr, FIELD_CONFIG_DELETED, 0,0,0,0, ST_NOT_FOUND);
    return;
  }

  memset(&g_reg.devices[idx], 0, sizeof(DeviceConfig));
  saveRegistry();

  sendReply(CMD_UNREGISTER_DEVICE, type, i2c_addr, FIELD_CONFIG_DELETED, 1, idx, 0, 0, ST_OK);
}

static void getDevice(uint8_t type, uint8_t i2c_addr) {
  int idx = findDevice(type, i2c_addr);
  if (idx < 0) {
    sendReply(CMD_GET_DEVICE, type, i2c_addr, FIELD_REGISTRY_ENTRY, 0,0,0,0, ST_NOT_FOUND);
    return;
  }

  const DeviceConfig &d = g_reg.devices[idx];
  sendReply(CMD_GET_DEVICE, d.type, d.i2c_addr, FIELD_REGISTRY_ENTRY,
            d.enabled, idx, d.options, 0, ST_OK);
}

static void listRegistered() {
  for (uint8_t i = 0; i < MAX_DEVICES; i++) {
    if (!g_reg.devices[i].enabled) continue;
    const DeviceConfig &d = g_reg.devices[i];
    sendReply(CMD_LIST_REGISTERED, d.type, d.i2c_addr, FIELD_REGISTRY_ENTRY,
              1, i, d.options, 0, ST_OK);
  }
}

static void clearRegistry() {
  defaultRegistry();
  saveRegistry();
  sendReply(CMD_CLEAR_REGISTRY, SENSOR_NONE, 0x00, FIELD_REGISTRY_CLEARED, 1,0,0,0, ST_OK);
}

// ===================== I2C SCAN =====================

static void scanI2C() {
  for (uint8_t a = 0x08; a <= 0x77; a++) {
    if (i2cPresent(a)) {
      sendReply(CMD_SCAN_I2C, SENSOR_NONE, a, FIELD_SCAN_FOUND, 1, 0, 0, 0, ST_OK);
    }
  }
}

// ===================== SAMPLE ALL =====================

static void sampleAllRegistered() {
  for (uint8_t i = 0; i < MAX_DEVICES; i++) {
    if (!g_reg.devices[i].enabled) continue;
    sampleDevice(g_reg.devices[i].type, g_reg.devices[i].i2c_addr);
  }
}

// ===================== REQUEST HANDLER =====================
// [AA][addr][cmd][type][i2c][p0][p1][p2][crc]

static void handleRequest(const uint8_t *r) {
  uint8_t addr     = r[1];
  uint8_t cmd      = r[2];
  uint8_t type     = r[3];
  uint8_t i2c_addr = r[4];
  uint8_t p0       = r[5];
  uint8_t p1       = r[6];
  uint8_t p2       = r[7];

  if (addr != g_deviceAddr) return;

  switch (cmd) {
    case CMD_REGISTER_DEVICE:
      registerDevice(type, i2c_addr, p0);
      break;

    case CMD_UNREGISTER_DEVICE:
      unregisterDevice(type, i2c_addr);
      break;

    case CMD_GET_DEVICE:
      getDevice(type, i2c_addr);
      break;

    case CMD_SAMPLE_DEVICE:
      sampleDevice(type, i2c_addr);
      break;

    case CMD_SCAN_I2C:
      scanI2C();
      break;

    case CMD_GPIO_READ: {
      uint8_t st = gpioRead(type, i2c_addr, p0);
      if (st != ST_OK) {
        sendReply(CMD_GPIO_READ, type, i2c_addr, FIELD_GPIO_PIN, 0, p0, 0, 0, st);
      }
      break;
    }

    case CMD_GPIO_WRITE: {
      uint8_t st = gpioWrite(type, i2c_addr, p0, p1);
      if (st != ST_OK) {
        sendReply(CMD_GPIO_WRITE, type, i2c_addr, FIELD_GPIO_PIN, p1, p0, 0, 0, st);
      }
      break;
    }

    case CMD_SAMPLE_ALL_REGISTERED:
      sampleAllRegistered();
      break;

    case CMD_LIST_REGISTERED:
      listRegistered();
      break;

    case CMD_CLEAR_REGISTRY:
      clearRegistry();
      break;

    default:
      sendReply(cmd, type, i2c_addr, FIELD_NONE, 0,0,0,0, ST_BAD_CMD);
      break;
  }
}

// ===================== SETUP / LOOP =====================

void setup() {
  Serial.begin(115200);
  delay(150);

  pinMode(PIN_DIP0, INPUT_PULLUP);
  pinMode(PIN_DIP1, INPUT_PULLUP);
  pinMode(PIN_DIP2, INPUT_PULLUP);

  g_deviceAddr = (uint8_t)(BASE_ADDR + readDip3());

  EEPROM.begin(EEPROM_BYTES);
  if (!loadRegistry()) {
    defaultRegistry();
    saveRegistry();
  }

  // Wire.setSDA(PIN_I2C_SDA);
  // Wire.setSCL(PIN_I2C_SCL);
  Wire.begin();

  RS485.setTX(PIN_UART_TX);
  RS485.setRX(PIN_UART_RX);
  RS485.begin(RS485_BAUD);

  Serial.printf("I2C module boot addr=0x%02X\n", g_deviceAddr);
}

void loop() {
  while (RS485.available() > 0) {
    int b = RS485.read();
    if (b < 0) break;
    uint8_t ub = (uint8_t)b;

    if (rxCount == 0) {
      if (ub != 0xAA) continue;
    }

    rxBuf[rxCount++] = ub;

    if (rxCount >= sizeof(rxBuf)) {
      uint8_t calc = crc8_xor(rxBuf, 8);
      if (calc == rxBuf[8]) {
        handleRequest(rxBuf);
      } else {
        uint8_t cmd      = rxBuf[2];
        uint8_t type     = rxBuf[3];
        uint8_t i2c_addr = rxBuf[4];
        sendReply(cmd, type, i2c_addr, FIELD_NONE, 0,0,0,0, ST_BAD_CRC);
      }
      rxCount = 0;
    }
  }

  delay(2);
}

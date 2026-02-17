/*
  aio_slave.ino

  Simple Arduino I2C slave that implements the AIO protocol used by
  the Home Controller backend (dev testing).

  - Listens on I2C address AIO_ADDR (default 0x30)
  - On I2C request: replies with ASCII CSV of 8 analog input voltages
    e.g. "0.00,12.00,24.00,0.00,0.00,0.00,0.00,0.00"
  - On I2C receive: accepts ASCII command bytes such as
      OUT{ch}:{voltage}\n   e.g. "OUT1:12.0\n"
    to set an output value in memory (and optionally drive a PWM pin)

  Notes:
  - Adjust AREF_V and VOLTAGE_DIVIDER to match your sensor wiring.
  - This sketch is intended for testing; adapt pin mapping for your board.
*/

#include <Wire.h>

#define AIO_ADDR 0x30
#define CHANNELS 8

// Analog reference voltage on the Arduino (in volts)
const float AREF_V = 5.0;
// If your analog inputs are scaled with a divider (e.g. 0-24V -> 0-5V),
// set VOLTAGE_DIVIDER accordingly (V_in = V_measured * VOLTAGE_DIVIDER)
const float VOLTAGE_DIVIDER = 24.0 / 5.0; // example: 24V -> 5V (adjust if different)

float ain[CHANNELS];    // measured analog input voltages
float aout[CHANNELS];   // last-set analog outputs (for OUT commands)

char rxbuf[128];
uint8_t rxpos = 0;

// Optional: PWM mapping for outputs (set to -1 to disable)
const int pwmPins[CHANNELS] = {3, 5, 6, 9, 10, 11, -1, -1};

void setup() {
  Serial.begin(115200);
  Wire.begin(AIO_ADDR);                // join I2C bus as slave
  Wire.onReceive(receiveEvent);
  Wire.onRequest(requestEvent);

  // init outputs
  for (int i = 0; i < CHANNELS; ++i) {
    aout[i] = 0.0;
    if (pwmPins[i] >= 0) {
      pinMode(pwmPins[i], OUTPUT);
      analogWrite(pwmPins[i], 0);
    }
  }

  Serial.println("AIO slave started");
}

void loop() {
  // sample analog inputs periodically
  for (int i = 0; i < CHANNELS; ++i) {
    int pin = i; // A0..A7 assumed mapped to channels 1..8
    int raw = analogRead(pin);
    float v = (raw / 1023.0) * AREF_V * VOLTAGE_DIVIDER;
    ain[i] = v;
  }

  // For convenience, print the CSV periodically for serial-to-dev bridge
  static unsigned long lastPrint = 0;
  if (millis() - lastPrint > 1000) {
    lastPrint = millis();
    // send a marker line starting with RESP: followed by CSV
    Serial.print("RESP:");
    for (int i = 0; i < CHANNELS; ++i) {
      if (i) Serial.print(',');
      Serial.print(ain[i], 2);
    }
    Serial.println();
  }

  // process any received ascii in rxbuf (already filled by receiveEvent)
  if (rxpos > 0) {
    rxbuf[rxpos] = '\0';
    parseRx(rxbuf);
    rxpos = 0;
  }

  delay(50);
}

void receiveEvent(int howMany) {
  while (Wire.available() && rxpos < (int)sizeof(rxbuf) - 1) {
    char c = (char)Wire.read();
    // accumulate; allow newline-terminated commands
    if (c == '\n' || c == '\r') {
      rxbuf[rxpos] = '\0';
      parseRx(rxbuf);
      rxpos = 0;
    } else {
      rxbuf[rxpos++] = c;
    }
  }
}

void requestEvent() {
  // Build CSV response from ain[] (8 values)
  char out[128];
  int pos = 0;
  for (int i = 0; i < CHANNELS; ++i) {
    if (i) out[pos++] = ',';
    // write with two decimals
    int n = snprintf(out + pos, sizeof(out) - pos, "%.2f", ain[i]);
    if (n < 0) break;
    pos += n;
    if (pos >= (int)sizeof(out) - 2) break;
  }
  out[pos] = '\0';
  Wire.write((uint8_t *)out, strlen(out));
}

void parseRx(const char *cmd) {
  if (!cmd || !cmd[0]) return;
  // expected format: OUT{ch}:{voltage}
  // example: OUT1:12.0
  if (strncmp(cmd, "OUT", 3) == 0) {
    int ch = atoi(cmd + 3);
    const char *p = strchr(cmd, ':');
    if (p) {
      float v = atof(p + 1);
      if (ch >= 1 && ch <= CHANNELS) {
        aout[ch - 1] = v;
        // optionally drive PWM
        int pwm = pwmPins[ch - 1];
        if (pwm >= 0) {
          // scale v (assume 0..24V) to 0..255 for PWM
          float scaled = constrain(v / 24.0, 0.0, 1.0) * 255.0;
          analogWrite(pwm, (int)scaled);
        }
      }
    }
  }
  // other commands can be added here
}

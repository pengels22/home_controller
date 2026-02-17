#!/usr/bin/env python3
"""
Read RESP: CSV lines from an Arduino on serial and write into
home_controller/config/dev_i2c.json under the provided address key.

Usage:
  python3 tools/arduino_serial_to_dev.py --port /dev/ttyUSB0 --addr 0x30

This makes it easy to use a real Arduino as a data source for the
backend's dev-mode JSON file.
"""

import argparse
import json
import os
import serial
import time

DEFAULT_DEV_FILE = os.path.join(os.path.dirname(__file__), '..', 'home_controller', 'config', 'dev_i2c.json')


def load_dev(dev_file):
    if not os.path.exists(dev_file):
        return {}
    try:
        with open(dev_file, 'r', encoding='utf-8') as f:
            return json.load(f) or {}
    except Exception:
        return {}


def save_dev(dev_file, data):
    os.makedirs(os.path.dirname(dev_file), exist_ok=True)
    tmp = dev_file + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(data, f, indent=2, sort_keys=True)
    os.replace(tmp, dev_file)


if __name__ == '__main__':
    p = argparse.ArgumentParser()
    p.add_argument('--port', required=True, help='Serial device (e.g. /dev/ttyUSB0)')
    p.add_argument('--baud', type=int, default=115200)
    p.add_argument('--addr', default='0x30', help='I2C address key to write into dev file (e.g. 0x30)')
    p.add_argument('--devfile', default=DEFAULT_DEV_FILE, help='Path to dev_i2c.json')
    args = p.parse_args()

    port = args.port
    baud = args.baud
    addr_key = str(args.addr).lower()
    if not addr_key.startswith('0x'):
        # normalize
        addr_key = f"0x{int(addr_key,0):02x}"

    dev_file = os.path.abspath(args.devfile)
    print('Using dev file:', dev_file)

    ser = serial.Serial(port, baud, timeout=1)
    print('Opened serial', port, 'at', baud)

    dev = load_dev(dev_file)
    print('Initial dev entries:', list(dev.keys()))

    try:
        while True:
            line = ser.readline().decode('utf-8', errors='ignore').strip()
            if not line:
                time.sleep(0.1)
                continue
            # expected lines: RESP:val1,val2,...
            if line.startswith('RESP:'):
                csv = line[len('RESP:'):].strip()
                parts = [p.strip() for p in csv.split(',') if p.strip()]
                values = []
                for p in parts:
                    try:
                        values.append(float(p))
                    except Exception:
                        values.append(0.0)
                # save into dev structure
                dev.setdefault(addr_key, {})
                dev[addr_key]['channels'] = values
                dev[addr_key]['raw_response'] = ','.join(str(v) for v in values)
                save_dev(dev_file, dev)
                print(time.strftime('%H:%M:%S'), 'Wrote', addr_key, '->', dev[addr_key]['raw_response'])
            else:
                print('SERIAL:', line)
    except KeyboardInterrupt:
        print('Exiting')
    finally:
        ser.close()

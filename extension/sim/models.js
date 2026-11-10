// Electrical and behavioural models for each part. A model can define:
//   setup(ctx)     add electrical elements and pin watchers
//   start(ctx)     run once the circuit is solvable
//   onControl(ctx, id, value)  react to the student using the part
//   follow(ctx)    re-drive outputs from the present inputs, before anything is measured
//   sample(ctx, phase)  record measurements, 'high' and 'low' for fast-toggling pins
//   check(ctx)     report the part being used outside its ratings, once a frame
//   view(ctx)      what the panel should draw
//   i2c, spi, neopixel  bus behaviour
import { VCC } from './circuit.js';
import { Ds18b20 } from './onewire.js';

const LED_BURN_AMPS = 0.04;
const LED_FULL_AMPS = 0.01;
const LED_REVERSE_WARN_VOLTS = 1;
const LED_REVERSE_MAX_VOLTS = 5;
const RESISTOR_WATTS = 0.25;
const DIODE_MAX_AMPS = 1;
const NPN_MAX_COLLECTOR_AMPS = 0.6;
const NPN_MAX_BASE_AMPS = 0.1;
const BATTERY_MAX_AMPS = 2;
// Below 1uF a capacitor is usually ceramic, which has no polarity.
const POLARIZED_MICROFARADS = 1;
const CAPACITOR_MAX_VOLTS = 16;
const CAPACITOR_REVERSE_VOLTS = 0.5;
// A passive piezo needs this much change in voltage across it to be heard.
const PIEZO_SWING_VOLTS = 1;
const ACTIVE_BUZZER_VOLTS = 2;
const ACTIVE_BUZZER_HZ = 2300;

// The meter's dial, in the order of its `mode` control.
const METER_AMPS = 1;
const METER_OHMS = 2;
const METER_SHUNT_OHMS = 0.5;
const METER_FUSE_AMPS = 1;
const METER_TEST_VOLTS = 0.2;
const METER_TEST_OHMS = 10000;
const METER_MAX_OHMS = 4e7;

const FORWARD_VOLTS = { red: 1.8, orange: 2, yellow: 2, green: 2.2, blue: 3, white: 3, infrared: 1.2 };

const amps = (element) => element.group.solver.currentThrough(element);

// Blends a high and low measurement using the duty cycle of whichever pin toggles this part.
function blend(ctx, high, low, ...pins) {
  if (high === low) return high;
  for (const pin of pins) {
    const duty = ctx.duty(pin);
    if (duty !== null) return duty * high + (1 - duty) * low;
  }
  return (high + low) / 2;
}

const brightness = (current) => Math.round(Math.min(1, Math.max(0, current) / LED_FULL_AMPS) ** 0.6 * 100) / 100;

// One LED die, shared by the LED, RGB LED, bar graph and 7-segment parts.
class Lamp {
  constructor(ctx, anode, cathode, color = 'red', label = 'LED') {
    this.ctx = ctx;
    this.anode = anode;
    this.cathode = cathode;
    this.label = label;
    this.element = ctx.diode(anode, cathode, FORWARD_VOLTS[color] ?? 2, 8);
    this.high = 0;
    this.low = 0;
    this.burned = null;
  }

  sample(phase) {
    this[phase] = this.element.amps;
  }

  level() {
    // It stays broken, so the problem stays on show until the next run.
    if (this.burned) {
      this.ctx.problem('error', this.burned);
      return 0;
    }
    const current = blend(this.ctx, this.high, this.low, this.anode, this.cathode);
    if (current > LED_BURN_AMPS) {
      this.burned = `${this.label} burned out at ${(current * 1000).toFixed(0)}mA. Add a series resistor.`;
      this.element.forwardVolts = 1000;
      this.element.on = false;
      this.ctx.circuit.markDirty(this.element);
      this.ctx.problem('error', this.burned);
      return 0;
    }
    return brightness(current);
  }
}

const lampModel = {
  setup(ctx) {
    ctx.lamp = new Lamp(ctx, 'A', 'K', ctx.props.color, 'This LED');
  },
  sample(ctx, phase) {
    ctx.lamp.sample(phase);
  },
  check(ctx) {
    const reverse = ctx.difference('K', 'A');
    if (reverse > LED_REVERSE_MAX_VOLTS) {
      ctx.problem('error', `This LED has ${reverse.toFixed(1)}V across it backwards, above its ${LED_REVERSE_MAX_VOLTS}V limit.`);
    } else if (reverse > LED_REVERSE_WARN_VOLTS) {
      ctx.problem('warning', 'This LED is backwards, so it cannot light. Swap its legs.');
    }
  },
  view(ctx) {
    return { brightness: ctx.lamp.level(), burned: !!ctx.lamp.burned };
  },
};

// A device that speaks I2C through a simple register file.
function registerDevice(address, { read, write } = {}) {
  return {
    address: () => address,
    write(ctx, data) {
      ctx.registers ??= new Uint8Array(256);
      ctx.pointer = data[0] ?? 0;
      for (let i = 1; i < data.length; i++) {
        ctx.registers[ctx.pointer] = data[i];
        write?.(ctx, ctx.pointer, data[i]);
        ctx.pointer = (ctx.pointer + 1) & 0xff;
      }
    },
    read(ctx, buffer) {
      ctx.registers ??= new Uint8Array(256);
      for (let i = 0; i < buffer.length; i++) {
        buffer[i] = read?.(ctx, ctx.pointer) ?? ctx.registers[ctx.pointer];
        ctx.pointer = (ctx.pointer + 1) & 0xff;
      }
    },
  };
}

// Breakout boards carry their own I2C pull-up resistors.
function i2cBreakout(ctx) {
  ctx.resistor('SDA', 'VCC', 10000);
  ctx.resistor('SCL', 'VCC', 10000);
  ctx.resistor('VCC', 'GND', 10000);
}

// HD44780 controller in 4-bit mode, used by the parallel and I2C backpack LCDs.
class CharacterController {
  constructor() {
    this.ram = new Array(0x68).fill(0x20);
    this.address = 0;
    this.highNibble = null;
    this.displayOn = false;
  }

  nibble(value, isData) {
    if (this.highNibble === null) {
      this.highNibble = value;
      return;
    }
    const byte = (this.highNibble << 4) | value;
    this.highNibble = null;
    if (isData) {
      this.ram[this.address] = byte;
      this.address = (this.address + 1) % this.ram.length;
    } else {
      this.command(byte);
    }
  }

  command(byte) {
    if (byte === 0x01) {
      this.ram.fill(0x20);
      this.address = 0;
    } else if (byte === 0x02) {
      this.address = 0;
    } else if (byte & 0x80) {
      this.address = byte & 0x7f;
    } else if ((byte & 0xf8) === 0x08) {
      this.displayOn = !!(byte & 0x04);
    }
  }

  lines() {
    const text = (start) => String.fromCharCode(...this.ram.slice(start, start + 16));
    return [text(0x00), text(0x40)];
  }
}

const clamp = (value, low, high) => Math.min(high, Math.max(low, value));

// What the meter's display shows, with the unit scaled to suit the value.
function meterText(value, unit) {
  const size = Math.abs(value);
  if (unit === 'V') return { reading: value.toFixed(2), unit };
  if (unit === 'A') return size < 1 ? { reading: (value * 1000).toFixed(1), unit: 'mA' } : { reading: value.toFixed(2), unit };
  if (size < 1000) return { reading: value.toFixed(value < 10 ? 1 : 0), unit };
  if (size < 1e6) return { reading: (value / 1000).toFixed(2), unit: `k${unit}` };
  return { reading: (value / 1e6).toFixed(2), unit: `M${unit}` };
}

// A meter finds resistance by pushing a small test voltage through a known resistance. Anything
// outside what that alone could produce means the circuit is powered.
function meterOhms(ctx) {
  const volts = ctx.difference('V', 'COM');
  if (volts < -1e-6 || volts > METER_TEST_VOLTS) {
    ctx.problem('warning', 'Ohms only works on an unpowered part. Disconnect it first.');
    return { reading: 'LIVE', unit: '' };
  }
  const ohms = (METER_TEST_OHMS * volts) / (METER_TEST_VOLTS - volts);
  return ohms > METER_MAX_OHMS ? { reading: 'OL', unit: 'Ω' } : meterText(Math.max(0, ohms), 'Ω');
}

export const MODELS = {
  resistor: {
    setup(ctx) {
      ctx.element = ctx.resistor('1', '2', ctx.props.ohms ?? 220);
      ctx.high = 0;
      ctx.low = 0;
    },
    sample(ctx, phase) {
      ctx[phase] = amps(ctx.element) ** 2 * ctx.element.ohms;
    },
    check(ctx) {
      const watts = blend(ctx, ctx.high, ctx.low, '1', '2');
      if (watts > RESISTOR_WATTS) {
        ctx.problem('error', `This resistor is burning ${watts.toFixed(2)}W, above its ${RESISTOR_WATTS}W rating. Use a larger value.`);
      }
    },
  },
  capacitor: {
    check(ctx) {
      if ((ctx.props.microfarads ?? 0) < POLARIZED_MICROFARADS) return;
      const volts = ctx.difference('+', '-');
      if (volts < -CAPACITOR_REVERSE_VOLTS) {
        ctx.problem('error', 'This capacitor is wired backwards. Connect its + leg to the higher voltage.');
      } else if (volts > CAPACITOR_MAX_VOLTS) {
        ctx.problem('error', `This capacitor has ${volts.toFixed(1)}V across it, above its ${CAPACITOR_MAX_VOLTS}V rating.`);
      }
    },
  },
  diode: {
    setup(ctx) {
      ctx.element = ctx.diode('A', 'K', 0.7, 0.5);
    },
    check(ctx) {
      if (ctx.element.amps > DIODE_MAX_AMPS) {
        ctx.problem('error', `This diode is carrying ${ctx.element.amps.toFixed(1)}A, above its ${DIODE_MAX_AMPS}A limit. Add a resistor.`);
      }
    },
  },
  led: lampModel,
  'rgb-led': {
    setup(ctx) {
      const anode = ctx.props.common === 'anode';
      ctx.lamps = [['R', 'red'], ['G', 'green'], ['B', 'blue']].map(([pin, color]) => (
        anode ? new Lamp(ctx, 'COM', pin, color, 'RGB LED') : new Lamp(ctx, pin, 'COM', color, 'RGB LED')));
    },
    sample(ctx, phase) {
      ctx.lamps.forEach((lamp) => lamp.sample(phase));
    },
    view(ctx) {
      return { rgb: ctx.lamps.map((lamp) => lamp.level()) };
    },
  },
  npn: {
    setup(ctx) {
      ctx.element = ctx.npn('B', 'C', 'E');
    },
    check(ctx) {
      const { baseAmps, collectorAmps } = ctx.element;
      if (baseAmps > NPN_MAX_BASE_AMPS) {
        ctx.problem('error', `The transistor's base is drawing ${(baseAmps * 1000).toFixed(0)}mA. Add a base resistor.`, 'B');
      }
      if (collectorAmps > NPN_MAX_COLLECTOR_AMPS) {
        ctx.problem('error', `The transistor is switching ${(collectorAmps * 1000).toFixed(0)}mA, above its ${NPN_MAX_COLLECTOR_AMPS * 1000}mA limit.`, 'C');
      }
    },
  },
  nmos: {
    setup(ctx) {
      ctx.nmos('G', 'D', 'S');
    },
  },

  button: {
    setup(ctx) {
      ctx.contact = ctx.switch('1a', '2a');
    },
    onControl(ctx, id, value) {
      ctx.setSwitch(ctx.contact, !!value);
    },
    view: (ctx) => ({ pressed: !!ctx.controls.pressed }),
  },
  'slide-switch': {
    setup(ctx) {
      ctx.left = ctx.switch('COM', '1', true);
      ctx.right = ctx.switch('COM', '2', false);
    },
    onControl(ctx, id, value) {
      ctx.setSwitch(ctx.left, !value);
      ctx.setSwitch(ctx.right, !!value);
    },
    view: (ctx) => ({ position: ctx.controls.position ? 1 : 0 }),
  },
  'tilt-switch': {
    setup(ctx) {
      ctx.contact = ctx.switch('1', '2', true);
    },
    onControl(ctx, id, value) {
      ctx.setSwitch(ctx.contact, !value);
    },
    view: (ctx) => ({ tilted: !!ctx.controls.tilted }),
  },
  potentiometer: {
    setup(ctx) {
      const total = ctx.props.ohms ?? 10000;
      ctx.total = total;
      ctx.lower = ctx.resistor('1', 'W', total / 2);
      ctx.upper = ctx.resistor('W', '2', total / 2);
    },
    onControl(ctx, id, value) {
      ctx.setResistance(ctx.lower, Math.max(1, ctx.total * value));
      ctx.setResistance(ctx.upper, Math.max(1, ctx.total * (1 - value)));
    },
    view: (ctx) => ({ position: ctx.controls.position }),
  },
  'rotary-encoder': {
    setup(ctx) {
      ctx.resistor('CLK', '+', 10000);
      ctx.resistor('DT', '+', 10000);
      ctx.resistor('SW', '+', 10000);
      ctx.clk = ctx.switch('CLK', 'GND');
      ctx.dt = ctx.switch('DT', 'GND');
      ctx.button = ctx.switch('SW', 'GND');
      ctx.lastSteps = 0;
    },
    onControl(ctx, id, value) {
      if (id === 'pressed') {
        ctx.setSwitch(ctx.button, !!value);
        return;
      }
      const delta = value - ctx.lastSteps;
      ctx.lastSteps = value;
      const [first, second] = delta > 0 ? [ctx.clk, ctx.dt] : [ctx.dt, ctx.clk];
      for (let step = 0; step < Math.abs(delta); step++) {
        const base = step * 8;
        ctx.after(base + 1, () => ctx.setSwitch(first, true));
        ctx.after(base + 3, () => ctx.setSwitch(second, true));
        ctx.after(base + 5, () => ctx.setSwitch(first, false));
        ctx.after(base + 7, () => ctx.setSwitch(second, false));
      }
    },
    view: (ctx) => ({ steps: ctx.controls.steps, pressed: !!ctx.controls.pressed }),
  },
  joystick: {
    setup(ctx) {
      ctx.xLow = ctx.resistor('GND', 'VRx', 5000);
      ctx.xHigh = ctx.resistor('VRx', '+5V', 5000);
      ctx.yLow = ctx.resistor('GND', 'VRy', 5000);
      ctx.yHigh = ctx.resistor('VRy', '+5V', 5000);
      ctx.button = ctx.switch('SW', 'GND');
    },
    onControl(ctx, id, value) {
      if (id === 'pressed') {
        ctx.setSwitch(ctx.button, !!value);
      } else {
        const [low, high] = id === 'x' ? [ctx.xLow, ctx.xHigh] : [ctx.yLow, ctx.yHigh];
        ctx.setResistance(low, Math.max(1, 10000 * value));
        ctx.setResistance(high, Math.max(1, 10000 * (1 - value)));
      }
    },
    view: (ctx) => ({ x: ctx.controls.x, y: ctx.controls.y, pressed: !!ctx.controls.pressed }),
  },
  'keypad-4x4': {
    setup(ctx) {
      ctx.keys = [];
      for (let r = 1; r <= 4; r++) for (let c = 1; c <= 4; c++) ctx.keys.push(ctx.switch(`R${r}`, `C${c}`));
    },
    onControl(ctx, id, value) {
      ctx.keys.forEach((key, index) => ctx.setSwitch(key, value === index + 1));
    },
    view: (ctx) => ({ key: ctx.controls.key }),
  },
  'touch-pad': {
    view: (ctx) => ({ pressed: !!ctx.controls.pressed }),
  },

  photoresistor: {
    setup(ctx) {
      ctx.element = ctx.resistor('1', '2', 10000);
    },
    start(ctx) {
      MODELS.photoresistor.onControl(ctx, 'light', ctx.controls.light);
    },
    // About 1 megohm in the dark, falling to 1 kilohm in bright light.
    onControl(ctx, id, value) {
      ctx.setResistance(ctx.element, 1e6 * 10 ** (-3 * value));
    },
    view: (ctx) => ({ light: ctx.controls.light }),
  },
  thermistor: {
    setup(ctx) {
      ctx.element = ctx.resistor('1', '2', 10000);
    },
    start(ctx) {
      MODELS.thermistor.onControl(ctx, 'celsius', ctx.controls.celsius);
    },
    // Beta model for a 10k NTC with B = 3950.
    onControl(ctx, id, value) {
      const kelvin = value + 273.15;
      ctx.setResistance(ctx.element, 10000 * Math.exp(3950 * (1 / kelvin - 1 / 298.15)));
    },
    view: (ctx) => ({ celsius: ctx.controls.celsius }),
  },
  fsr: {
    setup(ctx) {
      ctx.element = ctx.resistor('1', '2', 1e7);
    },
    onControl(ctx, id, value) {
      ctx.setResistance(ctx.element, value <= 0 ? 1e7 : 300 + 100000 * (1 - value) ** 3);
    },
    view: (ctx) => ({ force: ctx.controls.force }),
  },

  tmp36: {
    setup(ctx) {
      ctx.resistor('VS', 'GND', 100000);
      ctx.out = ctx.output('OUT', { ohms: 100 });
    },
    update(ctx) {
      ctx.out.set(ctx.powered('VS', 'GND', 2.5) ? 0.5 + ctx.controls.celsius * 0.01 : null);
    },
    start: (ctx) => MODELS.tmp36.update(ctx),
    onControl: (ctx) => MODELS.tmp36.update(ctx),
    follow: (ctx) => MODELS.tmp36.update(ctx),
    view: (ctx) => ({ celsius: ctx.controls.celsius, powered: ctx.powered('VS', 'GND', 2.5) }),
  },
  dht: {
    setup(ctx) {
      ctx.resistor('DATA', 'VCC', 5100);
      ctx.resistor('VCC', 'GND', 100000);
      ctx.pull = ctx.switch('DATA', 'GND', false, 5);
      ctx.watch('DATA', (high, time) => {
        if (ctx.sending) return;
        if (!high) ctx.fellAt = time;
        else if (ctx.fellAt !== undefined && time - ctx.fellAt >= 0.5 && ctx.powered()) MODELS.dht.reply(ctx, time);
      });
    },
    reply(ctx, time) {
      const isDht22 = ctx.props.model === 'DHT22';
      const celsius = ctx.controls.celsius;
      const humidity = ctx.controls.humidity;
      let bytes;
      if (isDht22) {
        const h = Math.round(humidity * 10);
        const t = Math.round(Math.abs(celsius) * 10) | (celsius < 0 ? 0x8000 : 0);
        bytes = [h >> 8, h & 0xff, t >> 8, t & 0xff];
      } else {
        bytes = [Math.round(humidity), 0, Math.round(celsius), 0];
      }
      bytes.push(bytes.reduce((a, b) => a + b, 0) & 0xff);
      const phases = [[true, 0.03], [false, 0.08], [true, 0.08]];
      for (const byte of bytes) {
        for (let bit = 7; bit >= 0; bit--) {
          phases.push([false, 0.05]);
          phases.push([true, (byte >> bit) & 1 ? 0.07 : 0.026]);
        }
      }
      phases.push([false, 0.05]);
      ctx.sending = true;
      let at = time;
      for (const [high, length] of phases) {
        at += length;
        ctx.at(at - length, () => ctx.setSwitch(ctx.pull, !high));
      }
      ctx.at(at, () => {
        ctx.setSwitch(ctx.pull, false);
        ctx.sending = false;
      });
    },
    view: (ctx) => ({ celsius: ctx.controls.celsius, humidity: ctx.controls.humidity }),
  },
  ds18b20: {
    setup(ctx) {
      ctx.resistor('VDD', 'GND', 100000);
      ctx.device = new Ds18b20(() => ctx.controls.celsius);
      ctx.circuit.oneWireDevices.push({ node: ctx.node('DQ'), device: ctx.device, ctx });
    },
    view: (ctx) => ({ celsius: ctx.controls.celsius }),
  },
  hcsr04: {
    setup(ctx) {
      ctx.resistor('VCC', 'GND', 500);
      ctx.echo = ctx.output('ECHO');
      ctx.watch('TRIG', (high, time) => {
        if (high || ctx.busy || !ctx.powered('VCC', 'GND', 4)) return;
        ctx.busy = true;
        const volts = ctx.volts('VCC');
        const start = time + 0.25;
        const length = ctx.controls.distance * 0.0583;
        ctx.at(start, () => ctx.echo.set(volts));
        ctx.at(start + length, () => {
          ctx.echo.set(0);
          ctx.busy = false;
        });
      });
    },
    start: (ctx) => ctx.echo.set(0),
    view(ctx) {
      if (ctx.difference('VCC', 'GND') > 1 && !ctx.powered('VCC', 'GND', 4)) {
        ctx.problem('warning', 'The HC-SR04 needs 5V to work.');
      }
      return { distance: ctx.controls.distance };
    },
  },
  pir: {
    setup(ctx) {
      ctx.resistor('VCC', 'GND', 10000);
      ctx.out = ctx.output('OUT');
      ctx.triggeredUntil = 0;
    },
    update(ctx) {
      if (!ctx.powered()) {
        ctx.out.set(null);
        return;
      }
      ctx.out.set(ctx.controls.motion || ctx.now() < ctx.triggeredUntil ? VCC : 0);
    },
    start: (ctx) => MODELS.pir.update(ctx),
    follow: (ctx) => MODELS.pir.update(ctx),
    onControl(ctx, id, value) {
      if (value) ctx.triggeredUntil = ctx.now() + 2000;
      MODELS.pir.update(ctx);
    },
    view: (ctx) => ({ active: ctx.now() < ctx.triggeredUntil || !!ctx.controls.motion }),
  },
  'sound-sensor': {
    setup(ctx) {
      ctx.resistor('VCC', 'GND', 10000);
      ctx.analog = ctx.output('AO');
      ctx.digital = ctx.output('DO');
    },
    update(ctx) {
      const supply = ctx.difference('VCC', 'GND');
      if (supply < 2.5) {
        ctx.analog.set(null);
        ctx.digital.set(null);
        return;
      }
      ctx.analog.set(supply * ctx.controls.level);
      ctx.digital.set(ctx.controls.level > 0.5 ? supply : 0);
    },
    start: (ctx) => MODELS['sound-sensor'].update(ctx),
    follow: (ctx) => MODELS['sound-sensor'].update(ctx),
    onControl: (ctx) => MODELS['sound-sensor'].update(ctx),
    view: (ctx) => ({ level: ctx.controls.level }),
  },
  'water-sensor': {
    setup(ctx) {
      ctx.resistor('+', '-', 10000);
      ctx.out = ctx.output('S', { gnd: '-' });
    },
    update(ctx) {
      const supply = ctx.difference('+', '-');
      ctx.out.set(supply < 2.5 ? null : supply * ctx.controls.level * 0.8);
    },
    start: (ctx) => MODELS['water-sensor'].update(ctx),
    follow: (ctx) => MODELS['water-sensor'].update(ctx),
    onControl: (ctx) => MODELS['water-sensor'].update(ctx),
    view: (ctx) => ({ level: ctx.controls.level }),
  },
  'ir-receiver': {
    setup(ctx) {
      ctx.resistor('VCC', 'GND', 10000);
      ctx.out = ctx.output('OUT');
    },
    start(ctx) {
      ctx.out.set(ctx.powered('VCC', 'GND', 2.5) ? ctx.volts('VCC') : null);
    },
    // Sends one NEC frame, with the output active low like a real receiver.
    onControl(ctx, id, value) {
      if (!value || !ctx.powered('VCC', 'GND', 2.5)) return;
      const keys = [0x45, 0x46, 0x47, 0x44, 0x40, 0x43, 0x07, 0x15, 0x09, 0x16, 0x19, 0x0d];
      const command = keys[value - 1];
      const volts = ctx.volts('VCC');
      const bytes = [0x00, 0xff, command, command ^ 0xff];
      const phases = [[0, 9], [1, 4.5]];
      for (const byte of bytes) {
        for (let bit = 0; bit < 8; bit++) {
          phases.push([0, 0.5625]);
          phases.push([1, (byte >> bit) & 1 ? 1.6875 : 0.5625]);
        }
      }
      phases.push([0, 0.5625]);
      let at = ctx.now();
      for (const [high, length] of phases) {
        ctx.at(at, () => ctx.out.set(high ? volts : 0));
        at += length;
      }
      ctx.at(at, () => ctx.out.set(volts));
    },
    view: (ctx) => ({ key: ctx.controls.key }),
  },
  mpu6050: {
    setup: i2cBreakout,
    i2c: registerDevice(0x68, {
      read(ctx, register) {
        if (register === 0x75) return 0x68;
        if (register < 0x3b || register > 0x48) return undefined;
        const radians = (degrees) => (degrees * Math.PI) / 180;
        const x = Math.sin(radians(ctx.controls.tiltX));
        const y = Math.sin(radians(ctx.controls.tiltY));
        const z = Math.sqrt(Math.max(0, 1 - x * x - y * y));
        const words = [x * 16384, y * 16384, z * 16384, (25 - 36.53) * 340, 0, 0, 0];
        const word = Math.round(words[(register - 0x3b) >> 1]) & 0xffff;
        return register & 1 ? word >> 8 : word & 0xff;
      },
      write(ctx, register, value) {
        if (register === 0x6b && value & 0x80) ctx.registers[0x6b] = 0x40;
        if (register === 0x68) ctx.registers[0x68] = 0;
      },
    }),
    view: (ctx) => ({ tiltX: ctx.controls.tiltX, tiltY: ctx.controls.tiltY }),
  },
  mcp9808: {
    setup: i2cBreakout,
    i2c: {
      address: () => 0x18,
      write(ctx, data) {
        if (data.length > 0) ctx.pointer = data[0];
      },
      read(ctx, buffer) {
        const raw = Math.round(ctx.controls.celsius * 16) & 0x1fff;
        const registers = { 5: [raw >> 8, raw & 0xff], 6: [0x00, 0x54], 7: [0x04, 0x00], 8: [0x03] };
        const value = registers[ctx.pointer] ?? [0, 0];
        for (let i = 0; i < buffer.length; i++) buffer[i] = value[i] ?? 0;
      },
    },
    view: (ctx) => ({ celsius: ctx.controls.celsius }),
  },
  ds3231: {
    setup: i2cBreakout,
    i2c: registerDevice(0x68, {
      read(ctx, register) {
        if (register > 6) return undefined;
        const date = new Date(Date.now() + (ctx.clockOffset ?? 0));
        const bcd = (value) => ((Math.floor(value / 10) << 4) | (value % 10));
        return [
          bcd(date.getSeconds()), bcd(date.getMinutes()), bcd(date.getHours()), date.getDay() || 7,
          bcd(date.getDate()), bcd(date.getMonth() + 1), bcd(date.getFullYear() % 100),
        ][register];
      },
      write(ctx, register) {
        if (register !== 6) return;
        const fromBcd = (value) => (value >> 4) * 10 + (value & 15);
        const r = ctx.registers;
        const target = new Date(2000 + fromBcd(r[6]), fromBcd(r[5] & 0x1f) - 1, fromBcd(r[4]),
          fromBcd(r[2]), fromBcd(r[1]), fromBcd(r[0]));
        ctx.clockOffset = target.getTime() - Date.now();
      },
    }),
  },

  // Neither kind makes a sound unless current can flow through it, so both legs must be wired.
  // A passive piezo only moves when its voltage changes: it plays the frequency it is switched at,
  // loudest at half duty, and a steady voltage is silent. An active one has its own oscillator and
  // sounds whenever its + leg has power.
  piezo: {
    setup(ctx) {
      ctx.resistor('+', '-', 1000);
      ctx.high = 0;
      ctx.low = 0;
    },
    sample(ctx, phase) {
      ctx[phase] = ctx.difference('+', '-');
    },
    view(ctx) {
      if (ctx.props.kind === 'active') {
        const on = Math.max(ctx.high, ctx.low) > ACTIVE_BUZZER_VOLTS;
        return { tone: on ? ACTIVE_BUZZER_HZ : 0, level: on ? 1 : 0 };
      }
      const drive = ctx.pwm('+');
      if (!drive || Math.abs(ctx.high - ctx.low) < PIEZO_SWING_VOLTS) return { tone: 0, level: 0 };
      // The loudness of a square wave's fundamental, which peaks at 50% duty.
      return { tone: drive.frequency, level: Math.round(Math.sin(Math.PI * drive.duty) * 100) / 100 };
    },
  },
  servo: {
    setup(ctx) {
      ctx.resistor('V+', 'GND', 100);
      ctx.resistor('SIG', 'GND', 100000);
      ctx.angle = 90;
    },
    view(ctx) {
      const signal = ctx.pwm('SIG');
      if (signal && signal.duty > 0 && ctx.powered('V+', 'GND', 3)) {
        const pulseMs = signal.duty * (1000 / signal.frequency);
        ctx.angle = clamp(((pulseMs - 0.5) / 2) * 180, 0, 180);
      }
      return { angle: Math.round(ctx.angle) };
    },
  },
  'dc-motor': {
    setup(ctx) {
      ctx.coil = ctx.resistor('1', '2', 30);
      ctx.high = 0;
      ctx.low = 0;
      ctx.angle = 0;
      ctx.lastView = 0;
    },
    sample(ctx, phase) {
      ctx[phase] = amps(ctx.coil);
    },
    view(ctx) {
      const current = blend(ctx, ctx.high, ctx.low, '1', '2');
      const speed = Math.abs(current) < 0.01 ? 0 : clamp(current / 0.15, -1, 1);
      const now = ctx.now();
      ctx.angle = (ctx.angle + speed * (now - ctx.lastView) * 0.72) % 360;
      ctx.lastView = now;
      return { speed: Math.round(speed * 100) / 100, angle: Math.round(ctx.angle) };
    },
  },
  'stepper-uln2003': {
    setup(ctx) {
      ctx.position = 0;
      ctx.phase = null;
      const phases = { 1: 0, 3: 1, 2: 2, 6: 3, 4: 4, 12: 5, 8: 6, 9: 7 };
      const update = () => {
        const mask = ['IN1', 'IN2', 'IN3', 'IN4'].reduce((sum, pin, i) => sum | (ctx.level(pin) ? 1 << i : 0), 0);
        const phase = phases[mask];
        if (phase === undefined || !ctx.powered('+', '-', 3)) return;
        if (ctx.phase !== null) {
          const delta = ((phase - ctx.phase + 12) % 8) - 4;
          if (Math.abs(delta) <= 2) ctx.position += delta;
        }
        ctx.phase = phase;
      };
      for (const pin of ['IN1', 'IN2', 'IN3', 'IN4']) {
        ctx.resistor(pin, '-', 10000);
        ctx.watch(pin, update);
      }
      ctx.resistor('+', '-', 1000);
    },
    view: (ctx) => ({ angle: Math.round((((ctx.position / 4096) * 360) % 360 + 360) % 360) }),
  },
  'relay-module': {
    setup(ctx) {
      ctx.resistor('IN', 'VCC', 10000);
      ctx.resistor('VCC', 'GND', 500);
      ctx.no = ctx.switch('COM', 'NO', false);
      ctx.nc = ctx.switch('COM', 'NC', true);
      const update = () => {
        ctx.energized = ctx.powered('VCC', 'GND', 3) && !ctx.level('IN');
        ctx.setSwitch(ctx.no, ctx.energized);
        ctx.setSwitch(ctx.nc, !ctx.energized);
      };
      ctx.update = update;
      ctx.watch('IN', update);
    },
    start: (ctx) => ctx.update(),
    view: (ctx) => ({ energized: !!ctx.energized }),
  },
  neopixel: {
    setup(ctx) {
      ctx.resistor('5V', 'GND', 500);
      ctx.pixels = new Array(ctx.props.count ?? 8).fill('000000');
    },
    neopixel(ctx, data) {
      if (!ctx.powered('5V', 'GND', 3)) return;
      const hex = (value) => value.toString(16).padStart(2, '0');
      for (let i = 0; i < ctx.pixels.length; i++) {
        if (i * 3 + 2 >= data.length) break;
        ctx.pixels[i] = hex(data[i * 3 + 1]) + hex(data[i * 3]) + hex(data[i * 3 + 2]);
      }
    },
    view: (ctx) => ({ pixels: ctx.pixels }),
  },

  'seven-segment': {
    setup(ctx) {
      const anode = ctx.props.common === 'anode';
      ctx.lamps = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'DP'].map((pin) => (
        anode ? new Lamp(ctx, 'COM1', pin, 'red', `Segment ${pin}`) : new Lamp(ctx, pin, 'COM1', 'red', `Segment ${pin}`)));
    },
    sample(ctx, phase) {
      ctx.lamps.forEach((lamp) => lamp.sample(phase));
    },
    view: (ctx) => ({ segments: ctx.lamps.map((lamp) => lamp.level()) }),
  },
  // Multiplexed displays switch too fast for one snapshot, so on-time is accumulated per segment.
  'seven-segment-4': {
    setup(ctx) {
      ctx.segmentPins = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'DP'];
      ctx.digitPins = ['D1', 'D2', 'D3', 'D4'];
      ctx.onTime = ctx.digitPins.map(() => new Array(8).fill(0));
      ctx.last = 0;
      ctx.frameStart = 0;
      ctx.state = ctx.digitPins.map(() => new Array(8).fill(false));
      const update = (_level, time) => {
        const span = time - ctx.last;
        ctx.state.forEach((digit, d) => digit.forEach((on, s) => {
          if (on) ctx.onTime[d][s] += span;
        }));
        ctx.last = time;
        ctx.state = ctx.digitPins.map((digit) => ctx.segmentPins.map((segment) => ctx.level(segment) && !ctx.level(digit)));
      };
      ctx.update = update;
      for (const pin of [...ctx.segmentPins, ...ctx.digitPins]) {
        ctx.resistor(pin, 'D1', 1e7);
        ctx.watch(pin, update);
      }
    },
    view(ctx) {
      const now = ctx.now();
      ctx.update(null, now);
      const span = Math.max(1, now - ctx.frameStart);
      const digits = ctx.onTime.map((digit) => digit.map((time) => Math.round(Math.min(1, (time / span) * 3) * 100) / 100));
      ctx.onTime = ctx.digitPins.map(() => new Array(8).fill(0));
      ctx.frameStart = now;
      return { digits };
    },
  },
  'led-bar': {
    setup(ctx) {
      ctx.lamps = Array.from({ length: 10 }, (_, i) => new Lamp(ctx, `A${i + 1}`, `K${i + 1}`, 'red', `Bar ${i + 1}`));
    },
    sample(ctx, phase) {
      ctx.lamps.forEach((lamp) => lamp.sample(phase));
    },
    view: (ctx) => ({ levels: ctx.lamps.map((lamp) => lamp.level()) }),
  },
  'led-matrix': {
    setup(ctx) {
      ctx.resistor('VCC', 'GND', 500);
      ctx.resistor('DIN', 'GND', 1e6);
      ctx.resistor('CS', 'VCC', 1e6);
      ctx.rows = new Array(8).fill(0);
      ctx.shutdown = true;
      ctx.intensity = 7;
      ctx.pending = [];
      ctx.watch('CS', (high) => {
        if (high) MODELS['led-matrix'].latch(ctx);
      });
    },
    spi: {
      clockPin: 'CLK',
      dataPin: 'DIN',
      transfer(ctx, data) {
        ctx.pending.push(...data);
      },
    },
    latch(ctx) {
      const bytes = ctx.pending.slice(-2);
      ctx.pending = [];
      if (bytes.length < 2) return;
      const [register, value] = bytes;
      if (register >= 1 && register <= 8) ctx.rows[register - 1] = value;
      else if (register === 0x0a) ctx.intensity = value & 0x0f;
      else if (register === 0x0c) ctx.shutdown = !(value & 1);
    },
    view(ctx) {
      return { rows: ctx.shutdown || !ctx.powered('VCC', 'GND', 3) ? new Array(8).fill(0) : ctx.rows, intensity: ctx.intensity };
    },
  },
  lcd1602: {
    setup(ctx) {
      ctx.lcd = new CharacterController();
      ctx.resistor('VDD', 'VSS', 10000);
      ctx.lamp = ctx.diode('LEDA', 'LEDK', 2.8, 20);
      ctx.resistor('E', 'VSS', 1e6);
      ctx.watch('E', (high) => {
        if (high) return;
        const data = ['D4', 'D5', 'D6', 'D7'].reduce((sum, pin, i) => sum | (ctx.level(pin) ? 1 << i : 0), 0);
        ctx.lcd.nibble(data, ctx.level('RS'));
      });
    },
    view(ctx) {
      return {
        lines: ctx.powered('VDD', 'VSS', 2.5) ? ctx.lcd.lines() : ['', ''],
        backlight: ctx.lamp.amps > 0.001,
      };
    },
  },
  'lcd-i2c': {
    setup(ctx) {
      i2cBreakout(ctx);
      ctx.lcd = new CharacterController();
      ctx.backlight = false;
    },
    // A PCF8574 expander: P0=RS, P1=RW, P2=E, P3=backlight, P4-P7=data.
    i2c: {
      address: () => 0x27,
      write(ctx, data) {
        for (const byte of data) {
          if (ctx.lastPort !== undefined && ctx.lastPort & 0x04 && !(byte & 0x04)) {
            ctx.lcd.nibble(ctx.lastPort >> 4, !!(ctx.lastPort & 0x01));
          }
          ctx.lastPort = byte;
          ctx.backlight = !!(byte & 0x08);
        }
      },
      read: (ctx, buffer) => buffer.fill(0xff),
    },
    view: (ctx) => ({ lines: ctx.lcd.lines(), backlight: ctx.backlight }),
  },
  'oled-ssd1306': {
    setup(ctx) {
      i2cBreakout(ctx);
      ctx.buffer = new Uint8Array(128 * 8);
      ctx.column = 0;
      ctx.page = 0;
      ctx.columnRange = [0, 127];
      ctx.pageRange = [0, 7];
      ctx.mode = 0;
      ctx.on = false;
      ctx.argsLeft = 0;
      ctx.revision = 0;
      ctx.sentRevision = -1;
    },
    i2c: {
      address: () => 0x3c,
      // Each control byte says whether what follows is a command or pixels. With its top bit
      // set, it covers one byte and another control byte follows.
      write(ctx, data) {
        const model = MODELS['oled-ssd1306'];
        let i = 0;
        while (i < data.length) {
          const control = data[i++];
          const end = control & 0x80 ? Math.min(i + 1, data.length) : data.length;
          for (; i < end; i++) {
            if (control & 0x40) model.pixelByte(ctx, data[i]);
            else model.command(ctx, data[i]);
          }
        }
      },
      read: (ctx, buffer) => buffer.fill(0),
    },
    pixelByte(ctx, byte) {
      ctx.buffer[ctx.page * 128 + ctx.column] = byte;
      ctx.revision++;
      ctx.column++;
      if (ctx.column > ctx.columnRange[1]) {
        ctx.column = ctx.columnRange[0];
        if (ctx.mode !== 2) {
          ctx.page++;
          if (ctx.page > ctx.pageRange[1]) ctx.page = ctx.pageRange[0];
        }
      }
    },
    command(ctx, byte) {
      if (ctx.argsLeft > 0) {
        ctx.args.push(byte);
        ctx.argsLeft--;
        if (ctx.argsLeft === 0) {
          if (ctx.command === 0x20) ctx.mode = ctx.args[0] & 3;
          if (ctx.command === 0x21) {
            ctx.columnRange = [ctx.args[0] & 127, ctx.args[1] & 127];
            ctx.column = ctx.columnRange[0];
          }
          if (ctx.command === 0x22) {
            ctx.pageRange = [ctx.args[0] & 7, ctx.args[1] & 7];
            ctx.page = ctx.pageRange[0];
          }
        }
        return;
      }
      const twoBytes = [0x21, 0x22, 0xda === byte ? 0xda : -1];
      if (byte === 0x20 || byte === 0x81 || byte === 0x8d || byte === 0xa8 || byte === 0xd3 || byte === 0xd5
        || byte === 0xd9 || byte === 0xda || byte === 0xdb) {
        ctx.command = byte;
        ctx.args = [];
        ctx.argsLeft = 1;
      } else if (twoBytes.includes(byte)) {
        ctx.command = byte;
        ctx.args = [];
        ctx.argsLeft = 2;
      } else if (byte === 0xae || byte === 0xaf) {
        ctx.on = byte === 0xaf;
        ctx.revision++;
      } else if (byte >= 0xb0 && byte <= 0xb7) {
        ctx.page = byte & 7;
      } else if (byte <= 0x0f) {
        ctx.column = (ctx.column & 0xf0) | byte;
      } else if (byte >= 0x10 && byte <= 0x1f) {
        ctx.column = (ctx.column & 0x0f) | ((byte & 0x0f) << 4);
      }
    },
    view(ctx) {
      if (ctx.revision === ctx.sentRevision) return undefined;
      ctx.sentRevision = ctx.revision;
      return { on: ctx.on, pixels: Buffer.from(ctx.buffer).toString('base64') };
    },
  },

  'shift-register': {
    setup(ctx) {
      ctx.shift = 0;
      ctx.outputs = Array.from({ length: 8 }, (_, i) => ctx.output(`Q${i}`));
      ctx.q7s = ctx.output('Q7S');
      ctx.latched = 0;
      ctx.resistor('VCC', 'GND', 10000);
      for (const pin of ['DS', 'SHCP', 'STCP', 'OE', 'MR']) ctx.resistor(pin, 'GND', 1e7);
      ctx.watch('SHCP', (high) => {
        if (!high) return;
        if (!ctx.level('MR')) ctx.shift = 0;
        else ctx.shift = ((ctx.shift << 1) | (ctx.level('DS') ? 1 : 0)) & 0xff;
        MODELS['shift-register'].drive(ctx);
      });
      ctx.watch('STCP', (high) => {
        if (!high) return;
        ctx.latched = ctx.shift;
        MODELS['shift-register'].drive(ctx);
      });
      ctx.watch('OE', () => MODELS['shift-register'].drive(ctx));
      ctx.watch('MR', (high) => {
        if (!high) ctx.shift = 0;
      });
    },
    drive(ctx) {
      const supply = ctx.difference('VCC', 'GND');
      const on = supply > 2 && !ctx.level('OE');
      ctx.outputs.forEach((output, i) => output.set(on ? ((ctx.latched >> i) & 1) * supply : null));
      ctx.q7s.set(supply > 2 ? ((ctx.shift >> 7) & 1) * supply : null);
    },
    start: (ctx) => MODELS['shift-register'].drive(ctx),
    spi: {
      clockPin: 'SHCP',
      dataPin: 'DS',
      outPin: 'Q7S',
      // Each byte pushes the previous one out of Q7S and into the next chip in a chain.
      transfer(ctx, data) {
        const enabled = ctx.level('MR');
        const shiftedOut = data.map((byte) => {
          const previous = ctx.shift;
          ctx.shift = enabled ? byte : 0;
          return previous;
        });
        MODELS['shift-register'].drive(ctx);
        return shiftedOut;
      },
    },
    view: (ctx) => ({ value: ctx.latched }),
  },
  l293d: {
    setup(ctx) {
      ctx.channels = [['EN1', 'IN1', 'OUT1'], ['EN1', 'IN2', 'OUT2'], ['EN2', 'IN3', 'OUT3'], ['EN2', 'IN4', 'OUT4']]
        .map(([enable, input, output]) => {
          ctx.link(output, enable);
          ctx.link(output, input);
          return { enable, input, driver: ctx.output(output, { gnd: 'GND1', ohms: 2 }) };
        });
      ctx.resistor('VCC', 'GND1', 10000);
      const update = () => {
        const supply = ctx.difference('VS', 'GND1');
        const logic = ctx.difference('VCC', 'GND1') > 2;
        for (const channel of ctx.channels) {
          const on = logic && ctx.level(channel.enable);
          channel.driver.set(on ? (ctx.level(channel.input) ? supply : 0) : null);
        }
      };
      ctx.update = update;
      for (const pin of ['EN1', 'EN2', 'IN1', 'IN2', 'IN3', 'IN4']) {
        ctx.resistor(pin, 'GND1', 1e7);
        ctx.watch(pin, update);
      }
    },
    start: (ctx) => ctx.update(),
    follow: (ctx) => ctx.update(),
  },

  battery: {
    setup(ctx) {
      ctx.element = ctx.source('+', '-', ctx.props.volts ?? 9, 0.5);
    },
    check(ctx) {
      const current = Math.abs(amps(ctx.element));
      if (current > BATTERY_MAX_AMPS) {
        ctx.problem('error', `This battery is delivering ${current.toFixed(1)}A, above its ${BATTERY_MAX_AMPS}A limit. Look for a short circuit.`);
      }
    },
  },

  // Volts need no connection between the probes. Amps close them through a small resistance, and
  // ohms drive a test voltage through them.
  multimeter: {
    setup(ctx) {
      ctx.shunt = ctx.switch('V', 'COM', false, METER_SHUNT_OHMS);
      ctx.test = ctx.output('V', { gnd: 'COM', ohms: METER_TEST_OHMS });
      ctx.high = { volts: 0, amps: 0 };
      ctx.low = { volts: 0, amps: 0 };
    },
    onControl(ctx, id, value) {
      ctx.setSwitch(ctx.shunt, value === METER_AMPS && !ctx.blown);
      ctx.test.set(value === METER_OHMS ? METER_TEST_VOLTS : null);
    },
    sample(ctx, phase) {
      ctx[phase] = { volts: ctx.difference('V', 'COM'), amps: amps(ctx.shunt) };
    },
    check(ctx) {
      if (!ctx.blown && Math.abs(amps(ctx.shunt)) > METER_FUSE_AMPS) {
        ctx.blown = true;
        ctx.setSwitch(ctx.shunt, false);
      }
      if (ctx.blown) ctx.problem('error', 'The meter blew its fuse. In Amps mode it must be in series, never across a supply.');
    },
    view(ctx) {
      const { mode } = ctx.controls;
      if (mode === METER_OHMS) return { mode, ...meterOhms(ctx) };
      if (mode === METER_AMPS) {
        if (ctx.blown) return { mode, reading: 'FUSE', unit: '' };
        return { mode, ...meterText(blend(ctx, ctx.high.amps, ctx.low.amps, 'V', 'COM'), 'A') };
      }
      return { mode, ...meterText(blend(ctx, ctx.high.volts, ctx.low.volts, 'V', 'COM'), 'V') };
    },
  },
};

// Runs real CircuitPython and real Adafruit libraries against the simulated parts.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { defaultProps, emptyCircuit } from '../shared/catalog.js';
import { buildNets, pinKey } from '../shared/nets.js';
import { Board } from '../sim/board-host.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const libs = path.join(here, '..', 'libs');

function libFiles(names) {
  const files = {};
  const add = (full, relative) => {
    if (fs.statSync(full).isDirectory()) {
      for (const entry of fs.readdirSync(full)) add(path.join(full, entry), `${relative}/${entry}`);
    } else {
      files[`/lib/${relative}`] = fs.readFileSync(full);
    }
  };
  for (const name of names) {
    const file = fs.existsSync(path.join(libs, `${name}.mpy`)) ? `${name}.mpy` : name;
    add(path.join(libs, file), file);
  }
  return files;
}

function circuit(parts, wires) {
  const doc = emptyCircuit();
  parts.forEach(([id, type, props = {}], i) => {
    doc.parts.push({ id, type, x: 0, y: 500 + i * 300, rotation: 0, props: { ...defaultProps(type), ...props } });
  });
  doc.wires = wires.map(([a, b]) => {
    const [fromPart, fromPin] = a.split(':');
    const [toPart, toPin] = b.split(':');
    return { id: `${a}-${b}`, from: { part: fromPart, pin: fromPin }, to: { part: toPart, pin: toPin }, points: [], color: '#000' };
  });
  return doc;
}

async function run({ code, parts = [], wires = [], libraries = [], until = 'Code done running', timeoutMs = 15000, during }) {
  const board = new Board({ files: { '/code.py': code, ...libFiles(libraries) }, circuit: circuit(parts, wires) });
  const views = {};
  let crash;
  board.on('frame', (frame) => Object.assign(views, frame.views));
  board.on('crash', (message) => { crash = message; });
  try {
    if (during) await during(board, views);
    await board.waitForOutput(until, timeoutMs);
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(crash, undefined);
    return { output: board.output.split('code.py output:')[1] ?? board.output, views };
  } finally {
    await board.stop();
  }
}

const POWER_3V = (id) => [['board:3V', `${id}:VCC`], [`${id}:GND`, 'board:GND1']];
const I2C = (id) => [...POWER_3V(id), ['board:SDA', `${id}:SDA`], ['board:SCL', `${id}:SCL`]];

test('blink drives the onboard LED', async () => {
  const { output } = await run({ code: 'import board, digitalio\nled = digitalio.DigitalInOut(board.LED)\nled.direction = digitalio.Direction.OUTPUT\nled.value = True\nprint("on")\n' });
  assert.match(output, /on/);
});

test('button on a breadboard-free circuit reaches Python', async () => {
  const code = `import board, digitalio, time
b = digitalio.DigitalInOut(board.D2)
b.switch_to_input(pull=digitalio.Pull.UP)
print("ready")
while b.value:
    time.sleep(0.01)
print("pressed")
`;
  const { output } = await run({
    code, parts: [['b1', 'button']], wires: [['board:D2', 'b1:1a'], ['b1:2a', 'board:GND1']],
    during: async (board) => {
      await board.waitForOutput('ready');
      board.setControl('b1', 'pressed', 1);
    },
  });
  assert.match(output, /pressed/);
});

test('character LCD with the real library', async () => {
  const code = `import board, digitalio
import adafruit_character_lcd.character_lcd as character_lcd
pins = [digitalio.DigitalInOut(p) for p in (board.D7, board.D8, board.D9, board.D10, board.D11, board.D12)]
lcd = character_lcd.Character_LCD_Mono(*pins, 16, 2)
lcd.message = "Hello, Metro!\\nCircuitPython"
print("lcd done")
`;
  const { output, views } = await run({
    code,
    libraries: ['adafruit_character_lcd'],
    parts: [['lcd', 'lcd1602']],
    wires: [['lcd:VSS', 'board:GND1'], ['lcd:VDD', 'board:5V'], ['lcd:RS', 'board:D7'], ['lcd:E', 'board:D8'], ['lcd:D4', 'board:D9'], ['lcd:D5', 'board:D10'], ['lcd:D6', 'board:D11'], ['lcd:D7', 'board:D12']],
  });
  assert.match(output, /lcd done/);
  assert.equal(views.lcd.lines[0].trim(), 'Hello, Metro!');
  assert.equal(views.lcd.lines[1].trim(), 'CircuitPython');
});

test('servo with adafruit_motor', async () => {
  const code = `import board, pwmio, time
from adafruit_motor import servo
pwm = pwmio.PWMOut(board.D9, duty_cycle=0, frequency=50)
motor = servo.Servo(pwm, min_pulse=500, max_pulse=2500)
motor.angle = 135
time.sleep(0.2)
print("done")
`;
  const { views } = await run({
    code, libraries: ['adafruit_motor'], parts: [['s', 'servo']],
    wires: [['board:5V', 's:V+'], ['s:GND', 'board:GND1'], ['board:D9', 's:SIG']],
  });
  assert.equal(views.s.angle, 135);
});

test('NeoPixel strip', async () => {
  const code = `import board, neopixel, time
pixels = neopixel.NeoPixel(board.D6, 8, auto_write=True, brightness=1.0)
pixels[2] = (10, 20, 30)
time.sleep(0.1)
print("done")
`;
  const { views } = await run({
    code, libraries: ['neopixel'], parts: [['n', 'neopixel']],
    wires: [['board:5V', 'n:5V'], ['n:GND', 'board:GND1'], ['board:D6', 'n:DIN']],
  });
  assert.equal(views.n.pixels[2], '0a141e');
});

test('MCP9808 over I2C with the real library', async () => {
  const code = `import board, busio, adafruit_mcp9808
sensor = adafruit_mcp9808.MCP9808(busio.I2C(board.SCL, board.SDA))
print("temperature", sensor.temperature)
`;
  const { output } = await run({ code, libraries: ['adafruit_mcp9808', 'adafruit_bus_device', 'adafruit_register'], parts: [['t', 'mcp9808']], wires: I2C('t') });
  assert.match(output, /temperature 22\.5/);
});

test('missing I2C wire gives the real pull-up error', async () => {
  const { output } = await run({ code: 'import board\nboard.I2C()\n', parts: [['t', 'mcp9808']], wires: POWER_3V('t') });
  assert.match(output, /No pull up found on SDA or SCL/);
});

test('MPU-6050 with the real library', async () => {
  const code = `import board, busio, adafruit_mpu6050
mpu = adafruit_mpu6050.MPU6050(busio.I2C(board.SCL, board.SDA))
x, y, z = mpu.acceleration
print("z", round(z))
`;
  const { output } = await run({ code, libraries: ['adafruit_mpu6050', 'adafruit_bus_device', 'adafruit_register'], parts: [['m', 'mpu6050']], wires: I2C('m') });
  assert.match(output, /z 10/);
});

test('DS3231 with the real library', async () => {
  const code = `import board, busio, adafruit_ds3231
rtc = adafruit_ds3231.DS3231(busio.I2C(board.SCL, board.SDA))
print("year", rtc.datetime.tm_year)
`;
  const { output } = await run({ code, libraries: ['adafruit_ds3231', 'adafruit_bus_device', 'adafruit_register'], parts: [['c', 'ds3231']], wires: I2C('c') });
  assert.match(output, new RegExp(`year ${new Date().getFullYear()}`));
});

test('74HC595 by hand with digitalio', async () => {
  const code = `import board, digitalio, time
data = digitalio.DigitalInOut(board.D2)
clock = digitalio.DigitalInOut(board.D3)
latch = digitalio.DigitalInOut(board.D4)
for pin in (data, clock, latch):
    pin.direction = digitalio.Direction.OUTPUT
value = 0b10100101
for bit in range(7, -1, -1):
    data.value = (value >> bit) & 1
    clock.value = True
    clock.value = False
latch.value = True
latch.value = False
time.sleep(0.1)
print("done")
`;
  const { views } = await run({
    code, parts: [['sr', 'shift-register']],
    wires: [...POWER_3V('sr'), ['board:3V', 'sr:MR'], ['sr:OE', 'board:GND1'], ['board:D2', 'sr:DS'], ['board:D3', 'sr:SHCP'], ['board:D4', 'sr:STCP']],
  });
  assert.equal(views.sr.value, 0b10100101);
});

test('keypad with keypad scanning in Python', async () => {
  const code = `import board, digitalio, time
row = digitalio.DigitalInOut(board.D2)
row.direction = digitalio.Direction.OUTPUT
row.value = False
col = digitalio.DigitalInOut(board.D3)
col.switch_to_input(pull=digitalio.Pull.UP)
print("ready")
while col.value:
    time.sleep(0.01)
print("key seen")
`;
  const { output } = await run({
    code, parts: [['k', 'keypad-4x4']], wires: [['board:D2', 'k:R1'], ['board:D3', 'k:C2']],
    during: async (board) => {
      await board.waitForOutput('ready');
      board.setControl('k', 'key', 2);
    },
  });
  assert.match(output, /key seen/);
});

test('examples wire up as intended', () => {
  const doc = JSON.parse(fs.readFileSync(path.join(here, '..', 'examples', 'led-and-button', 'circuit.json'), 'utf8'));
  const { sameNet } = buildNets(doc);
  assert.ok(sameNet(pinKey('board', 'D5'), pinKey('r1', '1')), 'D5 reaches the resistor');
  assert.ok(sameNet(pinKey('r1', '2'), pinKey('led1', 'A')), 'resistor reaches the LED');
  assert.ok(sameNet(pinKey('led1', 'K'), pinKey('board', 'GND1')), 'LED reaches ground');
  assert.ok(sameNet(pinKey('board', 'D2'), pinKey('button1', '1a')), 'D2 reaches the button');
  assert.ok(sameNet(pinKey('button1', '2a'), pinKey('board', 'GND1')), 'button reaches ground');
});

test('every example runs without an error', async () => {
  const root = path.join(here, '..', 'examples');
  for (const name of fs.readdirSync(root)) {
    const folder = path.join(root, name);
    const info = JSON.parse(fs.readFileSync(path.join(folder, 'example.json'), 'utf8'));
    const needs = { adafruit_character_lcd: ['adafruit_bus_device', 'adafruit_mcp230xx'] };
    const wanted = [...info.libraries, ...info.libraries.flatMap((library) => needs[library] ?? [])]
      .filter((library) => fs.existsSync(path.join(libs, library)) || fs.existsSync(path.join(libs, `${library}.mpy`)));
    const board = new Board({
      files: { '/code.py': fs.readFileSync(path.join(folder, 'code.py')), ...libFiles(wanted) },
      circuit: JSON.parse(fs.readFileSync(path.join(folder, 'circuit.json'), 'utf8')),
    });
    await board.waitForOutput('code.py output:');
    await new Promise((resolve) => setTimeout(resolve, 700));
    await board.stop();
    assert.doesNotMatch(board.output, /Traceback/, `${name}: ${board.output}`);
  }
});

test('a print loop reaches the host in paced batches', { timeout: 20000 }, async () => {
  const board = new Board({ files: { '/code.py': 'while True:\n    print("hello")\n' } });
  let messages = 0;
  board.on('serial', () => { messages++; });
  await new Promise((resolve) => setTimeout(resolve, 2000));
  await board.stop();
  assert.ok(board.output.includes('hello'));
  assert.ok(messages < 200, `${messages} messages in 2 seconds`);
});

test('nothing printed is lost or garbled by batching', async () => {
  const code = 'for i in range(400):\n    print("é" * 100)\nprint("ALL SENT")\n';
  const board = new Board({ files: { '/code.py': code } });
  const output = await board.waitForOutput('ALL SENT');
  await board.stop();
  assert.equal(output.split('é'.repeat(100)).length - 1, 400);
  assert.ok(!output.includes('\ufffd'));
});

test('a board that cannot start reports why and then ends', async () => {
  const board = new Board({ files: { '/code.py': 'print("hi")\n' }, circuit: { version: 1, parts: [], wires: [] } });
  const crashed = new Promise((resolve) => { board.once('crash', resolve); });
  const ended = new Promise((resolve) => { board.once('exit', resolve); });
  assert.match(await crashed, /The circuit has no board/);
  await ended;
});

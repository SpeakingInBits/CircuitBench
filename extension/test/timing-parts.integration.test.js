// The parts that depend on precise signals, each driven by its real Adafruit library.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { defaultProps, emptyCircuit } from '../shared/catalog.js';
import { Board } from '../sim/board-host.js';

const libs = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'libs');

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

async function run({ code, parts = [], wires = [], libraries = [], controls, until = 'Code done running', timeoutMs = 20000, during }) {
  const board = new Board({ files: { '/code.py': code, ...libFiles(libraries) }, circuit: circuit(parts, wires), controls });
  const views = {};
  const problems = [];
  let crash;
  board.on('frame', (frame) => {
    Object.assign(views, frame.views);
    problems.push(...frame.problems.map((p) => p.message));
  });
  board.on('crash', (message) => { crash = message; });
  try {
    if (during) await during(board, views);
    await board.waitForOutput(until, timeoutMs);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(crash, undefined);
    return { output: board.output.split('code.py output:')[1] ?? board.output, views, problems };
  } finally {
    await board.stop();
  }
}

const power = (id, rail = '3V') => [[`board:${rail}`, `${id}:VCC`], [`${id}:GND`, 'board:GND1']];

test('HC-SR04 with adafruit_hcsr04', async () => {
  const code = `import board, time, adafruit_hcsr04
sonar = adafruit_hcsr04.HCSR04(trigger_pin=board.D5, echo_pin=board.D6)
for i in range(5):
    try:
        print("distance", round(sonar.distance))
        break
    except RuntimeError as error:
        print("retry", error)
        time.sleep(0.1)
`;
  const { output, problems } = await run({
    code, libraries: ['adafruit_hcsr04'], parts: [['u', 'hcsr04']],
    wires: [...power('u', '5V'), ['board:D5', 'u:TRIG'], ['board:D6', 'u:ECHO']],
    controls: { 'u:distance': 100 },
  });
  assert.match(output, /distance (9[5-9]|10[0-5])/, output);
  assert.doesNotMatch(output, /retry/, 'the first reading works');
  assert.ok(problems.some((message) => message.includes('only tolerate 3.3V')), 'a 5V echo pin is flagged');
});

test('DHT11 with adafruit_dht', async () => {
  const code = `import board, time, adafruit_dht
sensor = adafruit_dht.DHT11(board.D5)
for i in range(6):
    try:
        print("reading", sensor.temperature, sensor.humidity)
        break
    except RuntimeError as error:
        print("retry", error)
        time.sleep(1)
`;
  const { output } = await run({
    code, libraries: ['adafruit_dht'], parts: [['d', 'dht']], wires: [...power('d'), ['board:D5', 'd:DATA']],
  });
  assert.match(output, /reading 22(\.0)? 45/, output);
});

test('DS18B20 with adafruit_ds18x20', async () => {
  const code = `import board
from adafruit_onewire.bus import OneWireBus
from adafruit_ds18x20 import DS18X20
bus = OneWireBus(board.D5)
devices = bus.scan()
print("found", len(devices))
print("temperature", DS18X20(bus, devices[0]).temperature)
`;
  const { output } = await run({
    code, libraries: ['adafruit_ds18x20', 'adafruit_onewire'],
    parts: [['t', 'ds18b20'], ['r', 'resistor', { ohms: 4700 }]],
    wires: [['board:3V', 't:VDD'], ['t:GND', 'board:GND1'], ['board:D5', 't:DQ'], ['t:DQ', 'r:1'], ['r:2', 'board:3V']],
  });
  assert.match(output, /found 1/, output);
  assert.match(output, /temperature 22/, output);
});

test('DS18B20 without its pull-up resistor is not found reliably', async () => {
  const code = `import board
from adafruit_onewire.bus import OneWireBus
try:
    print("found", len(OneWireBus(board.D5).scan()))
except Exception as error:
    print("failed", error)
`;
  const { output } = await run({
    code, libraries: ['adafruit_onewire'], parts: [['t', 'ds18b20']],
    wires: [['board:3V', 't:VDD'], ['t:GND', 'board:GND1'], ['board:D5', 't:DQ']],
  });
  assert.doesNotMatch(output, /found 1/, output);
});

test('IR remote with adafruit_irremote', async () => {
  const code = `import board, pulseio, adafruit_irremote
pulses = pulseio.PulseIn(board.D3, maxlen=120, idle_state=True)
decoder = adafruit_irremote.GenericDecode()
print("ready")
received = decoder.read_pulses(pulses)
print("code", decoder.decode_bits(received))
`;
  const { output } = await run({
    code, libraries: ['adafruit_irremote'], parts: [['ir', 'ir-receiver']],
    wires: [...[['board:3V', 'ir:VCC'], ['ir:GND', 'board:GND1']], ['board:D3', 'ir:OUT']],
    during: async (board) => {
      await board.waitForOutput('ready');
      await new Promise((resolve) => setTimeout(resolve, 100));
      board.setControl('ir', 'key', 3);
    },
  });
  // Key 3 sends command 0x47, and the decoder reads each byte most significant bit first.
  assert.match(output, /code \(0, 255, 226, 29\)/, output);
});

test('rotary encoder with rotaryio', async () => {
  const code = `import board, rotaryio, time
encoder = rotaryio.IncrementalEncoder(board.D2, board.D3)
print("ready")
while encoder.position == 0:
    time.sleep(0.01)
time.sleep(0.2)
print("position", encoder.position)
`;
  const { output } = await run({
    code, parts: [['e', 'rotary-encoder']],
    wires: [['board:3V', 'e:+'], ['e:GND', 'board:GND1'], ['board:D2', 'e:CLK'], ['board:D3', 'e:DT']],
    during: async (board) => {
      await board.waitForOutput('ready');
      await new Promise((resolve) => setTimeout(resolve, 50));
      board.setControl('e', 'steps', 3);
    },
  });
  assert.match(output, /position 3/, output);
});

test('touch pad with touchio', async () => {
  const code = `import board, touchio, time
pad = touchio.TouchIn(board.A1)
print("ready")
while not pad.value:
    time.sleep(0.01)
print("touched")
`;
  const { output } = await run({
    code, parts: [['p', 'touch-pad']], wires: [['board:A1', 'p:PAD']],
    during: async (board) => {
      await board.waitForOutput('ready');
      board.setControl('p', 'pressed', 1);
    },
  });
  assert.match(output, /touched/);
});

test('OLED with displayio and the real driver', async () => {
  const code = `import board, displayio, i2cdisplaybus, terminalio, time
import adafruit_displayio_ssd1306
from adafruit_display_text import label
displayio.release_displays()
bus = i2cdisplaybus.I2CDisplayBus(board.I2C(), device_address=0x3C)
display = adafruit_displayio_ssd1306.SSD1306(bus, width=128, height=64)
group = displayio.Group()
group.append(label.Label(terminalio.FONT, text="Hello", color=0xFFFFFF, x=10, y=10))
display.root_group = group
display.refresh()
time.sleep(0.2)
print("shown")
`;
  const { output, views } = await run({
    code, libraries: ['adafruit_displayio_ssd1306', 'adafruit_display_text'],
    parts: [['o', 'oled-ssd1306']], wires: [...power('o'), ['board:SDA', 'o:SDA'], ['board:SCL', 'o:SCL']],
  });
  assert.match(output, /shown/, output);
  const lit = Buffer.from(views.o.pixels, 'base64').reduce((sum, byte) => sum + (byte ? 1 : 0), 0);
  assert.ok(lit > 10, `only ${lit} lit bytes`);
});

test('8x8 matrix with adafruit_max7219', async () => {
  const code = `import board, busio, digitalio, time
from adafruit_max7219 import matrices
spi = busio.SPI(board.SCK, MOSI=board.MOSI)
cs = digitalio.DigitalInOut(board.D9)
matrix = matrices.Matrix8x8(spi, cs)
matrix.fill(0)
matrix.pixel(1, 1, 1)
matrix.show()
time.sleep(0.2)
print("drawn")
`;
  const { output, views } = await run({
    code, libraries: ['adafruit_max7219', 'adafruit_framebuf', 'adafruit_bus_device'], parts: [['m', 'led-matrix']],
    wires: [...power('m', '5V'), ['board:MOSI', 'm:DIN'], ['board:SCK', 'm:CLK'], ['board:D9', 'm:CS']],
  });
  assert.match(output, /drawn/, output);
  assert.ok(views.m.rows.some((row) => row !== 0), `rows ${views.m.rows}`);
});

test('74HC595 over SPI with adafruit_74hc595', async () => {
  const code = `import board, busio, digitalio, time, adafruit_74hc595
spi = busio.SPI(board.SCK, MOSI=board.MOSI)
latch = digitalio.DigitalInOut(board.D5)
chip = adafruit_74hc595.ShiftRegister74HC595(spi, latch)
pin = chip.get_pin(3)
pin.value = True
time.sleep(0.2)
print("set")
`;
  const { output, views } = await run({
    code, libraries: ['adafruit_74hc595', 'adafruit_bus_device'], parts: [['s', 'shift-register']],
    wires: [...power('s'), ['board:3V', 's:MR'], ['s:OE', 'board:GND1'], ['board:MOSI', 's:DS'], ['board:SCK', 's:SHCP'], ['board:D5', 's:STCP']],
  });
  assert.match(output, /set/, output);
  assert.equal(views.s.value, 8);
});

test('stepper through ULN2003 by hand', async () => {
  const code = `import board, digitalio, time
pins = [digitalio.DigitalInOut(p) for p in (board.D2, board.D3, board.D4, board.D5)]
for pin in pins:
    pin.direction = digitalio.Direction.OUTPUT
for step in range(512):
    for i, pin in enumerate(pins):
        pin.value = i == step % 4
    time.sleep(0.001)
time.sleep(0.1)
print("turned")
`;
  const { views } = await run({
    code, parts: [['m', 'stepper-uln2003']],
    wires: [['board:5V', 'm:+'], ['m:-', 'board:GND1'], ['board:D2', 'm:IN1'], ['board:D3', 'm:IN2'], ['board:D4', 'm:IN3'], ['board:D5', 'm:IN4']],
  });
  assert.equal(views.m.angle, 90);
});

test('multiplexed 4-digit display shows a segment on one digit', async () => {
  const code = `import board, digitalio, time
segment = digitalio.DigitalInOut(board.D2)
digit = digitalio.DigitalInOut(board.D3)
other = digitalio.DigitalInOut(board.D4)
for pin in (segment, digit, other):
    pin.direction = digitalio.Direction.OUTPUT
segment.value = True
other.value = True
digit.value = False
time.sleep(0.3)
print("lit")
time.sleep(5)
`;
  const { views } = await run({
    code, parts: [['d', 'seven-segment-4']], until: 'lit',
    wires: [['board:D2', 'd:A'], ['board:D3', 'd:D1'], ['board:D4', 'd:D2']],
  });
  assert.ok(views.d.digits[0][0] > 0.5, `digit 1 segment A ${views.d.digits[0][0]}`);
  assert.equal(views.d.digits[1][0], 0);
});

test('TMP36 reads the slider temperature', async () => {
  const code = `import analogio, board, time
sensor = analogio.AnalogIn(board.A0)
time.sleep(0.1)
print("celsius", round((sensor.value * 3.3 / 65535 - 0.5) * 100))
`;
  const { output } = await run({
    code, parts: [['t', 'tmp36']], wires: [['board:3V', 't:VS'], ['t:GND', 'board:GND1'], ['board:A0', 't:OUT']],
  });
  assert.match(output, /celsius 2[12]/, output);
});

test('joystick and PIR', async () => {
  const code = `import analogio, board, digitalio, time
x = analogio.AnalogIn(board.A0)
pir = digitalio.DigitalInOut(board.D2)
print("ready")
while not pir.value:
    time.sleep(0.01)
print("motion", round(x.value / 65535, 1))
`;
  const { output } = await run({
    code, parts: [['j', 'joystick'], ['p', 'pir']],
    wires: [['board:3V', 'j:+5V'], ['j:GND', 'board:GND1'], ['j:VRx', 'board:A0'], ...power('p', '5V'), ['p:OUT', 'board:D2']],
    during: async (board) => {
      await board.waitForOutput('ready');
      board.setControl('j', 'x', 0.8);
      board.setControl('p', 'motion', 1);
    },
  });
  assert.match(output, /motion 0\.8/, output);
});

test('analog audio plays and finishes', async () => {
  const code = `import array, audiocore, audioio, board, math, time
samples = array.array("H", [int(32767 + 30000 * math.sin(i / 8 * 2 * math.pi)) for i in range(8)])
sound = audiocore.RawSample(samples, sample_rate=4000)
speaker = audioio.AudioOut(board.A0)
speaker.play(sound, loop=True)
time.sleep(0.2)
speaker.stop()
print("played", speaker.playing)
`;
  const { output } = await run({ code });
  assert.match(output, /played False/, output);
});

test('CIRCUITPY is read-only to Python unless boot.py remounts it', async () => {
  const write = `try:
    with open("/data.txt", "w") as file:
        file.write("hello")
    print("wrote")
except OSError as error:
    print("blocked", error)
`;
  const blocked = await run({ code: write });
  assert.match(blocked.output, /blocked .*30/, blocked.output);
  const board = new Board({
    files: { '/boot.py': 'import storage\nstorage.remount("/", readonly=False)\n', '/code.py': write },
    circuit: circuit([], []),
  });
  await board.waitForOutput('Code done running');
  await board.stop();
  assert.match(board.output, /wrote/, board.output);
});

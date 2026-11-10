// Every part a student can place. Shared by the editor and the simulator, so it holds only
// data: pin positions on a 10px grid (0.1 inch), editable properties and runtime controls.

const pin = (id, x, y, label = id) => ({ id, x, y, label });

// Pins in a straight line, 0.1 inch apart.
const row = (names, x = 0, y = 0, step = 10) => names.map((name, i) => pin(name, x + i * step, y));

const LED_COLORS = ['red', 'green', 'blue', 'yellow', 'white', 'orange', 'infrared'];
const RESISTOR_VALUES = [100, 220, 330, 560, 1000, 2200, 4700, 10000, 47000, 100000, 1000000];

export const BOARD_TYPE = 'metro-m0-express';

// Chip pin number for each board pin, from the Metro M0 Express board definition.
export const BOARD_PINS = {
  D0: 11, D1: 10, D2: 14, D3: 9, D4: 8, D5: 15, D6: 20, D7: 21, D8: 6, D9: 7, D10: 18,
  D11: 16, D12: 19, D13: 17, A0: 2, A1: 40, A2: 41, A3: 4, A4: 5, A5: 34,
  SDA: 22, SCL: 23, SCK: 43, MOSI: 42, MISO: 12,
};
export const NEOPIXEL_PIN = 30;

const boardPins = () => [
  ...row(['SCL', 'SDA', 'AREF', 'GND3', 'D13', 'D12', 'D11', 'D10', 'D9', 'D8'], 80, 10),
  ...row(['D7', 'D6', 'D5', 'D4', 'D3', 'D2', 'D1', 'D0'], 190, 10),
  ...row(['IOREF', 'RST', '3V', '5V', 'GND1', 'GND2', 'VIN'], 100, 200),
  ...row(['A0', 'A1', 'A2', 'A3', 'A4', 'A5'], 190, 200),
  pin('MISO', 260, 90), pin('SCK', 260, 100), pin('MOSI', 270, 100),
].map((p) => (p.id.startsWith('GND') ? { ...p, label: 'GND' } : p));

// Solderless breadboard. Holes a-e and f-j connect along each column, and the long rails
// connect along their whole length.
function breadboardPins(columns) {
  const pins = [];
  const addRails = (name, y) => {
    for (let c = 0; c < columns; c++) pins.push(pin(`${name}${c}`, 20 + c * 10, y, name[0] === 'p' ? '+' : '-'));
  };
  addRails('pt', 10);
  addRails('nt', 20);
  for (let c = 0; c < columns; c++) {
    ['a', 'b', 'c', 'd', 'e'].forEach((r, i) => pins.push(pin(`${r}${c}`, 20 + c * 10, 50 + i * 10, `${r}${c + 1}`)));
    ['f', 'g', 'h', 'i', 'j'].forEach((r, i) => pins.push(pin(`${r}${c}`, 20 + c * 10, 120 + i * 10, `${r}${c + 1}`)));
  }
  addRails('pb', 190);
  addRails('nb', 200);
  return pins;
}

function breadboardGroups(columns) {
  const groups = ['pt', 'nt', 'pb', 'nb'].map((name) => Array.from({ length: columns }, (_, c) => `${name}${c}`));
  for (let c = 0; c < columns; c++) {
    groups.push(['a', 'b', 'c', 'd', 'e'].map((r) => `${r}${c}`));
    groups.push(['f', 'g', 'h', 'i', 'j'].map((r) => `${r}${c}`));
  }
  return groups;
}

export const CATEGORIES = ['Boards', 'Basics', 'Input', 'Sensors', 'Output', 'Displays', 'Chips & drivers', 'Power', 'Tools'];

export const CATALOG = {
  [BOARD_TYPE]: {
    name: 'Metro M0 Express', category: 'Boards', w: 290, h: 210, fixed: true, powers: true,
    pins: boardPins(),
    groups: [['GND1', 'GND2', 'GND3']],
  },
  'breadboard-half': {
    name: 'Breadboard (half size)', category: 'Boards', w: 320, h: 210, background: true,
    pins: breadboardPins(30), groups: breadboardGroups(30),
  },
  'breadboard-full': {
    name: 'Breadboard (full size)', category: 'Boards', w: 650, h: 210, background: true,
    pins: breadboardPins(63), groups: breadboardGroups(63),
  },

  resistor: {
    name: 'Resistor', category: 'Basics', w: 40, h: 0, description: 'Limits current. Bands show its value.',
    pins: [pin('1', 0, 0), pin('2', 40, 0)],
    props: { ohms: { label: 'Resistance', type: 'choice', unit: 'ohm', choices: RESISTOR_VALUES, default: 220, custom: true } },
  },
  capacitor: {
    name: 'Capacitor', category: 'Basics', w: 10, h: 10, description: 'Stores charge. Acts as an open circuit at DC.',
    pins: [pin('+', 0, 10), pin('-', 10, 10)],
    props: { microfarads: { label: 'Capacitance', type: 'choice', unit: 'uF', choices: [0.1, 1, 10, 100, 220, 1000], default: 100, custom: true } },
  },
  diode: {
    name: 'Diode', category: 'Basics', w: 40, h: 0, description: '1N4001 style. Lets current flow one way.',
    pins: [pin('A', 0, 0, 'Anode'), pin('K', 40, 0, 'Cathode')],
  },
  led: {
    name: 'LED', category: 'Basics', w: 10, h: 10, description: 'Needs a resistor in series.',
    pins: [pin('A', 0, 10, 'Anode (+)'), pin('K', 10, 10, 'Cathode (-)')],
    props: { color: { label: 'Color', type: 'choice', choices: LED_COLORS, default: 'red' } },
  },
  'rgb-led': {
    name: 'RGB LED', category: 'Basics', w: 30, h: 10, description: 'Three LEDs sharing one leg.',
    pins: [pin('R', 0, 10), pin('COM', 10, 10, 'Common'), pin('G', 20, 10), pin('B', 30, 10)],
    props: { common: { label: 'Common leg', type: 'choice', choices: ['cathode', 'anode'], default: 'cathode' } },
  },
  npn: {
    name: 'NPN transistor', category: 'Basics', w: 20, h: 10, description: 'PN2222. Base current switches a larger load.',
    pins: [pin('E', 0, 10, 'Emitter'), pin('B', 10, 10, 'Base'), pin('C', 20, 10, 'Collector')],
  },
  nmos: {
    name: 'N-channel MOSFET', category: 'Basics', w: 20, h: 10, description: 'Gate voltage switches a load.',
    pins: [pin('G', 0, 10, 'Gate'), pin('D', 10, 10, 'Drain'), pin('S', 20, 10, 'Source')],
  },

  button: {
    name: 'Push button', category: 'Input', w: 20, h: 30, description: 'Tactile switch. Fits across the breadboard gap.',
    pins: [pin('1a', 0, 0, '1'), pin('2a', 20, 0, '2'), pin('1b', 0, 30, '1'), pin('2b', 20, 30, '2')],
    groups: [['1a', '1b'], ['2a', '2b']],
    controls: [{ id: 'pressed', kind: 'momentary', label: 'Press' }],
  },
  'slide-switch': {
    name: 'Slide switch', category: 'Input', w: 20, h: 10,
    pins: [pin('1', 0, 10), pin('COM', 10, 10, 'Common'), pin('2', 20, 10)],
    controls: [{ id: 'position', kind: 'toggle', label: 'Slide' }],
  },
  'tilt-switch': {
    name: 'Tilt switch', category: 'Input', w: 10, h: 10, description: 'Closes when upright.',
    pins: [pin('1', 0, 10), pin('2', 10, 10)],
    controls: [{ id: 'tilted', kind: 'toggle', label: 'Tilt' }],
  },
  potentiometer: {
    name: 'Potentiometer', category: 'Input', w: 20, h: 20, description: 'Variable voltage divider.',
    pins: [pin('1', 0, 20), pin('W', 10, 20, 'Wiper'), pin('2', 20, 20)],
    props: { ohms: { label: 'Resistance', type: 'choice', unit: 'ohm', choices: [1000, 10000, 100000], default: 10000 } },
    controls: [{ id: 'position', kind: 'slider', label: 'Turn', min: 0, max: 1, step: 0.001, default: 0.5 }],
  },
  'rotary-encoder': {
    name: 'Rotary encoder', category: 'Input', w: 40, h: 20,
    pins: row(['CLK', 'DT', 'SW', '+', 'GND'], 0, 20),
    controls: [
      { id: 'steps', kind: 'stepper', label: 'Turn' },
      { id: 'pressed', kind: 'momentary', label: 'Press' },
    ],
  },
  joystick: {
    name: 'Joystick', category: 'Input', w: 40, h: 40,
    pins: row(['GND', '+5V', 'VRx', 'VRy', 'SW'], 0, 40),
    controls: [
      { id: 'x', kind: 'slider', label: 'X', min: 0, max: 1, step: 0.001, default: 0.5 },
      { id: 'y', kind: 'slider', label: 'Y', min: 0, max: 1, step: 0.001, default: 0.5 },
      { id: 'pressed', kind: 'momentary', label: 'Press' },
    ],
  },
  'keypad-4x4': {
    name: '4x4 keypad', category: 'Input', w: 70, h: 90, description: 'Rows and columns close at each key.',
    pins: row(['R1', 'R2', 'R3', 'R4', 'C1', 'C2', 'C3', 'C4'], 0, 90),
    controls: [{ id: 'key', kind: 'keys', label: 'Keys', keys: '123A456B789C*0#D' }],
  },
  'touch-pad': {
    name: 'Touch pad', category: 'Input', w: 20, h: 20, description: 'For touchio on a capacitive pin.',
    pins: [pin('PAD', 10, 20)],
    controls: [{ id: 'pressed', kind: 'momentary', label: 'Touch' }],
  },

  photoresistor: {
    name: 'Photoresistor', category: 'Sensors', w: 10, h: 10, description: 'Resistance falls as light rises.',
    pins: [pin('1', 0, 10), pin('2', 10, 10)],
    controls: [{ id: 'light', kind: 'slider', label: 'Light', min: 0, max: 1, step: 0.01, default: 0.5 }],
  },
  thermistor: {
    name: 'Thermistor', category: 'Sensors', w: 10, h: 10, description: '10k NTC. Resistance falls as temperature rises.',
    pins: [pin('1', 0, 10), pin('2', 10, 10)],
    controls: [{ id: 'celsius', kind: 'slider', label: 'Temperature', unit: 'C', min: -10, max: 80, step: 1, default: 22 }],
  },
  fsr: {
    name: 'Force sensor', category: 'Sensors', w: 10, h: 20, description: 'Resistance falls with pressure.',
    pins: [pin('1', 0, 20), pin('2', 10, 20)],
    controls: [{ id: 'force', kind: 'slider', label: 'Force', min: 0, max: 1, step: 0.01, default: 0 }],
  },
  tmp36: {
    name: 'TMP36 temperature', category: 'Sensors', w: 20, h: 10,
    pins: [pin('VS', 0, 10, '+V'), pin('OUT', 10, 10, 'Vout'), pin('GND', 20, 10)],
    controls: [{ id: 'celsius', kind: 'slider', label: 'Temperature', unit: 'C', min: -40, max: 125, step: 1, default: 22 }],
  },
  dht: {
    name: 'DHT temperature/humidity', category: 'Sensors', w: 30, h: 30,
    pins: [pin('VCC', 0, 30), pin('DATA', 10, 30), pin('NC', 20, 30), pin('GND', 30, 30)],
    props: { model: { label: 'Model', type: 'choice', choices: ['DHT11', 'DHT22'], default: 'DHT11' } },
    controls: [
      { id: 'celsius', kind: 'slider', label: 'Temperature', unit: 'C', min: 0, max: 50, step: 1, default: 22 },
      { id: 'humidity', kind: 'slider', label: 'Humidity', unit: '%', min: 20, max: 90, step: 1, default: 45 },
    ],
  },
  ds18b20: {
    name: 'DS18B20 temperature', category: 'Sensors', w: 20, h: 10, description: 'One-wire sensor. Needs a 4.7k pull-up.',
    pins: [pin('GND', 0, 10), pin('DQ', 10, 10, 'Data'), pin('VDD', 20, 10)],
    controls: [{ id: 'celsius', kind: 'slider', label: 'Temperature', unit: 'C', min: -55, max: 125, step: 0.5, default: 22 }],
  },
  hcsr04: {
    name: 'HC-SR04 ultrasonic', category: 'Sensors', w: 40, h: 40,
    pins: row(['VCC', 'TRIG', 'ECHO', 'GND'], 5, 40).map((p) => ({ ...p, x: p.x + 5 })),
    controls: [{ id: 'distance', kind: 'slider', label: 'Distance', unit: 'cm', min: 2, max: 400, step: 1, default: 50 }],
  },
  pir: {
    name: 'PIR motion sensor', category: 'Sensors', w: 30, h: 30,
    pins: row(['VCC', 'OUT', 'GND'], 0, 30),
    controls: [{ id: 'motion', kind: 'momentary', label: 'Wave' }],
  },
  'sound-sensor': {
    name: 'Sound sensor', category: 'Sensors', w: 30, h: 30,
    pins: row(['AO', 'GND', 'VCC', 'DO'], 0, 30),
    controls: [{ id: 'level', kind: 'slider', label: 'Sound', min: 0, max: 1, step: 0.01, default: 0.1 }],
  },
  'water-sensor': {
    name: 'Water level sensor', category: 'Sensors', w: 20, h: 40,
    pins: [pin('S', 0, 40), pin('+', 10, 40), pin('-', 20, 40)],
    controls: [{ id: 'level', kind: 'slider', label: 'Water', min: 0, max: 1, step: 0.01, default: 0 }],
  },
  'ir-receiver': {
    name: 'IR receiver + remote', category: 'Sensors', w: 20, h: 20, description: 'Decodes NEC remote signals.',
    pins: [pin('OUT', 0, 20), pin('GND', 10, 20), pin('VCC', 20, 20)],
    controls: [{ id: 'key', kind: 'keys', label: 'Remote', keys: '123456789*0#', codes: [0x45, 0x46, 0x47, 0x44, 0x40, 0x43, 0x07, 0x15, 0x09, 0x16, 0x19, 0x0d] }],
  },
  mpu6050: {
    name: 'MPU-6050 motion', category: 'Sensors', w: 40, h: 40, description: 'I2C accelerometer and gyro.',
    pins: row(['VCC', 'GND', 'SCL', 'SDA'], 0, 40),
    controls: [
      { id: 'tiltX', kind: 'slider', label: 'Tilt X', unit: 'deg', min: -90, max: 90, step: 1, default: 0 },
      { id: 'tiltY', kind: 'slider', label: 'Tilt Y', unit: 'deg', min: -90, max: 90, step: 1, default: 0 },
    ],
  },
  mcp9808: {
    name: 'MCP9808 temperature', category: 'Sensors', w: 30, h: 30, description: 'I2C temperature sensor.',
    pins: row(['VCC', 'GND', 'SCL', 'SDA'], 0, 30),
    controls: [{ id: 'celsius', kind: 'slider', label: 'Temperature', unit: 'C', min: -40, max: 125, step: 0.25, default: 22.5 }],
  },
  ds3231: {
    name: 'DS3231 clock', category: 'Sensors', w: 40, h: 30, description: 'I2C real-time clock.',
    pins: row(['GND', 'VCC', 'SDA', 'SCL'], 0, 30),
  },

  piezo: {
    name: 'Piezo buzzer', category: 'Output', w: 20, h: 20, description: 'Passive: plays the frequency it is driven at.',
    pins: [pin('+', 0, 20), pin('-', 20, 20)],
    props: { kind: { label: 'Type', type: 'choice', choices: ['passive', 'active'], default: 'passive' } },
    readouts: [{ id: 'tone', label: 'Tone', unit: 'Hz', zero: 'off' }],
  },
  servo: {
    name: 'Micro servo', category: 'Output', w: 40, h: 50,
    pins: [pin('GND', 10, 50), pin('V+', 20, 50), pin('SIG', 30, 50, 'Signal')],
    readouts: [{ id: 'angle', label: 'Angle', unit: '°', default: 90 }],
  },
  'dc-motor': {
    name: 'DC motor', category: 'Output', w: 30, h: 30, description: 'Needs a transistor or driver, not a bare pin.',
    pins: [pin('1', 0, 30), pin('2', 30, 30)],
  },
  'stepper-uln2003': {
    name: 'Stepper + ULN2003', category: 'Output', w: 50, h: 50, description: '28BYJ-48 with its driver board.',
    pins: row(['IN1', 'IN2', 'IN3', 'IN4', '+', '-'], 0, 50),
  },
  'relay-module': {
    name: 'Relay module', category: 'Output', w: 50, h: 40, description: 'Low-level pin controls a separate circuit.',
    pins: [...row(['VCC', 'GND', 'IN'], 0, 40), ...row(['NO', 'COM', 'NC'], 30, 0)],
  },
  neopixel: {
    name: 'NeoPixel strip', category: 'Output', w: 80, h: 20, description: 'Addressable RGB LEDs.',
    pins: row(['DIN', '5V', 'GND'], 0, 20),
    props: { count: { label: 'Pixels', type: 'choice', choices: [1, 4, 8, 12, 16, 24, 30], default: 8 } },
  },

  'seven-segment': {
    name: '7-segment digit', category: 'Displays', w: 40, h: 50, description: 'Eight LEDs with a common leg.',
    pins: [...row(['G', 'F', 'COM1', 'A', 'B'], 0, 0), ...row(['E', 'D', 'COM2', 'C', 'DP'], 0, 50)],
    groups: [['COM1', 'COM2']],
    props: { common: { label: 'Common leg', type: 'choice', choices: ['cathode', 'anode'], default: 'cathode' } },
  },
  'seven-segment-4': {
    name: '4-digit 7-segment', category: 'Displays', w: 50, h: 40, description: 'Multiplexed, common cathode.',
    pins: [...row(['D1', 'A', 'F', 'D2', 'D3', 'B'], 0, 0), ...row(['E', 'D', 'DP', 'C', 'G', 'D4'], 0, 40)],
  },
  'led-bar': {
    name: 'LED bar graph', category: 'Displays', w: 90, h: 30,
    pins: [
      ...Array.from({ length: 10 }, (_, i) => pin(`A${i + 1}`, i * 10, 30, `Anode ${i + 1}`)),
      ...Array.from({ length: 10 }, (_, i) => pin(`K${i + 1}`, i * 10, 0, `Cathode ${i + 1}`)),
    ],
  },
  'led-matrix': {
    name: '8x8 matrix (MAX7219)', category: 'Displays', w: 70, h: 80,
    pins: row(['VCC', 'GND', 'DIN', 'CS', 'CLK'], 10, 80),
  },
  lcd1602: {
    name: '16x2 LCD', category: 'Displays', w: 150, h: 60, description: 'Character display. Wire it in 4-bit mode.',
    pins: row(['VSS', 'VDD', 'V0', 'RS', 'RW', 'E', 'D0', 'D1', 'D2', 'D3', 'D4', 'D5', 'D6', 'D7', 'LEDA', 'LEDK'], 0, 60),
  },
  'lcd-i2c': {
    name: '16x2 LCD (I2C backpack)', category: 'Displays', w: 150, h: 60,
    pins: row(['GND', 'VCC', 'SDA', 'SCL'], 0, 60),
  },
  'oled-ssd1306': {
    name: 'OLED 128x64', category: 'Displays', w: 60, h: 60, description: 'SSD1306 I2C display.',
    pins: row(['GND', 'VCC', 'SCL', 'SDA'], 10, 60),
  },

  'shift-register': {
    name: '74HC595 shift register', category: 'Chips & drivers', w: 70, h: 30, description: 'Serial in, eight outputs.',
    pins: [
      ...row(['Q1', 'Q2', 'Q3', 'Q4', 'Q5', 'Q6', 'Q7', 'GND'], 0, 30),
      ...row(['VCC', 'Q0', 'DS', 'OE', 'STCP', 'SHCP', 'MR', 'Q7S'], 0, 0),
    ],
  },
  l293d: {
    name: 'L293D motor driver', category: 'Chips & drivers', w: 70, h: 30, description: 'Drives two DC motors both ways.',
    pins: [
      ...row(['EN1', 'IN1', 'OUT1', 'GND1', 'GND2', 'OUT2', 'IN2', 'VS'], 0, 30),
      ...row(['VCC', 'IN4', 'OUT4', 'GND4', 'GND3', 'OUT3', 'IN3', 'EN2'], 0, 0),
    ],
    groups: [['GND1', 'GND2', 'GND3', 'GND4']],
  },

  battery: {
    name: 'Battery', category: 'Power', w: 30, h: 40, description: 'Separate supply for motors. Join its - to GND.',
    powers: true,
    pins: [pin('+', 0, 40), pin('-', 30, 40)],
    props: { volts: { label: 'Voltage', type: 'choice', unit: 'V', choices: [3, 4.5, 6, 9], default: 9 } },
  },

  multimeter: {
    name: 'Multimeter', category: 'Tools', w: 60, h: 80,
    description: 'Measures volts and ohms across two points. To measure amps, put it in series.',
    pins: [{ ...pin('V', 20, 80, 'Red probe'), wire: '#d33' }, { ...pin('COM', 40, 80, 'Black probe'), wire: '#222' }],
    controls: [{ id: 'mode', kind: 'cycle', label: 'Measure', options: ['Volts', 'Amps', 'Ohms'] }],
  },
  note: {
    name: 'Note', category: 'Tools', w: 130, h: 22, annotation: true, description: 'Text on the canvas. It is not part of the circuit.',
    pins: [],
    props: { text: { label: 'Text', type: 'text', default: 'Note' } },
  },
};

// The supply pins of each powered part: positive, negative and the highest safe voltage.
export const SUPPLY_LIMITS = {
  tmp36: ['VS', 'GND', 5.5],
  dht: ['VCC', 'GND', 5.5],
  ds18b20: ['VDD', 'GND', 5.5],
  hcsr04: ['VCC', 'GND', 5.5],
  pir: ['VCC', 'GND', 20],
  'sound-sensor': ['VCC', 'GND', 5.5],
  'water-sensor': ['+', '-', 5.5],
  'ir-receiver': ['VCC', 'GND', 5.5],
  mpu6050: ['VCC', 'GND', 5.5],
  mcp9808: ['VCC', 'GND', 5.5],
  ds3231: ['VCC', 'GND', 5.5],
  'rotary-encoder': ['+', 'GND', 5.5],
  joystick: ['+5V', 'GND', 5.5],
  servo: ['V+', 'GND', 6.5],
  'stepper-uln2003': ['+', '-', 12.5],
  'relay-module': ['VCC', 'GND', 5.5],
  neopixel: ['5V', 'GND', 5.5],
  'led-matrix': ['VCC', 'GND', 5.5],
  lcd1602: ['VDD', 'VSS', 5.5],
  'lcd-i2c': ['VCC', 'GND', 5.5],
  'oled-ssd1306': ['VCC', 'GND', 5.5],
  'shift-register': ['VCC', 'GND', 6],
  l293d: ['VCC', 'GND1', 7],
};

export function definition(type) {
  const entry = CATALOG[type];
  if (!entry) throw new Error(`Unknown part type: ${type}`);
  return entry;
}

// What a part's readout shows for a value from the simulation, such as "45°" or "440 Hz".
// A part with no value yet shows the readout's default, as the part starts that way.
export function readoutText(readout, value) {
  const shown = Math.round(value ?? readout.default ?? 0);
  if (shown === 0 && readout.zero) return readout.zero;
  const unit = readout.unit ?? '';
  return `${shown}${/^\w/.test(unit) ? ' ' : ''}${unit}`;
}

export function defaultProps(type) {
  const props = {};
  for (const [key, spec] of Object.entries(definition(type).props ?? {})) props[key] = spec.default;
  return props;
}

// Rotates a point about the part's origin. Quarter turns keep pins on the grid.
export function rotatePoint(x, y, rotation) {
  switch (((rotation % 360) + 360) % 360) {
    case 90: return { x: -y, y: x };
    case 180: return { x: -x, y: -y };
    case 270: return { x: y, y: -x };
    default: return { x, y };
  }
}

// A flipped part is mirrored left to right before it is rotated.
export function pinPosition(part, pinDef) {
  const point = rotatePoint(part.flip ? -pinDef.x : pinDef.x, pinDef.y, part.rotation ?? 0);
  return { x: part.x + point.x, y: part.y + point.y };
}

const NOTE_LINE_CHARS = 30;
const NOTE_LINE_HEIGHT = 10;

// A note's text in the lines it is drawn on.
export function noteLines(text = '') {
  const lines = [];
  for (const paragraph of String(text).split('\n')) {
    let line = '';
    for (const word of paragraph.split(' ')) {
      if (line && line.length + word.length + 1 > NOTE_LINE_CHARS) {
        lines.push(line);
        line = word;
      } else {
        line = line ? `${line} ${word}` : word;
      }
    }
    lines.push(line);
  }
  return lines;
}

// A part's size before rotation. A note grows with its text.
export function partSize(part) {
  const entry = definition(part.type);
  if (!entry.annotation) return { w: entry.w, h: entry.h };
  return { w: entry.w, h: noteLines(part.props?.text).length * NOTE_LINE_HEIGHT + 6 };
}

// The area a part covers on the canvas, with room for its pin labels.
export function partBounds(part) {
  const { w, h } = partSize(part);
  const corners = [[-6, -14], [w + 6, -14], [-6, h + 8], [w + 6, h + 8]].map(([x, y]) => pinPosition(part, { x, y }));
  const xs = corners.map((p) => p.x);
  const ys = corners.map((p) => p.y);
  return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
}

// Runtime controls in a stable order, so both sides of the shared memory agree on slots.
export function controlSlots(circuit) {
  const slots = [];
  for (const part of circuit.parts) {
    for (const control of definition(part.type).controls ?? []) {
      slots.push({ part: part.id, control: control.id, value: control.default ?? 0 });
    }
  }
  return slots;
}

// Why a saved circuit cannot be used, in words a student can act on, or null if it is fine.
export function circuitProblem(doc) {
  if (!Array.isArray(doc?.parts) || !Array.isArray(doc?.wires)) return 'It needs a list of parts and a list of wires.';
  const ids = new Set();
  for (const part of doc.parts) {
    if (typeof part?.id !== 'string' || !/^[\w-]+$/.test(part.id)) return `A part has an invalid id: ${JSON.stringify(part?.id)}.`;
    if (ids.has(part.id)) return `Two parts have the id ${part.id}.`;
    ids.add(part.id);
    if (!Object.hasOwn(CATALOG, part.type)) return `Part ${part.id} has an unknown type: ${part.type}.`;
    if (!Number.isFinite(part.x) || !Number.isFinite(part.y)) return `Part ${part.id} has no position.`;
  }
  if (doc.parts.filter((part) => part.type === BOARD_TYPE).length !== 1) return 'It needs exactly one board.';
  if (doc.wires.some((wire) => !wire?.from?.part || !wire?.to?.part)) return 'A wire is missing one of its ends.';
  return null;
}

export function emptyCircuit() {
  return {
    version: 1,
    parts: [
      { id: 'board', type: BOARD_TYPE, x: 40, y: 40, rotation: 0, props: {} },
    ],
    wires: [],
  };
}

// SVG drawings for every part, in the part's own coordinates. Colors here are the physical
// color of each object, so they deliberately stay the same in light and dark themes.
import { noteLines, partBounds, partSize } from '../shared/catalog.js';

export const LED_HEX = {
  red: '#ff3b30', green: '#34c759', blue: '#2f7bff', yellow: '#ffd60a', white: '#f5f5f5', orange: '#ff9f0a', infrared: '#7a4b8c',
};
export const BAND = ['#111', '#7a4a1e', '#d62828', '#f77f00', '#fcbf49', '#2a9d3f', '#1d6fd1', '#7b2cbf', '#888', '#eee'];

export const escapeXml = (value) => String(value).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const text = (x, y, value, size = 6, fill = '#fff', anchor = 'middle') => (
  `<text x="${x}" y="${y}" font-size="${size}" fill="${fill}" text-anchor="${anchor}" font-family="sans-serif">${value}</text>`);
const rect = (x, y, w, h, fill, r = 0, extra = '') => `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" fill="${fill}" ${extra}/>`;
const circle = (x, y, r, fill, extra = '') => `<circle cx="${x}" cy="${y}" r="${r}" fill="${fill}" ${extra}/>`;
const lead = (x1, y1, x2, y2, stroke = '#b8b8b8', width = 1.4) => `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${stroke}" stroke-width="${width}"/>`;
const pinLabels = (labels, y, step = 10, x = 0, up = true) => labels.map((label, i) => text(x + i * step, y + (up ? -2 : 7), label, 3.6, '#ddd')).join('');
const pads = (points, fill = '#c9a94a') => points.map(([x, y]) => circle(x, y, 2, fill)).join('');

function glow(x, y, r, color, level) {
  if (!level) return '';
  return circle(x, y, r * 2.2, color, `opacity="${0.45 * level}"`) + circle(x, y, r, color, `opacity="${0.5 + 0.5 * level}"`);
}

function module(w, h, color, title, pinNames, y = h, x = 0) {
  return rect(-4 + x, -4, w + 8, h + 8 - 4, color, 2) + text(w / 2, h / 2 - 2, title, 6) + pads(pinNames.map((_, i) => [x + i * 10, y])) + pinLabels(pinNames, y, 10, x);
}

export function resistorBands(ohms) {
  const digits = String(Math.round(ohms));
  const first = Number(digits[0]);
  const second = Number(digits[1] ?? 0);
  return [first, second, Math.max(0, digits.length - 2)];
}

function segmentShapes(x, y, s) {
  return [
    `M${x + 2} ${y}h${s - 4}l1 1l-1 1h${4 - s}l-1 -1z`,
    `M${x + s} ${y + 2}l1 1v${s - 4}l-1 1l-1 -1v${4 - s}z`,
    `M${x + s} ${y + s + 2}l1 1v${s - 4}l-1 1l-1 -1v${4 - s}z`,
    `M${x + 2} ${y + 2 * s}h${s - 4}l1 1l-1 1h${4 - s}l-1 -1z`,
    `M${x} ${y + s + 2}l1 1v${s - 4}l-1 1l-1 -1v${4 - s}z`,
    `M${x} ${y + 2}l1 1v${s - 4}l-1 1l-1 -1v${4 - s}z`,
    `M${x + 2} ${y + s}h${s - 4}l1 1l-1 1h${4 - s}l-1 -1z`,
  ];
}

function digit(x, y, s, levels) {
  const shapes = segmentShapes(x, y, s).map((d, i) => `<path d="${d}" fill="#ff2a1f" opacity="${0.12 + 0.88 * (levels[i] ?? 0)}"/>`);
  return shapes.join('') + circle(x + s + 3, y + 2 * s + 1, 1.2, '#ff2a1f', `opacity="${0.12 + 0.88 * (levels[7] ?? 0)}"`);
}

function headerRow(names, x, y) {
  const width = (names.length - 1) * 10 + 8;
  return rect(x - 4, y - 4, width, 8, '#1a1a1a', 1) + names.map((name, i) => circle(x + i * 10, y, 1.6, '#d9b64d') + text(x + i * 10, y + (y < 100 ? 11 : -6), name.replace(/^GND\d$/, 'GND'), 3.6, '#ddd')).join('');
}

function board(part, view) {
  const led = view?.board?.led ?? 0;
  const pixel = view?.board?.neopixel;
  const pixelColor = pixel ? `rgb(${pixel.map((v) => Math.min(255, v * 3)).join(',')})` : '#ddd';
  return `<path d="M6 0h262l16 14v190a6 6 0 0 1 -6 6h-272a6 6 0 0 1 -6 -6v-198a6 6 0 0 1 6 -6z" fill="#23262b" stroke="#000"/>
    ${rect(-8, 30, 34, 34, '#b8bcc2', 2)}${text(9, 50, 'USB', 6, '#333')}
    ${rect(-8, 130, 40, 40, '#111', 2)}${text(12, 153, 'DC', 7, '#888')}
    ${rect(112, 76, 48, 48, '#111', 2)}${text(136, 102, 'SAMD21', 7, '#aaa')}${text(136, 112, 'G18', 6, '#888')}
    ${text(205, 120, 'Metro M0 Express', 9, '#e8e8e8')}${text(205, 133, 'CircuitPython', 6, '#9ad')}
    ${headerRow(['SCL', 'SDA', 'AREF', 'GND3', '13', '12', '11', '10', '9', '8'], 80, 10)}
    ${headerRow(['7', '6', '5', '4', '3', '2', '1', '0'], 190, 10)}
    ${headerRow(['IOREF', 'RST', '3V', '5V', 'GND1', 'GND2', 'VIN'], 100, 200)}
    ${headerRow(['A0', 'A1', 'A2', 'A3', 'A4', 'A5'], 190, 200)}
    ${rect(256, 86, 18, 18, '#1a1a1a', 1)}${pads([[260, 90], [270, 90], [260, 100], [270, 100]])}
    ${text(250, 92, 'MISO', 3.6, '#ddd', 'end')}${text(250, 102, 'SCK', 3.6, '#ddd', 'end')}${text(278, 103, 'MOSI', 3.6, '#ddd', 'start')}
    ${rect(66, 34, 8, 6, '#555', 1)}${glow(70, 37, 3, '#ff3b30', led)}${text(70, 31, 'L', 4, '#ccc')}
    ${rect(84, 30, 12, 12, pixel ? pixelColor : '#eee', 2)}${glow(90, 36, 4, pixelColor, pixel ? 1 : 0)}${text(90, 49, 'PIXEL', 3.4, '#ccc')}
    ${rect(40, 170, 14, 14, '#555', 2)}${circle(47, 177, 4, '#c33')}${text(47, 192, 'RESET', 3.6, '#ccc')}`;
}

function breadboard(part) {
  const columns = part.type === 'breadboard-full' ? 63 : 30;
  const w = 20 + columns * 10 + 10;
  const labels = [];
  for (let c = 0; c < columns; c += 5) labels.push(text(20 + c * 10, 44, c + 1, 4, '#888'));
  const holes = (y, rows) => `<rect x="15" y="${y - 5}" width="${columns * 10}" height="${rows * 10}" fill="url(#holes)"/>`;
  return rect(0, 0, w, 210, '#ecebe4', 3, 'stroke="#c8c6ba"')
    + lead(15, 5, 15 + columns * 10, 5, '#d33', 1) + lead(15, 25, 15 + columns * 10, 25, '#36c', 1)
    + lead(15, 185, 15 + columns * 10, 185, '#d33', 1) + lead(15, 205, 15 + columns * 10, 205, '#36c', 1)
    + holes(10, 2) + holes(50, 5) + holes(120, 5) + holes(190, 2) + rect(10, 102, w - 20, 8, '#dddcd2')
    + labels.join('');
}

const ART = {
  'metro-m0-express': board,
  'breadboard-half': breadboard,
  'breadboard-full': breadboard,

  resistor(part) {
    const bands = resistorBands(part.props?.ohms ?? 220);
    return lead(0, 0, 8, 0) + lead(32, 0, 40, 0) + rect(8, -4, 24, 8, '#d9b98a', 3)
      + bands.map((band, i) => rect(12 + i * 5, -4, 2.5, 8, BAND[band])).join('') + rect(28, -4, 2, 8, '#c5a032');
  },
  capacitor: () => lead(0, 10, 0, 4) + lead(10, 10, 10, 4) + rect(-3, -8, 16, 13, '#1f3d7a', 3) + rect(9, -8, 4, 13, '#c9d3e6') + text(4, 1, '+', 7),
  diode: () => lead(0, 0, 10, 0) + lead(30, 0, 40, 0) + rect(10, -3.5, 20, 7, '#222', 1) + rect(25, -3.5, 3, 7, '#ddd'),
  led(part, view) {
    const color = LED_HEX[part.props?.color] ?? LED_HEX.red;
    const level = view?.brightness ?? 0;
    return lead(0, 10, 0, 2) + lead(10, 10, 10, 2) + glow(5, -1, 6, color, level)
      + `<path d="M-1 3v-4a6 6 0 0 1 12 0v4z" fill="${color}" opacity="${view?.burned ? 0.25 : 0.6}" stroke="#0005"/>`
      + rect(-2, 2, 14, 2, color, 1, 'opacity=".8"') + (view?.burned ? text(5, 0, 'x', 9, '#000') : '');
  },
  'rgb-led'(part, view) {
    const [r, g, b] = (view?.rgb ?? [0, 0, 0]).map((v) => Math.round(v * 255));
    const lit = r + g + b > 0;
    const color = lit ? `rgb(${r},${g},${b})` : '#dfe4ea';
    return [0, 10, 20, 30].map((x) => lead(x, 10, x, 2)).join('') + glow(15, -3, 8, color, lit ? 1 : 0)
      + `<path d="M6 3v-6a9 9 0 0 1 18 0v6z" fill="${color}" opacity=".85" stroke="#0005"/>` + pinLabels(['R', 'COM', 'G', 'B'], 10);
  },
  npn: () => [0, 10, 20].map((x) => lead(x, 10, x, 2)).join('') + `<path d="M0 3v-5a10 10 0 0 1 20 0v5z" fill="#222"/>` + pinLabels(['E', 'B', 'C'], 10) + text(10, 0, 'NPN', 4.5),
  nmos: () => [0, 10, 20].map((x) => lead(x, 10, x, 2)).join('') + rect(-3, -8, 26, 11, '#222', 1) + rect(-3, -13, 26, 6, '#bbb', 1) + pinLabels(['G', 'D', 'S'], 10) + text(10, 0, 'MOS', 4.5),

  button(part, view) {
    const pressed = view?.pressed;
    return [[0, 0], [20, 0], [0, 30], [20, 30]].map(([x, y]) => lead(x, y, x > 0 ? 18 : 2, y > 0 ? 26 : 4)).join('')
      + rect(0, 3, 20, 24, '#333', 2) + circle(10, 15, 7.5, pressed ? '#b02a23' : '#e0403a', 'stroke="#0006"') + (pressed ? circle(10, 15, 5, '#7f1d18') : '');
  },
  'slide-switch': (part, view) => [0, 10, 20].map((x) => lead(x, 10, x, 2)).join('') + rect(-4, -8, 28, 11, '#2a2a2a', 1) + rect(view?.position ? 12 : 0, -11, 8, 8, '#ccc', 1),
  'tilt-switch': (part, view) => lead(0, 10, 0, 2) + lead(10, 10, 10, 2) + `<g transform="rotate(${view?.tilted ? 35 : 0} 5 0)">${rect(-1, -12, 12, 15, '#3b3b3b', 2)}</g>`,
  potentiometer: (part, view) => [0, 10, 20].map((x) => lead(x, 20, x, 14)).join('') + rect(-4, -4, 28, 20, '#1f4f8f', 2)
    + `<g transform="rotate(${((view?.position ?? 0.5) - 0.5) * 270} 10 6)">${circle(10, 6, 7.5, '#d8dce2', 'stroke="#888"')}${rect(9, -1, 2, 7, '#333')}</g>` + pinLabels(['1', 'W', '2'], 20),
  'rotary-encoder': (part, view) => rect(-4, -8, 48, 26, '#123c6a', 2) + `<g transform="rotate(${(view?.steps ?? 0) * 18} 20 5)">${circle(20, 5, 10, '#c9ced6', 'stroke="#666"')}${rect(19, -5, 2, 8, '#333')}</g>`
    + pads([0, 10, 20, 30, 40].map((x) => [x, 20])) + pinLabels(['CLK', 'DT', 'SW', '+', 'GND'], 20),
  joystick: (part, view) => rect(-4, -6, 48, 44, '#14335c', 2) + circle(20, 15, 15, '#222') + circle(20 + ((view?.x ?? 0.5) - 0.5) * 16, 15 + ((view?.y ?? 0.5) - 0.5) * 16, 9, view?.pressed ? '#555' : '#333', 'stroke="#000"')
    + pads([0, 10, 20, 30, 40].map((x) => [x, 40])) + pinLabels(['GND', '+5V', 'VRx', 'VRy', 'SW'], 40),
  'keypad-4x4'(part, view) {
    const keys = '123A456B789C*0#D';
    let cells = '';
    for (let i = 0; i < 16; i++) {
      const x = (i % 4) * 18;
      const y = Math.floor(i / 4) * 19;
      cells += rect(x, y, 15, 15, view?.key === i + 1 ? '#9ad' : '#e8e8e8', 2) + text(x + 7.5, y + 10.5, keys[i], 8, '#222');
    }
    return rect(-4, -4, 78, 84, '#1b1b1b', 3) + cells + pads([0, 10, 20, 30, 40, 50, 60, 70].map((x) => [x, 90])) + pinLabels(['R1', 'R2', 'R3', 'R4', 'C1', 'C2', 'C3', 'C4'], 90);
  },
  'touch-pad': (part, view) => lead(10, 20, 10, 14) + rect(-2, -2, 24, 18, view?.pressed ? '#e6c35c' : '#c9a94a', 3) + text(10, 9, 'TOUCH', 4.5, '#333'),

  photoresistor: (part, view) => lead(0, 10, 0, 2) + lead(10, 10, 10, 2) + circle(5, -2, 7, '#c8742e', 'stroke="#7a4a1e"') + `<path d="M0 -6h8M2 -4h8M0 -2h8M2 0h8M0 2h8" stroke="#6b2d10" stroke-width=".9"/>`
    + circle(5, -2, 11, '#ffe066', `opacity="${(view?.light ?? 0.5) * 0.3}"`),
  thermistor: (part, view) => lead(0, 10, 3, 2) + lead(10, 10, 7, 2) + circle(5, -1, 5, '#1d4f3a') + text(5, -9, `${view?.celsius ?? ''}`, 5, '#aaa'),
  fsr: (part, view) => lead(0, 20, 3, 13) + lead(10, 20, 7, 13) + rect(0, 6, 10, 8, '#222') + circle(5, -3, 10, '#2a2a2a', 'stroke="#555"') + circle(5, -3, 6, '#888', `opacity="${(view?.force ?? 0) * 0.9 + 0.1}"`),
  tmp36: () => [0, 10, 20].map((x) => lead(x, 10, x, 2)).join('') + `<path d="M0 3v-5a10 10 0 0 1 20 0v5z" fill="#222"/>` + text(10, 0, 'TMP36', 4) + pinLabels(['+V', 'OUT', 'GND'], 10),
  dht: (part, view) => rect(-4, -14, 42, 40, part.props?.model === 'DHT22' ? '#ececec' : '#3a79c4', 2) + `<path d="M0 -10h30v24h-30z" fill="none" stroke="#0004"/>` + text(15, 6, escapeXml(part.props?.model ?? 'DHT11'), 6, part.props?.model === 'DHT22' ? '#333' : '#fff')
    + [0, 10, 20, 30].map((x) => lead(x, 30, x, 24)).join('') + pinLabels(['VCC', 'DATA', 'NC', 'GND'], 30),
  ds18b20: () => [0, 10, 20].map((x) => lead(x, 10, x, 2)).join('') + `<path d="M0 3v-5a10 10 0 0 1 20 0v5z" fill="#222"/>` + text(10, 0, 'DS18', 4) + pinLabels(['GND', 'DQ', 'VDD'], 10),
  hcsr04: (part, view) => rect(-6, -2, 52, 38, '#1b4f8f', 2) + circle(8, 14, 11, '#b8bcc2', 'stroke="#555"') + circle(8, 14, 7, '#333') + circle(32, 14, 11, '#b8bcc2', 'stroke="#555"') + circle(32, 14, 7, '#333')
    + text(20, 32, `${view?.distance ?? ''}cm`, 5) + pads([5, 15, 25, 35].map((x) => [x + 5, 40].map((v, i) => (i ? v : x)))) + pinLabels(['VCC', 'TRIG', 'ECHO', 'GND'], 40, 10, 5),
  pir: (part, view) => rect(-4, -6, 38, 34, '#1d5e3a', 2) + circle(15, 10, 14, '#f5f5f5', 'stroke="#ccc"') + circle(15, 10, 4, view?.active ? '#ff3b30' : '#ddd') + pads([0, 10, 20].map((x) => [x, 30])) + pinLabels(['VCC', 'OUT', 'GND'], 30),
  'sound-sensor': (part, view) => rect(-4, -6, 38, 34, '#8c1c1c', 2) + circle(15, 8, 9, '#aaa', 'stroke="#555"') + circle(15, 8, 6 * (view?.level ?? 0.1) + 1, '#222') + pads([0, 10, 20, 30].map((x) => [x, 30])) + pinLabels(['AO', 'GND', 'VCC', 'DO'], 30),
  'water-sensor': (part, view) => rect(-4, -14, 28, 52, '#b22', 2) + [0, 1, 2, 3].map((i) => rect(0, -10 + i * 8, 20, 3, '#ddc')).join('') + rect(-4, 24 - 38 * (view?.level ?? 0), 28, 38 * (view?.level ?? 0), '#39f', 0, 'opacity=".35"') + pads([0, 10, 20].map((x) => [x, 40])) + pinLabels(['S', '+', '-'], 40),
  'ir-receiver': () => [0, 10, 20].map((x) => lead(x, 20, x, 10)).join('') + rect(0, -2, 20, 13, '#1c1c1c', 2) + circle(10, 4, 5, '#444') + pinLabels(['OUT', 'GND', 'VCC'], 20),
  mpu6050: () => module(30, 40, '#123c6a', 'MPU6050', ['VCC', 'GND', 'SCL', 'SDA']),
  mcp9808: () => module(30, 30, '#1b2a55', 'MCP9808', ['VCC', 'GND', 'SCL', 'SDA']),
  ds3231: () => module(30, 30, '#16523a', 'DS3231', ['GND', 'VCC', 'SDA', 'SCL']),

  piezo: (part, view) => lead(0, 20, 3, 12) + lead(20, 20, 17, 12) + circle(10, 5, 12, '#222') + circle(10, 5, 3, '#000') + (view?.tone ? circle(10, 5, 15, 'none', 'stroke="#ffd60a" stroke-width="1"') + text(10, -11, `${Math.round(view.tone)}Hz`, 5, '#aaa') : ''),
  servo: (part, view) => rect(0, 0, 40, 40, '#2a5fa8', 2) + rect(-6, 16, 52, 3, '#2a5fa8') + `<g transform="rotate(${(view?.angle ?? 90) - 90} 20 14)">${circle(20, 14, 6, '#fff')}<path d="M18 14l1 -20h2l1 20z" fill="#fff"/></g>` + text(20, 34, `${view?.angle ?? 90}`, 6)
    + lead(10, 50, 10, 40, '#6b4a2b', 2) + lead(20, 50, 20, 40, '#d33', 2) + lead(30, 50, 30, 40, '#e8a33d', 2) + pinLabels(['GND', 'V+', 'SIG'], 50, 10, 10),
  'dc-motor': (part, view) => lead(0, 30, 6, 20) + lead(30, 30, 24, 20) + rect(0, 0, 30, 22, '#b8bcc2', 3) + `<g transform="rotate(${view?.angle ?? 0} 15 -6)">${rect(14, -14, 2, 16, '#333')}${rect(7, -7, 16, 2, '#333')}</g>` + circle(15, -6, 2.5, '#555'),
  'stepper-uln2003': (part, view) => rect(-4, -4, 58, 48, '#1e4f8a', 2) + circle(25, 18, 15, '#bbb', 'stroke="#555"') + `<g transform="rotate(${view?.angle ?? 0} 25 18)">${rect(24, 4, 2, 14, '#333')}</g>` + pads([0, 10, 20, 30, 40, 50].map((x) => [x, 50])) + pinLabels(['IN1', 'IN2', 'IN3', 'IN4', '+', '-'], 50),
  'relay-module': (part, view) => rect(-4, -6, 58, 50, '#17406f', 2) + rect(6, 6, 38, 22, '#1d6fd1', 2) + text(25, 20, 'RELAY', 6) + circle(46, 32, 2.5, view?.energized ? '#ff3b30' : '#400')
    + pads([[0, 40], [10, 40], [20, 40], [30, 0], [40, 0], [50, 0]]) + pinLabels(['VCC', 'GND', 'IN'], 40) + pinLabels(['NO', 'COM', 'NC'], 0, 10, 30, false),
  neopixel(part, view) {
    const count = Math.min(part.props?.count ?? 8, 30);
    const pixels = view?.pixels ?? [];
    const spacing = 12;
    let cells = '';
    for (let i = 0; i < count; i++) {
      const color = `#${pixels[i] ?? '000000'}`;
      const lit = color !== '#000000';
      cells += rect(i * spacing, -4, 10, 10, '#f3f3f3', 1) + circle(i * spacing + 5, 1, 3.5, lit ? color : '#ccc') + glow(i * spacing + 5, 1, 3, color, lit ? 0.8 : 0);
    }
    return rect(-3, -8, count * spacing + 4, 18, '#111', 2) + cells + [0, 10, 20].map((x) => lead(x, 20, x, 10)).join('') + pinLabels(['DIN', '5V', 'GND'], 20);
  },

  'seven-segment': (part, view) => rect(-4, 3, 48, 44, '#1d1d1d', 2) + digit(10, 8, 14, view?.segments ?? []) + pads([0, 10, 20, 30, 40].flatMap((x) => [[x, 0], [x, 50]])),
  'seven-segment-4': (part, view) => rect(-5, 3, 60, 34, '#1d1d1d', 2) + [0, 1, 2, 3].map((i) => digit(-1 + i * 14, 8, 9, view?.digits?.[i] ?? [])).join('') + pads([0, 10, 20, 30, 40, 50].flatMap((x) => [[x, 0], [x, 40]])),
  'led-bar': (part, view) => rect(-4, 3, 98, 24, '#222', 2) + Array.from({ length: 10 }, (_, i) => rect(i * 10 - 3, 7, 6, 16, '#ff3b30', 1, `opacity="${0.15 + 0.85 * (view?.levels?.[i] ?? 0)}"`)).join('') + pads(Array.from({ length: 10 }, (_, i) => i * 10).flatMap((x) => [[x, 0], [x, 30]])),
  'led-matrix'(part, view) {
    let cells = '';
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 8; x++) {
        const on = ((view?.rows?.[y] ?? 0) >> (7 - x)) & 1;
        cells += circle(7 + x * 8, 6 + y * 8, 3, on ? '#ff3b30' : '#3a1414');
      }
    }
    return rect(0, -2, 70, 72, '#111', 2) + cells + pads([10, 20, 30, 40, 50].map((x) => [x, 80])) + pinLabels(['VCC', 'GND', 'DIN', 'CS', 'CLK'], 80, 10, 10);
  },
  lcd1602(part, view) {
    return lcdBody(view, ['VSS', 'VDD', 'V0', 'RS', 'RW', 'E', 'D0', 'D1', 'D2', 'D3', 'D4', 'D5', 'D6', 'D7', 'A', 'K']);
  },
  'lcd-i2c'(part, view) {
    return lcdBody(view, ['GND', 'VCC', 'SDA', 'SCL']);
  },
  'oled-ssd1306': (part, view) => rect(-2, -6, 64, 58, '#123c6a', 2) + rect(0, 2, 60, 36, '#000')
    + (view?.image ? `<image href="${view.image}" x="0" y="2" width="60" height="30" preserveAspectRatio="none" style="image-rendering:pixelated"/>` : '')
    + pads([10, 20, 30, 40].map((x) => [x, 60])) + pinLabels(['GND', 'VCC', 'SCL', 'SDA'], 60, 10, 10),

  'shift-register': () => chip(70, '74HC595', ['VCC', 'Q0', 'DS', 'OE', 'STCP', 'SHCP', 'MR', 'Q7S'], ['Q1', 'Q2', 'Q3', 'Q4', 'Q5', 'Q6', 'Q7', 'GND']),
  l293d: () => chip(70, 'L293D', ['VCC', 'IN4', 'OUT4', 'GND', 'GND', 'OUT3', 'IN3', 'EN2'], ['EN1', 'IN1', 'OUT1', 'GND', 'GND', 'OUT2', 'IN2', 'VS']),

  battery: (part) => lead(0, 40, 6, 32, '#d33', 2) + lead(30, 40, 24, 32, '#333', 2) + rect(0, -4, 30, 36, '#222', 2) + rect(0, -4, 30, 12, '#c9a94a', 2) + text(15, 20, `${escapeXml(part.props?.volts ?? 9)}V`, 8),

  multimeter(part, view) {
    const mode = view?.mode ?? 0;
    const dial = ['V', 'A', 'Ω'].map((label, i) => rect(4 + i * 18, 34, 16, 13, i === mode ? '#ffd60a' : '#3a3a3a', 2) + text(12 + i * 18, 44, label, 9, i === mode ? '#222' : '#ddd')).join('');
    return rect(-6, -6, 72, 92, '#e0a526', 5) + rect(0, 0, 60, 28, '#b7c9a8', 2)
      + text(56, 17, view?.reading ?? '---', 13, '#16230f', 'end') + text(56, 25, view?.unit ?? '', 6, '#16230f', 'end')
      + dial + text(30, 60, 'Click to change', 4.4, '#3b2a00')
      + circle(20, 80, 3.4, '#c8281e') + circle(40, 80, 3.4, '#1c1c1c') + text(20, 72, 'V', 5, '#3b2a00') + text(40, 72, 'COM', 5, '#3b2a00');
  },
  note(part) {
    const lines = noteLines(part.props?.text);
    return rect(0, 0, 130, partSize(part).h, '#fff3b0', 2, 'stroke="#c9b458"')
      + lines.map((line, i) => text(5, 11 + i * 10, escapeXml(line), 7.5, '#3a3200', 'start')).join('');
  },
};

function lcdBody(view, labels) {
  const lines = view?.lines ?? ['', ''];
  const cell = (row, column) => {
    const character = (lines[row] ?? '').charAt(column).replace('&', '&amp;').replace('<', '&lt;') || ' ';
    return `<text x="${13 + column * 8}" y="${22 + row * 13}" font-size="10" font-family="monospace" fill="#0a2a0a">${character}</text>`;
  };
  let characters = '';
  for (let row = 0; row < 2; row++) for (let column = 0; column < 16; column++) characters += cell(row, column);
  return rect(-4, -2, 158, 56, '#1f7a3a', 2) + rect(8, 8, 134, 32, view?.backlight === false ? '#5e7a3a' : '#a8d04a', 1) + characters
    + pads(labels.map((_, i) => [i * 10, 60])) + pinLabels(labels, 60);
}

function chip(w, name, top, bottom) {
  return rect(-3, 4, w + 6, 22, '#222', 1) + circle(0, 15, 2, '#444') + text(w / 2, 18, name, 6, '#ccc')
    + top.map((_, i) => lead(i * 10, 0, i * 10, 5)).join('') + bottom.map((_, i) => lead(i * 10, 30, i * 10, 25)).join('')
    + pinLabels(top, 0, 10, 0, false) + pinLabels(bottom, 30);
}

// A flipped part mirrors its art, but its writing still has to read the right way round.
function unmirrorText(svg) {
  const swap = { start: 'end', end: 'start' };
  return svg.replace(/<text x="(-?[\d.]+)" y="(-?[\d.]+)"([^>]*)>/g, (_, x, y, rest) => (
    `<text x="${x}" y="${y}" transform="matrix(-1 0 0 1 ${2 * x} 0)"${rest.replace(/text-anchor="(start|end)"/, (m, anchor) => `text-anchor="${swap[anchor]}"`)}>`));
}

export function partArt(part, view) {
  const draw = ART[part.type];
  const art = draw ? draw(part, view) : rect(0, 0, 20, 20, '#888');
  return part.flip ? unmirrorText(art) : art;
}

// A circuit file can come from anyone, so only numbers go into the markup.
export function partTransform(part) {
  return `translate(${Number(part.x) || 0} ${Number(part.y) || 0}) rotate(${Number(part.rotation) || 0})${part.flip ? ' scale(-1 1)' : ''}`;
}

// A student's name for a part, drawn upright under it however the part is turned.
export function partLabel(part) {
  if (!part.label) return '';
  const box = partBounds(part);
  return `<text x="${box.x + box.w / 2}" y="${box.y + box.h + 3}" font-size="8" font-family="sans-serif" text-anchor="middle" fill="#fff" stroke="#0009" stroke-width="2" paint-order="stroke">${escapeXml(part.label)}</text>`;
}

// Rising puffs over a part being damaged. style.css animates them.
export function smoke(x, y, size) {
  const puff = (dx, dy, r, delay) => `<circle class="puff" style="animation-delay:${delay}s" cx="${dx}" cy="${dy}" r="${r}"/>`;
  return `<g class="smoke" transform="translate(${x} ${y}) scale(${size})"><circle class="scorch" r="7"/>${puff(-3, -2, 4, 0)}${puff(3, -3, 5, 0.5)}${puff(0, -4, 4.5, 1)}</g>`;
}

export function warningMark(x, y) {
  return `<g class="warning-mark" transform="translate(${x} ${y})"><path d="M0 -8L8 6H-8z"/><text y="4.5" text-anchor="middle">!</text></g>`;
}

export function holePattern() {
  return `<pattern id="holes" width="10" height="10" patternUnits="userSpaceOnUse" x="15" y="5"><rect x="3.4" y="3.4" width="3.2" height="3.2" rx=".6" fill="#7d7a70"/></pattern>`;
}

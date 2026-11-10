// 3D models of the parts, for the 3D view. A builder adds a part's shapes to `kit.root` in the
// part's own coordinates: x and y as in the catalog, and height above whatever it stands on. It
// may return a function that shows the part's live state.
//
// Nothing here touches the page. Anything printed on a part is drawn through `kit.canvas`, so the
// models can be built and checked without a browser.
import * as THREE from './vendor/three/three.module.js';
import { BOARD_TYPE, definition } from '../shared/catalog.js';
import { BAND, LED_HEX, resistorBands } from './art.js';
import { BOARD_TOP, BREADBOARD_TOP, HEADER_TOP } from './layout3d.js';

export const METAL = '#c4c7cc';
const GOLD = '#c9a94a';
const INK = '#ddd';
const PRINT_SCALE = 8; // Pixels for each unit of a printed surface.
const PRINT_GAP = 0.06; // Keeps print clear of the surface under it.
const PCB_THICKNESS = 1.6;
const BAR = new THREE.CylinderGeometry(1, 1, 1, 12);
const ROUND = new THREE.CylinderGeometry(1, 1, 1, 32);
const PAD = new THREE.CylinderGeometry(2, 2, 0.3, 14).translate(0, 0.15, 0);
const HOLE = new THREE.BoxGeometry(3.2, 0.2, 3.2);
const UP = new THREE.Vector3(0, 1, 0);
const SHINY = { metalness: 0.55, roughness: 0.4 };
const rad = THREE.MathUtils.degToRad;

export const at = (x, h, y) => new THREE.Vector3(x, h, y);

const add = (kit, object) => {
  kit.root.add(object);
  return object;
};

// A material of a part's own, for something that changes color or lights up.
const lamp = (color, options = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.6, ...options });

export function bar(from, to, radius, material, geometry = BAR) {
  const mesh = new THREE.Mesh(geometry, material);
  const direction = to.clone().sub(from);
  mesh.scale.set(radius, direction.length(), radius);
  mesh.position.copy(from).addScaledVector(direction, 0.5);
  mesh.quaternion.setFromUnitVectors(UP, direction.normalize());
  return mesh;
}

export function block(box, bottom, height, material) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(box.w, height, box.h), material);
  mesh.position.set(box.x + box.w / 2, bottom + height / 2, box.y + box.h / 2);
  return mesh;
}

export function post(x, y, radius, bottom, height, material) {
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, height, 28), material);
  mesh.position.set(x, bottom + height / 2, y);
  return mesh;
}

function ball(x, h, y, radius, material) {
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(radius, 24, 14), material);
  mesh.position.set(x, h, y);
  return mesh;
}

function dome(x, y, radius, bottom, material) {
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(radius, 28, 14, 0, Math.PI * 2, 0, Math.PI / 2), material);
  mesh.position.set(x, bottom, y);
  return mesh;
}

const slab = (kit, x, y, w, h, bottom, height, color, options) => add(kit, block({ x, y, w, h }, bottom, height, kit.solid(color, options)));
const rod = (kit, x, y, radius, bottom, height, color, options) => add(kit, post(x, y, radius, bottom, height, kit.solid(color, options)));

// A flat shape with a thickness, drawn in the catalog's x and y.
function plate(kit, shape, bottom, height, material) {
  const geometry = new THREE.ExtrudeGeometry(shape, { depth: height, bevelEnabled: false, curveSegments: 8 });
  geometry.rotateX(Math.PI / 2);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.y = bottom + height;
  return add(kit, mesh);
}

function roundedBox(x, y, w, h, r) {
  const shape = new THREE.Shape();
  shape.moveTo(x + r, y);
  shape.lineTo(x + w - r, y);
  shape.quadraticCurveTo(x + w, y, x + w, y + r);
  shape.lineTo(x + w, y + h - r);
  shape.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  shape.lineTo(x + r, y + h);
  shape.quadraticCurveTo(x, y + h, x, y + h - r);
  shape.lineTo(x, y + r);
  shape.quadraticCurveTo(x, y, x + r, y);
  return shape;
}

// Something that turns or tilts about a point. Build it with the kit this gives, still in the
// part's own coordinates, and move it by turning `joint`.
function pivot(kit, x, h, y) {
  const joint = new THREE.Group();
  const inner = new THREE.Group();
  joint.position.set(x, h, y);
  inner.position.set(-x, -h, -y);
  joint.add(inner);
  kit.root.add(joint);
  return { joint, kit: { ...kit, root: inner } };
}

// The same small shape at many places, drawn in one go.
function marks(kit, geometry, points, level, material) {
  const mesh = new THREE.InstancedMesh(geometry, material, points.length);
  const place = new THREE.Matrix4();
  points.forEach((point, i) => mesh.setMatrixAt(i, place.makeTranslation(point.x, level, point.y)));
  return add(kit, mesh);
}

const pinsOf = (kit) => definition(kit.part.type).pins;
const pinMiddle = (pins) => ({
  x: pins.reduce((sum, pin) => sum + pin.x, 0) / pins.length,
  y: pins.reduce((sum, pin) => sum + pin.y, 0) / pins.length,
});

// Straight legs, from just inside whatever the part is plugged into.
function legs(kit, height, pins = pinsOf(kit), material = kit.solid(METAL)) {
  for (const pin of pins) add(kit, bar(at(pin.x, -1, pin.y), at(pin.x, height, pin.y), 0.8, material));
}

// Legs that bend in to reach a body that does not sit over them.
export function addLegs(kit, pins, body, height, material = kit.solid(METAL)) {
  for (const pin of pins) {
    add(kit, bar(at(pin.x, -1, pin.y), at(pin.x, height, pin.y), 0.8, material));
    const x = Math.max(body.x, Math.min(body.x + body.w, pin.x));
    const y = Math.max(body.y, Math.min(body.y + body.h, pin.y));
    if (x !== pin.x || y !== pin.y) add(kit, bar(at(pin.x, height, pin.y), at(x, height, y), 0.8, material));
  }
}

function addGlow(kit, x, h, y) {
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
    map: kit.glowTexture, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending,
  }));
  sprite.position.set(x, h, y);
  kit.root.add(sprite);
  return (color, level, size) => {
    sprite.material.color.set(color);
    sprite.material.opacity = 0.85 * level;
    sprite.scale.setScalar(size);
  };
}

function addLens(kit, x, y, radius, color) {
  const material = lamp(color, { transparent: true, opacity: 0.82, roughness: 0.25, emissive: color, emissiveIntensity: 0 });
  const bottom = 6;
  const barrel = radius * 1.1;
  add(kit, post(x, y, radius * 1.16, bottom, 1.2, material));
  add(kit, post(x, y, radius, bottom + 1.2, barrel, material));
  add(kit, dome(x, y, radius, bottom + 1.2 + barrel, material));
  return { material, glow: addGlow(kit, x, bottom + barrel, y) };
}

// --- Printing ---

// What a builder draws print with. A flipped part is mirrored, so its writing is drawn mirrored
// too, which makes it read the right way round.
function pen(context, flipped) {
  return {
    fill(color, x, y, w, h, radius = 0) {
      context.fillStyle = color;
      context.beginPath();
      context.roundRect(x, y, w, h, radius);
      context.fill();
    },
    dot(color, x, y, radius) {
      context.fillStyle = color;
      context.beginPath();
      context.arc(x, y, radius, 0, Math.PI * 2);
      context.fill();
    },
    text(value, x, y, size, color = INK, align = 'center', font = 'sans-serif') {
      context.save();
      context.translate(x, y);
      if (flipped) context.scale(-1, 1);
      context.font = `${size}px ${font}`;
      context.fillStyle = color;
      context.textAlign = flipped ? { left: 'right', right: 'left', center: 'center' }[align] : align;
      context.fillText(String(value), 0, 0);
      context.restore();
    },
  };
}

// Prints on a part. `paint` draws with a pen in the part's own units, and `area` is where the print
// goes on top of something `level` high. With `facing: 'front'` it goes on an upright face instead:
// the area's y and h are then heights, `level` is how far forward the face is, and the pen's y runs
// down from the top of the area. `lit` makes it glow, for a screen.
export function print(kit, area, level, paint, { facing = 'top', lit = 0 } = {}) {
  const scale = Math.min(PRINT_SCALE, kit.textureLimit / Math.max(area.w, area.h));
  const canvas = kit.canvas(Math.ceil(area.w * scale), Math.ceil(area.h * scale));
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;
  const material = new THREE.MeshStandardMaterial({ map: texture, transparent: true, roughness: 0.8 });
  if (lit) Object.assign(material, { emissive: new THREE.Color('#fff'), emissiveMap: texture, emissiveIntensity: lit });
  const geometry = new THREE.PlaneGeometry(area.w, area.h);
  const mesh = new THREE.Mesh(geometry, material);
  if (facing === 'front') {
    mesh.position.set(area.x + area.w / 2, area.y + area.h / 2, level + PRINT_GAP);
  } else {
    geometry.rotateX(-Math.PI / 2);
    mesh.position.set(area.x + area.w / 2, level + PRINT_GAP, area.y + area.h / 2);
  }
  mesh.userData.print = true;
  kit.root.add(mesh);
  const top = facing === 'front' ? 0 : area.y;
  const repaint = (draw) => {
    const context = canvas.getContext('2d');
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.setTransform(scale, 0, 0, scale, -area.x * scale, -top * scale);
    draw(pen(context, kit.part.flip));
    texture.needsUpdate = true;
    kit.events.drawn();
  };
  repaint(paint);
  return { repaint, material };
}

// Pin names as they are printed, which have to fit between pins.
const shortName = (id) => id.replace(/^GND\d$/, 'GND').replace(/^LED(?=[AK]$)/, '');

// A circuit board standing on its header pins, with each pin's name printed beside it. `area` has
// to cover the pins. Returns the height of the board's top.
function moduleBoard(kit, area, color, extra = () => {}) {
  const pins = pinsOf(kit);
  const lift = 7;
  const top = lift + PCB_THICKNESS;
  const middle = area.y + area.h / 2;
  slab(kit, area.x, area.y, area.w, area.h, lift, PCB_THICKNESS, color, { roughness: 0.75 });
  legs(kit, top + 1);
  for (const y of new Set(pins.map((pin) => pin.y))) {
    const xs = pins.filter((pin) => pin.y === y).map((pin) => pin.x);
    slab(kit, Math.min(...xs) - 4, y - 2.5, Math.max(...xs) - Math.min(...xs) + 8, 5, lift - 4.5, 4.5, '#1a1a1a');
  }
  marks(kit, PAD, pins, top, kit.solid(GOLD, SHINY));
  print(kit, area, top, (ink) => {
    for (const pin of pins) ink.text(shortName(pin.id), pin.x, pin.y + (pin.y > middle ? -3.5 : 6.5), 3.6);
    extra(ink);
  });
  return top;
}

// A small sensor board: a chip, its name, and a row of pins along one edge.
const breakout = (w, h, color, title, parts = (kit, top) => slab(kit, w / 2 - 5, h / 2 - 3, 10, 10, top, 1.6, '#1a1a1a')) => (kit) => {
  const top = moduleBoard(kit, { x: -4, y: -4, w: w + 8, h: h + 8 }, color, (ink) => ink.text(title, w / 2, h / 2 - 7, 5));
  parts(kit, top);
};

// --- Parts ---

function addAxial(kit, length, radius, height, material) {
  const [first, second] = pinsOf(kit);
  const start = (length - (first.x + second.x)) / -2;
  const lead = kit.solid(METAL);
  legs(kit, height);
  add(kit, bar(at(first.x, height, 0), at(second.x, height, 0), 0.8, lead));
  add(kit, bar(at(start, height, 0), at(start + length, height, 0), radius, material));
  return (from, width, color) => add(kit, bar(at(from, height, 0), at(from + width, height, 0), radius + 0.12, kit.solid(color)));
}

// The flat-sided package of small transistors and sensors, with its name on the flat.
const halfRound = (name) => (kit) => {
  const { x, y } = pinMiddle(pinsOf(kit));
  const shape = new THREE.Shape();
  shape.absarc(0, 0, 10.5, 0, Math.PI);
  shape.closePath();
  const geometry = new THREE.ExtrudeGeometry(shape, { depth: 13, bevelEnabled: false, curveSegments: 20 });
  geometry.rotateX(-Math.PI / 2);
  const mesh = new THREE.Mesh(geometry, kit.solid('#222', { roughness: 0.5 }));
  mesh.position.set(x, 5, y + 4);
  add(kit, mesh);
  legs(kit, 6);
  print(kit, { x: x - 10, y: 5, w: 20, h: 13 }, y + 4, (ink) => ink.text(name, x, 8, 4.4, '#bbb'), { facing: 'front' });
};

function board(kit) {
  const entry = definition(kit.part.type);
  const header = kit.solid('#262626');
  const outline = new THREE.Shape();
  outline.moveTo(6, 0);
  outline.lineTo(268, 0);
  outline.lineTo(284, 14);
  outline.lineTo(284, 204);
  outline.quadraticCurveTo(284, 210, 278, 210);
  outline.lineTo(6, 210);
  outline.quadraticCurveTo(0, 210, 0, 204);
  outline.lineTo(0, 6);
  outline.quadraticCurveTo(0, 0, 6, 0);
  plate(kit, outline, BOARD_TOP - 3, 3, kit.solid('#23262b', { roughness: 0.7 }));
  for (const [x, y] of [[12, 12], [272, 12], [12, 198], [272, 198]]) rod(kit, x, y, 3, 0, BOARD_TOP - 3, '#8d8f93');

  // The sockets wires plug into, with a hole for each pin.
  for (const box of [
    { x: 76, y: 6, w: 98, h: 8 }, { x: 186, y: 6, w: 78, h: 8 }, { x: 96, y: 196, w: 68, h: 8 }, { x: 186, y: 196, w: 58, h: 8 },
    { x: 256, y: 86, w: 18, h: 18 },
  ]) add(kit, block(box, BOARD_TOP, HEADER_TOP - BOARD_TOP, header));
  marks(kit, HOLE, [...entry.pins, { x: 270, y: 90 }], HEADER_TOP, kit.solid('#000'));

  slab(kit, 112, 76, 48, 48, BOARD_TOP, 3, '#141414');
  print(kit, { x: 112, y: 76, w: 48, h: 48 }, BOARD_TOP + 3, (ink) => {
    ink.text('SAMD21', 136, 102, 7, '#aaa');
    ink.text('G18', 136, 112, 6, '#888');
  });
  slab(kit, -8, 30, 34, 34, BOARD_TOP, 13, '#b8bcc2', SHINY);
  slab(kit, -8, 130, 40, 40, BOARD_TOP, 15, '#141414');
  slab(kit, 40, 170, 14, 14, BOARD_TOP, 2, '#555');
  rod(kit, 47, 177, 4, BOARD_TOP + 2, 2.5, '#c33');

  print(kit, { x: 0, y: 0, w: 284, h: 210 }, BOARD_TOP, (ink) => {
    ink.text('Metro M0 Express', 205, 120, 9, '#e8e8e8');
    ink.text('CircuitPython', 205, 133, 6, '#9ad');
    for (const pin of entry.pins) {
      // The board prints its digital pins as bare numbers.
      if (pin.y === 10 || pin.y === 200) ink.text(shortName(pin.id).replace(/^D(?=\d)/, ''), pin.x, pin.y === 10 ? 21 : 194, 3.6);
    }
    ink.text('MISO', 250, 92, 3.6, INK, 'right');
    ink.text('SCK', 250, 102, 3.6, INK, 'right');
    ink.text('MOSI', 278, 103, 3.6, INK, 'left');
    ink.text('L', 70, 31, 4, '#ccc');
    ink.text('PIXEL', 90, 49, 3.4, '#ccc');
    ink.text('RESET', 47, 192, 3.6, '#ccc');
  });

  const led = lamp('#552222', { emissive: '#ff3b30', emissiveIntensity: 0 });
  const pixel = lamp('#eee', { emissive: '#000' });
  add(kit, block({ x: 66, y: 34, w: 8, h: 6 }, BOARD_TOP, 1.6, led));
  add(kit, block({ x: 84, y: 30, w: 12, h: 12 }, BOARD_TOP, 2.2, pixel));
  const ledGlow = addGlow(kit, 70, BOARD_TOP + 4, 37);
  const pixelGlow = addGlow(kit, 90, BOARD_TOP + 5, 36);

  return (view) => {
    const level = view?.board?.led ?? 0;
    led.emissiveIntensity = level * 3;
    ledGlow('#ff3b30', level, 26);
    const rgb = view?.board?.neopixel;
    const color = rgb ? `rgb(${rgb.map((v) => Math.min(255, v * 3)).join(',')})` : '#000';
    pixel.emissive.set(color);
    pixelGlow(color, rgb ? 1 : 0, 34);
  };
}

function breadboard(kit) {
  const { pins } = definition(kit.part.type);
  const columns = pins.filter((pin) => pin.id.startsWith('pt')).length;
  const width = 30 + columns * 10;
  const length = columns * 10;
  const plastic = kit.solid('#ecebe4', { roughness: 0.8 });
  add(kit, block({ x: 0, y: 0, w: width, h: 102 }, 0, BREADBOARD_TOP, plastic));
  add(kit, block({ x: 0, y: 110, w: width, h: 100 }, 0, BREADBOARD_TOP, plastic));
  slab(kit, 0, 102, width, 8, 0, BREADBOARD_TOP - 3, '#dddcd2');
  marks(kit, HOLE, pins, BREADBOARD_TOP, kit.solid('#6f6c62'));
  for (const [y, color] of [[5, '#d33'], [25, '#36c'], [185, '#d33'], [205, '#36c']]) slab(kit, 15, y - 0.5, length, 1, BREADBOARD_TOP, 0.1, color);
  print(kit, { x: 0, y: 0, w: width, h: 210 }, BREADBOARD_TOP, (ink) => {
    for (let column = 0; column < columns; column += 5) ink.text(column + 1, 20 + column * 10, 44, 4, '#888');
    for (const y of [12, 192]) ink.text('+', 8, y, 6, '#d33');
    for (const y of [22, 202]) ink.text('-', 8, y, 6, '#36c');
  });
}

// One digit of a segment display. Returns its lamps in the order a, b, c, d, e, f, g, point.
function digit(kit, x, y, s, top) {
  const boxes = [
    [x + 2, y, s - 4, 2], [x + s - 1, y + 2, 2, s - 2], [x + s - 1, y + s + 2, 2, s - 2], [x + 2, y + 2 * s, s - 4, 2],
    [x - 1, y + s + 2, 2, s - 2], [x - 1, y + 2, 2, s - 2], [x + 2, y + s, s - 4, 2],
  ];
  const light = () => lamp('#3a0d0a', { emissive: '#ff2a1f', emissiveIntensity: 0 });
  const lamps = boxes.map(([bx, by, w, h]) => add(kit, block({ x: bx, y: by, w, h }, top, 0.4, light())).material);
  lamps.push(add(kit, post(x + s + 3, y + 2 * s + 1, 1.2, top, 0.4, light())).material);
  return lamps;
}

const shine = (lamps, levels = []) => lamps.forEach((material, i) => { material.emissiveIntensity = 2.4 * (levels[i] ?? 0); });

const paintLcd = (view) => (ink) => {
  ink.fill(view?.backlight === false ? '#5e7a3a' : '#a8d04a', 8, 8, 134, 32, 1);
  const lines = view?.lines ?? [];
  for (let row = 0; row < 2; row++) {
    for (let column = 0; column < 16; column++) {
      const character = (lines[row] ?? '').charAt(column);
      if (character.trim()) ink.text(character, 13 + column * 8, 22 + row * 13, 10, '#0a2a0a', 'left', 'monospace');
    }
  }
};

function lcd(kit) {
  const top = moduleBoard(kit, { x: -4, y: -2, w: 158, h: 66 }, '#1f7a3a');
  slab(kit, 4, 4, 142, 40, top, 6, '#1a1a1a');
  const screen = print(kit, { x: 8, y: 8, w: 134, h: 32 }, top + 6, paintLcd(), { lit: 0.35 });
  return (view) => {
    screen.material.emissiveIntensity = view?.backlight === false ? 0.05 : 0.35;
    screen.repaint(paintLcd(view));
  };
}

// A chip in a two-row package, with its legs bent out to both rows of holes.
const dip = (name) => (kit) => {
  const body = { x: -3, y: 5, w: 76, h: 20 };
  addLegs(kit, pinsOf(kit), body, 6);
  slab(kit, body.x, body.y, body.w, body.h, 3, 7, '#222', { roughness: 0.5 });
  rod(kit, 1, 15, 2, 10, 0.1, '#444');
  print(kit, body, 10, (ink) => ink.text(name, 35, 17, 6, '#ccc'));
};

const METER_KEYS = ['V', 'A', 'Ω'];

function multimeter(kit) {
  plate(kit, roundedBox(-6, -6, 72, 92, 6), 0, 9, kit.solid('#e0a526', { roughness: 0.55 }));
  slab(kit, -2, -2, 64, 32, 9, 1, '#2b2b2b');
  const paintScreen = (view) => (ink) => {
    ink.fill('#b7c9a8', 0, 0, 60, 28, 2);
    ink.text(view?.reading ?? '---', 56, 17, 13, '#16230f', 'right');
    ink.text(view?.unit ?? '', 56, 25, 6, '#16230f', 'right');
  };
  const paintKeys = (mode) => (ink) => METER_KEYS.forEach((label, i) => ink.text(label, 12 + i * 18, 44, 9, i === mode ? '#222' : '#ddd'));
  const screen = print(kit, { x: 0, y: 0, w: 60, h: 28 }, 10, paintScreen(), { lit: 0.25 });
  const keys = METER_KEYS.map((_, i) => add(kit, block({ x: 4 + i * 18, y: 34, w: 16, h: 13 }, 9, 1.5, lamp('#3a3a3a'))));
  const labels = print(kit, { x: 4, y: 34, w: 52, h: 13 }, 10.5, paintKeys(0));
  print(kit, { x: -6, y: 52, w: 72, h: 24 }, 9, (ink) => {
    ink.text('Click to change', 30, 60, 4.4, '#3b2a00');
    ink.text('V', 20, 72, 5, '#3b2a00');
    ink.text('COM', 40, 72, 5, '#3b2a00');
  });
  // The probe leads plug in here, where the catalog has the meter's pins.
  rod(kit, 20, 80, 3.6, 9, 1.5, '#c8281e');
  rod(kit, 40, 80, 3.6, 9, 1.5, '#1c1c1c');
  return (view) => {
    const mode = view?.mode ?? 0;
    keys.forEach((key, i) => key.material.color.set(i === mode ? '#ffd60a' : '#3a3a3a'));
    labels.repaint(paintKeys(mode));
    screen.repaint(paintScreen(view));
  };
}

export const BUILDERS = {
  [BOARD_TYPE]: board,
  'breadboard-half': breadboard,
  'breadboard-full': breadboard,

  // --- Basics ---

  resistor(kit) {
    const band = addAxial(kit, 24, 3.4, 6, kit.solid('#d9b98a'));
    resistorBands(kit.part.props?.ohms ?? 220).forEach((value, i) => band(12 + i * 5, 2.5, BAND[value]));
    band(28, 2, '#c5a032');
  },

  diode(kit) {
    addAxial(kit, 20, 2.8, 5, kit.solid('#222'))(25, 3, '#ddd');
  },

  capacitor(kit) {
    const { x, y } = pinMiddle(pinsOf(kit));
    legs(kit, 4);
    rod(kit, x, y, 7, 3, 20, '#1f3d7a', { roughness: 0.4 });
    rod(kit, x, y, 6.6, 23, 0.4, METAL, { metalness: 0.5 });
    // The pale stripe down the front marks the side the negative leg is on.
    const stripe = new THREE.Mesh(new THREE.CylinderGeometry(7.08, 7.08, 16, 10, 1, true, -0.05, 0.8), kit.solid('#c9d3e6'));
    stripe.position.set(x, 13, y);
    add(kit, stripe);
  },

  led(kit) {
    const color = LED_HEX[kit.part.props?.color] ?? LED_HEX.red;
    const { x, y } = pinMiddle(pinsOf(kit));
    legs(kit, 6);
    const { material, glow } = addLens(kit, x, y, 5, color);
    return (view) => {
      const level = view?.burned ? 0 : view?.brightness ?? 0;
      material.color.set(view?.burned ? '#333' : color);
      material.emissiveIntensity = level * 2.5;
      glow(color, level, 34);
    };
  },

  'rgb-led'(kit) {
    const { x, y } = pinMiddle(pinsOf(kit));
    legs(kit, 6);
    const { material, glow } = addLens(kit, x, y, 8, '#dfe4ea');
    return (view) => {
      const [r, g, b] = view?.rgb ?? [0, 0, 0];
      const level = Math.max(r, g, b);
      const color = new THREE.Color(r, g, b);
      material.color.set(level > 0 ? color : '#dfe4ea');
      material.emissive.copy(color);
      material.emissiveIntensity = 2.5;
      glow(color, level, 46);
    };
  },

  npn: halfRound('NPN'),

  // A flat package standing in front of its metal tab.
  nmos(kit) {
    legs(kit, 8);
    slab(kit, -3, 7.5, 26, 5, 8, 16, '#222', { roughness: 0.5 });
    slab(kit, -3, 6, 26, 1.5, 8, 27, METAL, SHINY);
    print(kit, { x: -3, y: 8, w: 26, h: 16 }, 12.5, (ink) => ink.text('MOS', 10, 10, 6, '#bbb'), { facing: 'front' });
  },

  // --- Input ---

  button(kit) {
    const body = { x: 0, y: 3, w: 20, h: 24 };
    const red = lamp('#e0403a');
    addLegs(kit, pinsOf(kit), body, 4);
    add(kit, block(body, 3, 5, kit.solid('#333')));
    const cap = add(kit, post(10, 15, 7.5, 8, 5, red));
    return (view) => {
      cap.position.y = view?.pressed ? 9 : 10.5;
      red.color.set(view?.pressed ? '#b02a23' : '#e0403a');
    };
  },

  'slide-switch'(kit) {
    legs(kit, 4);
    slab(kit, -4, 5, 28, 10, 3, 7, '#2a2a2a', SHINY);
    const knob = slab(kit, 0, 7.5, 8, 5, 10, 4, '#ccc');
    return (view) => {
      knob.position.x = view?.position ? 16 : 4;
    };
  },

  'tilt-switch'(kit) {
    legs(kit, 5);
    const can = pivot(kit, 5, 5, 10);
    rod(can.kit, 5, 10, 4.5, 5, 14, '#3b3b3b', SHINY);
    rod(can.kit, 5, 10, 4.7, 5, 1.5, '#7a8f6a');
    return (view) => {
      can.joint.rotation.z = view?.tilted ? -0.6 : 0;
    };
  },

  potentiometer(kit) {
    legs(kit, 4);
    slab(kit, -4, 12, 28, 16, 3, 9, '#1f4f8f');
    const dial = pivot(kit, 10, 12, 20);
    rod(dial.kit, 10, 20, 7.5, 12, 2.5, '#d8dce2');
    rod(dial.kit, 10, 20, 3, 14.5, 10, '#d8dce2');
    slab(dial.kit, 9.2, 13, 1.6, 7, 14.5, 0.4, '#333');
    slab(dial.kit, 9.2, 17, 1.6, 3, 24.5, 0.3, '#333');
    return (view) => {
      dial.joint.rotation.y = -rad(((view?.position ?? 0.5) - 0.5) * 270);
    };
  },

  'rotary-encoder'(kit) {
    const top = moduleBoard(kit, { x: -4, y: -8, w: 48, h: 32 }, '#123c6a');
    slab(kit, 13, -2, 14, 14, top, 7, '#9aa0a8', SHINY);
    const knob = pivot(kit, 20, top + 7, 5);
    rod(knob.kit, 20, 5, 3, top + 7, 5, METAL);
    rod(knob.kit, 20, 5, 7, top + 12, 10, '#2b2b2b');
    slab(knob.kit, 19.2, -2, 1.6, 6, top + 22, 0.3, '#ddd');
    return (view) => {
      knob.joint.rotation.y = -rad((view?.steps ?? 0) * 18);
      knob.joint.position.y = top + 7 - (view?.pressed ? 1.5 : 0);
    };
  },

  joystick(kit) {
    const top = moduleBoard(kit, { x: -4, y: -6, w: 48, h: 50 }, '#14335c');
    slab(kit, 7, 2, 26, 26, top, 9, '#1c1c1c');
    const stick = pivot(kit, 20, top + 9, 15);
    add(stick.kit, dome(20, 15, 8, top + 9, kit.solid('#222')));
    rod(stick.kit, 20, 15, 2.5, top + 9, 12, '#222');
    const cap = add(stick.kit, post(20, 15, 9, top + 21, 3, lamp('#333')));
    return (view) => {
      stick.joint.rotation.z = -((view?.x ?? 0.5) - 0.5) * 0.9;
      stick.joint.rotation.x = ((view?.y ?? 0.5) - 0.5) * 0.9;
      stick.joint.position.y = top + 9 - (view?.pressed ? 1.5 : 0);
      cap.material.color.set(view?.pressed ? '#555' : '#333');
    };
  },

  // A flat keypad on a ribbon, with its connector over the pins.
  'keypad-4x4'(kit) {
    const labels = '123A456B789C*0#D';
    legs(kit, 2);
    slab(kit, -4, -4, 78, 84, 1, 2, '#1b1b1b');
    slab(kit, 5, 80, 60, 8, 1, 0.6, '#c8c0a8');
    slab(kit, -4, 86, 78, 8, 0, 7, '#1a1a1a');
    const spot = (i) => ({ x: (i % 4) * 18, y: Math.floor(i / 4) * 19 });
    const caps = [...labels].map((_, i) => add(kit, block({ ...spot(i), w: 15, h: 15 }, 3, 1.4, lamp('#e8e8e8'))));
    print(kit, { x: 0, y: 0, w: 69, h: 72 }, 4.4, (ink) => {
      [...labels].forEach((label, i) => ink.text(label, spot(i).x + 7.5, spot(i).y + 10.5, 8, '#222'));
    });
    return (view) => caps.forEach((cap, i) => {
      const down = view?.key === i + 1;
      cap.material.color.set(down ? '#9ad' : '#e8e8e8');
      cap.position.y = down ? 3.3 : 3.7;
    });
  },

  'touch-pad'(kit) {
    legs(kit, 3);
    const pad = add(kit, block({ x: -2, y: -2, w: 24, h: 18 }, 2, 1, lamp(GOLD, SHINY)));
    slab(kit, 8, 16, 4, 6, 2, 1, GOLD, SHINY);
    print(kit, { x: -2, y: -2, w: 24, h: 18 }, 3, (ink) => ink.text('TOUCH', 10, 9, 4.5, '#333'));
    return (view) => pad.material.color.set(view?.pressed ? '#e6c35c' : GOLD);
  },

  // --- Sensors ---

  photoresistor(kit) {
    legs(kit, 8);
    rod(kit, 5, 10, 7, 8, 2.5, '#c8742e');
    print(kit, { x: -2, y: 3, w: 14, h: 14 }, 10.5, (ink) => {
      for (let i = 0; i < 5; i++) ink.fill('#6b2d10', i % 2 ? 2 : 0, 5.5 + i * 2, 8, 0.9);
    });
    const glow = addGlow(kit, 5, 12, 10);
    return (view) => glow('#ffe066', (view?.light ?? 0.5) * 0.5, 30);
  },

  thermistor(kit) {
    legs(kit, 8);
    add(kit, ball(5, 11, 10, 5, kit.solid('#1d4f3a', { roughness: 0.4 }))).scale.y = 0.8;
  },

  // A thin film: the round pad is pressed, and the tail runs back to the pins.
  fsr(kit) {
    legs(kit, 2);
    slab(kit, 0, 6, 10, 15, 1, 0.6, '#222');
    rod(kit, 5, -3, 10, 1, 0.6, '#2a2a2a');
    const pad = add(kit, post(5, -3, 6, 1.6, 0.2, lamp('#888')));
    return (view) => pad.material.color.setScalar(0.12 + 0.6 * (view?.force ?? 0));
  },

  tmp36: halfRound('TMP36'),

  // Stands upright, with its vents facing forward.
  dht(kit) {
    const model = kit.part.props?.model === 'DHT22' ? 'DHT22' : 'DHT11';
    const pale = model === 'DHT22';
    legs(kit, 6);
    slab(kit, -4, 26, 38, 9, 5, 36, pale ? '#ececec' : '#3a79c4');
    print(kit, { x: -4, y: 5, w: 38, h: 36 }, 35, (ink) => {
      for (let i = 0; i < 20; i++) ink.fill('#0007', 2 + (i % 5) * 6, 4 + Math.floor(i / 5) * 5.5, 3.5, 3.5, 0.5);
      ink.text(model, 15, 32, 5, pale ? '#333' : '#fff');
    }, { facing: 'front' });
  },

  ds18b20: halfRound('DS18'),

  // Stands upright, looking forward through its two round transducers.
  hcsr04(kit) {
    const pins = pinsOf(kit);
    const silver = kit.solid('#b8bcc2', SHINY);
    legs(kit, 8);
    slab(kit, -1, 39, 52, 2, 6, 38, '#1b4f8f');
    for (const x of [13, 37]) {
      add(kit, bar(at(x, 27, 41), at(x, 27, 52), 10.5, silver, ROUND));
      add(kit, bar(at(x, 27, 52), at(x, 27, 52.3), 8, kit.solid('#333'), ROUND));
    }
    slab(kit, 21, 41, 8, 2, 36, 5, METAL, SHINY);
    print(kit, { x: -1, y: 6, w: 52, h: 38 }, 41, (ink) => {
      ink.text('HC-SR04', 25, 5, 3.6);
      for (const pin of pins) ink.text(pin.id, pin.x, 35.5, 3.6);
    }, { facing: 'front' });
  },

  pir(kit) {
    const top = moduleBoard(kit, { x: -4, y: -6, w: 38, h: 40 }, '#1d5e3a');
    slab(kit, 2, -4, 26, 26, top, 3, '#f5f5f5');
    const lens = add(kit, dome(15, 9, 12, top + 3, lamp('#f5f5f5', { roughness: 0.3, emissive: '#ff3b30', emissiveIntensity: 0 })));
    const glow = addGlow(kit, 15, top + 12, 9);
    return (view) => {
      lens.material.emissiveIntensity = view?.active ? 0.7 : 0;
      glow('#ff3b30', view?.active ? 0.5 : 0, 44);
    };
  },

  'sound-sensor'(kit) {
    const top = moduleBoard(kit, { x: -4, y: -6, w: 38, h: 40 }, '#8c1c1c');
    rod(kit, 13, 7, 8.5, top, 7, '#aaa', SHINY);
    slab(kit, 24, 14, 8, 8, top, 5, '#2a5fa8');
    // The dark middle of the microphone grows with the sound.
    const middle = add(kit, post(13, 7, 1, top + 7, 0.2, kit.solid('#222')));
    return (view) => {
      const size = 6 * (view?.level ?? 0.1) + 1;
      middle.scale.set(size, 1, size);
    };
  },

  'water-sensor'(kit) {
    const top = moduleBoard(kit, { x: -4, y: -14, w: 28, h: 58 }, '#b22');
    for (let i = 0; i < 4; i++) slab(kit, 0, -10 + i * 8, 20, 3, top, 0.2, '#ddc', SHINY);
    const water = add(kit, block({ x: -4, y: -14, w: 28, h: 38 }, top + 0.3, 1.2, lamp('#39f', { transparent: true, opacity: 0.45, roughness: 0.1 })));
    water.visible = false;
    return (view) => {
      const level = view?.level ?? 0;
      water.visible = level > 0;
      water.scale.z = Math.max(level, 0.001);
      water.position.z = 24 - 19 * level;
    };
  },

  'ir-receiver'(kit) {
    legs(kit, 9);
    slab(kit, 0, 16, 20, 8, 8, 13, '#1c1c1c', { roughness: 0.4 });
    add(kit, ball(10, 15, 24, 5, kit.solid('#444', { roughness: 0.3 }))).scale.z = 0.6;
  },

  // The whole board leans as its tilt sliders move.
  mpu6050(kit) {
    const tilt = pivot(kit, 15, 0, 20);
    breakout(30, 40, '#123c6a', 'MPU6050')(tilt.kit);
    return (view) => {
      tilt.joint.rotation.z = -rad(view?.tiltX ?? 0) * 0.3;
      tilt.joint.rotation.x = rad(view?.tiltY ?? 0) * 0.3;
    };
  },

  mcp9808: breakout(30, 30, '#1b2a55', 'MCP9808'),
  ds3231: breakout(30, 30, '#16523a', 'DS3231', (kit, top) => rod(kit, 15, 17, 6.5, top, 2.5, METAL, SHINY)),

  // --- Output ---

  piezo(kit) {
    legs(kit, 4);
    rod(kit, 10, 20, 11.5, 3, 9, '#222', { roughness: 0.5 });
    rod(kit, 10, 20, 3, 12, 0.2, '#000');
    const glow = addGlow(kit, 10, 16, 20);
    return (view) => glow('#ffd60a', view?.tone ? 0.45 : 0, 46);
  },

  servo(kit) {
    const body = { x: 0, y: 0, w: 40, h: 40 };
    const blue = kit.solid('#2a5fa8');
    pinsOf(kit).forEach((pin, i) => addLegs(kit, [pin], body, 6, kit.solid(['#6b4a2b', '#d33', '#e8a33d'][i])));
    add(kit, block(body, 3, 24, blue));
    add(kit, block({ x: -6, y: 15, w: 52, h: 5 }, 18, 2, blue));
    const horn = pivot(kit, 20, 27, 14);
    rod(horn.kit, 20, 14, 6, 27, 3, '#f0f0f0');
    slab(horn.kit, 18.4, -6, 3.2, 20, 28, 2, '#f0f0f0');
    return (view) => {
      horn.joint.rotation.y = -rad((view?.angle ?? 90) - 90);
    };
  },

  // Stands on end, so its propeller can be seen turning.
  'dc-motor'(kit) {
    addLegs(kit, pinsOf(kit), { x: 3, y: 20, w: 24, h: 20 }, 6);
    rod(kit, 15, 30, 13, 4, 20, '#b8bcc2', SHINY);
    rod(kit, 15, 30, 13.2, 4, 3, '#222');
    rod(kit, 15, 30, 4, 24, 2, '#888');
    const spin = pivot(kit, 15, 26, 30);
    rod(spin.kit, 15, 30, 1.2, 26, 5, METAL);
    slab(spin.kit, 1, 29, 28, 2, 30, 1, '#333');
    slab(spin.kit, 14, 16, 2, 28, 30, 1, '#333');
    return (view) => {
      spin.joint.rotation.y = -rad(view?.angle ?? 0);
    };
  },

  'stepper-uln2003'(kit) {
    const top = moduleBoard(kit, { x: -4, y: -4, w: 58, h: 58 }, '#1e4f8a');
    rod(kit, 25, 18, 15, top, 16, '#bbb', SHINY);
    rod(kit, 25, 18, 4, top + 16, 2, '#999');
    slab(kit, 38, 34, 14, 8, top, 3, '#1a1a1a');
    const spin = pivot(kit, 25, top + 18, 18);
    rod(spin.kit, 25, 18, 1.5, top + 18, 5, '#d9b64d', SHINY);
    slab(spin.kit, 24, 6, 2, 12, top + 21, 1, '#333');
    return (view) => {
      spin.joint.rotation.y = -rad(view?.angle ?? 0);
    };
  },

  'relay-module'(kit) {
    const top = moduleBoard(kit, { x: -4, y: -9, w: 58, h: 53 }, '#17406f');
    const switched = pinsOf(kit).filter((pin) => pin.y === 0);
    slab(kit, 6, 8, 38, 20, top, 15, '#1d6fd1');
    print(kit, { x: 6, y: 8, w: 38, h: 20 }, top + 15, (ink) => ink.text('RELAY', 25, 20, 6, '#fff'));
    // The screw terminals for the circuit being switched, named on top where they can be read.
    slab(kit, 26, -9, 28, 12, top, 9, '#2e8b57');
    marks(kit, PAD, switched, top + 9, kit.solid(METAL, SHINY));
    print(kit, { x: 26, y: -9, w: 28, h: 12 }, top + 9, (ink) => {
      for (const pin of switched) ink.text(pin.id, pin.x, -4, 3.4, '#fff');
    });
    const light = add(kit, block({ x: 45, y: 30, w: 5, h: 4 }, top, 1.5, lamp('#400', { emissive: '#ff3b30', emissiveIntensity: 0 })));
    return (view) => {
      light.material.emissiveIntensity = view?.energized ? 2.5 : 0;
    };
  },

  neopixel(kit) {
    const count = Math.min(Number(kit.part.props?.count) || 8, 30);
    const spacing = 12;
    legs(kit, 6.5);
    slab(kit, -3, -8, count * spacing + 4, 18, 5, 1, '#111');
    slab(kit, -3, 10, 26, 13, 5, 1, '#111');
    print(kit, { x: -3, y: 10, w: 26, h: 13 }, 6, (ink) => {
      for (const pin of pinsOf(kit)) ink.text(pin.id, pin.x, 16, 3.6);
    });
    const pixels = Array.from({ length: count }, (_, i) => {
      slab(kit, i * spacing, -4, 10, 10, 6, 1.6, '#f3f3f3');
      const lens = add(kit, post(i * spacing + 5, 1, 3.5, 7.6, 0.4, lamp('#ccc', { emissive: '#000', emissiveIntensity: 2 })));
      return { lens, glow: addGlow(kit, i * spacing + 5, 9.5, 1) };
    });
    return (view) => pixels.forEach(({ lens, glow }, i) => {
      const color = `#${view?.pixels?.[i] ?? '000000'}`;
      const lit = color !== '#000000';
      lens.material.color.set(lit ? color : '#ccc');
      lens.material.emissive.set(lit ? color : '#000');
      glow(color, lit ? 0.8 : 0, 22);
    });
  },

  // --- Displays ---

  'seven-segment'(kit) {
    legs(kit, 5);
    slab(kit, -4, 3, 48, 44, 3, 9, '#1d1d1d');
    const lamps = digit(kit, 10, 8, 14, 12);
    return (view) => shine(lamps, view?.segments);
  },

  'seven-segment-4'(kit) {
    legs(kit, 5);
    slab(kit, -5, 3, 60, 34, 3, 9, '#1d1d1d');
    const digits = [0, 1, 2, 3].map((i) => digit(kit, -1 + i * 14, 8, 9, 12));
    return (view) => digits.forEach((lamps, i) => shine(lamps, view?.digits?.[i]));
  },

  'led-bar'(kit) {
    legs(kit, 5);
    slab(kit, -4, 3, 98, 24, 3, 8, '#222');
    const lamps = Array.from({ length: 10 }, (_, i) => (
      add(kit, block({ x: i * 10 - 3, y: 7, w: 6, h: 16 }, 11, 0.5, lamp('#4a1210', { emissive: '#ff3b30', emissiveIntensity: 0 }))).material));
    return (view) => shine(lamps, view?.levels);
  },

  'led-matrix'(kit) {
    const top = moduleBoard(kit, { x: -2, y: -4, w: 74, h: 90 }, '#14335c');
    const on = new THREE.Color('#ff3b30');
    const off = new THREE.Color('#3a1414');
    slab(kit, 0, -2, 70, 68, top, 8, '#111');
    const spots = Array.from({ length: 64 }, (_, i) => ({ x: 7 + (i % 8) * 8, y: 6 + Math.floor(i / 8) * 8 }));
    // Lights that are on shine whatever the room's light, so they are not shaded.
    const lights = marks(kit, new THREE.CylinderGeometry(3, 3, 0.6, 14), spots, top + 8.2, new THREE.MeshBasicMaterial());
    return (view) => {
      spots.forEach((_, i) => lights.setColorAt(i, ((view?.rows?.[Math.floor(i / 8)] ?? 0) >> (7 - (i % 8))) & 1 ? on : off));
      lights.instanceColor.needsUpdate = true;
    };
  },

  lcd1602: lcd,
  'lcd-i2c': lcd,

  'oled-ssd1306'(kit) {
    const top = moduleBoard(kit, { x: -2, y: -6, w: 64, h: 70 }, '#123c6a');
    slab(kit, 0, 2, 60, 36, top, 1.5, '#050505', { roughness: 0.2 });
    // The screen's own 128 by 64 dots, shown without smoothing.
    const canvas = kit.canvas(128, 64);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.magFilter = THREE.NearestFilter;
    const material = new THREE.MeshStandardMaterial({ map: texture, emissive: '#fff', emissiveMap: texture, emissiveIntensity: 0.9, roughness: 0.2 });
    const screen = new THREE.Mesh(new THREE.PlaneGeometry(60, 30).rotateX(-Math.PI / 2), material);
    screen.position.set(30, top + 1.5 + PRINT_GAP, 17);
    screen.userData.print = true;
    add(kit, screen);
    let image;
    return (view) => {
      const context = canvas.getContext('2d');
      context.fillStyle = '#000';
      context.fillRect(0, 0, 128, 64);
      if (view?.on && view.pixels) {
        const bytes = Uint8Array.from(atob(view.pixels), (c) => c.charCodeAt(0));
        image ??= context.createImageData(128, 64);
        for (let i = 0; i < 128 * 64; i++) {
          const lit = (bytes[(i >> 10) * 128 + (i & 127)] >> ((i >> 7) & 7)) & 1;
          image.data.set(lit ? [120, 220, 255, 255] : [0, 0, 0, 255], i * 4);
        }
        context.putImageData(image, 0, 0);
      }
      texture.needsUpdate = true;
      kit.events.drawn();
    };
  },

  // --- Chips, power and tools ---

  'shift-register': dip('74HC595'),
  l293d: dip('L293D'),

  // Stands on the table, with a lead from each snap down to its pin.
  battery(kit) {
    const snap = kit.solid(METAL, SHINY);
    legs(kit, 5);
    slab(kit, 0, 6, 30, 22, 0, 40, '#222', { roughness: 0.5 });
    slab(kit, 0, 6, 30, 22, 40, 6, GOLD, SHINY);
    add(kit, post(8, 17, 4, 46, 3, snap));
    add(kit, post(22, 17, 5, 46, 3, snap));
    // Each lead runs to the corner above its pin and then down, which leaves the label clear.
    for (const [from, to, color] of [[8, 0, '#d33'], [22, 30, '#333']]) {
      add(kit, bar(at(from, 48, 17), at(to, 47, 29.5), 1, kit.solid(color)));
      add(kit, bar(at(to, 47, 29.5), at(to, 5, 40), 1, kit.solid(color)));
    }
    print(kit, { x: 0, y: 0, w: 30, h: 40 }, 28, (ink) => ink.text(`${kit.part.props?.volts ?? 9}V`, 15, 24, 9, '#fff'), { facing: 'front' });
  },

  multimeter,
};

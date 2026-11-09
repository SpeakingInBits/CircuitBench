// Builds every part's 3D model without a browser or a graphics card.
import assert from 'node:assert/strict';
import test from 'node:test';
import { CATALOG, defaultProps, definition } from '../shared/catalog.js';
import { BUILDERS } from '../webview/models3d.js';
import * as THREE from '../webview/vendor/three/three.module.js';

// Stands in for a page's canvas: it takes any drawing and keeps none of it.
function fakeCanvas(width, height) {
  const context = new Proxy({}, {
    get: (target, name) => target[name] ?? (name === 'createImageData' ? (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }) : () => {}),
  });
  return { width, height, getContext: () => context };
}

function build(type, extra = {}) {
  const part = { id: 'p', type, x: 0, y: 0, rotation: 0, props: defaultProps(type), ...extra };
  const root = new THREE.Group();
  const materials = new Map();
  const made = { prints: 0 };
  const update = BUILDERS[type]({
    part,
    root,
    textureLimit: 1536,
    glowTexture: new THREE.Texture(),
    canvas: fakeCanvas,
    events: { drawn: () => { made.prints++; }, failed: () => assert.fail(`${type} failed to draw`) },
    solid(color, options = {}) {
      const key = color + JSON.stringify(options);
      if (!materials.has(key)) materials.set(key, new THREE.MeshStandardMaterial({ color, roughness: 0.6, ...options }));
      return materials.get(key);
    },
  });
  return { root, update, made };
}

const meshes = (root) => {
  const found = [];
  root.traverse((child) => { if (child.isMesh) found.push(child); });
  return found;
};

const modelled = Object.keys(CATALOG).filter((type) => !definition(type).annotation);

test('every part in the catalog has a 3D model', () => {
  for (const type of modelled) {
    assert.equal(typeof BUILDERS[type], 'function', `${type} has no 3D model. Add one to BUILDERS in webview/models3d.js.`);
  }
});

test('every model stands on its surface, over its own pins', () => {
  for (const type of modelled) {
    const { root } = build(type);
    const box = new THREE.Box3().setFromObject(root);
    for (const value of [...box.min.toArray(), ...box.max.toArray()]) assert.ok(Number.isFinite(value), `${type} has no size`);
    assert.ok(box.min.y <= 0.5, `${type} floats ${box.min.y} above its surface`);
    assert.ok(box.max.y > 1 && box.max.y < 80, `${type} is ${box.max.y} tall`);
    for (const pin of definition(type).pins) {
      const over = pin.x >= box.min.x - 1 && pin.x <= box.max.x + 1 && pin.y >= box.min.z - 1 && pin.y <= box.max.z + 1;
      assert.ok(over, `${type} does not reach its pin ${pin.id}`);
    }
  }
});

test('every model can be flipped, and shows a part with no live state', () => {
  for (const type of modelled) {
    for (const flip of [false, true]) {
      const { update } = build(type, { flip });
      update?.(undefined);
      update?.({});
    }
  }
});

test('lights follow the simulation', () => {
  const lit = (type, view) => {
    const { root, update } = build(type);
    update(view);
    const glow = ({ emissive, emissiveMap, emissiveIntensity }) => (emissive && !emissiveMap ? Math.max(...emissive.toArray()) * emissiveIntensity : 0);
    return Math.max(...meshes(root).map((mesh) => glow(mesh.material)));
  };
  assert.equal(lit('led', { brightness: 0 }), 0);
  assert.ok(lit('led', { brightness: 1 }) > 1);
  assert.equal(lit('led', { brightness: 1, burned: true }), 0);
  assert.ok(lit('seven-segment', { segments: [1, 0, 0, 0, 0, 0, 0, 0] }) > 1);
  assert.ok(lit('led-bar', { levels: [0, 0, 1] }) > 1);
  assert.ok(lit('relay-module', { energized: true }) > 1);
  assert.equal(lit('relay-module', { energized: false }), 0);
});

test('moving parts follow the simulation', () => {
  const turned = (type, view) => {
    const { root, update } = build(type);
    const pose = () => {
      root.updateWorldMatrix(true, true);
      return JSON.stringify(meshes(root).map((mesh) => mesh.matrixWorld.elements.map((value) => Math.round(value * 1000))));
    };
    const before = pose();
    update(view);
    return pose() !== before;
  };
  assert.ok(turned('servo', { angle: 0 }), 'the servo horn turns');
  assert.ok(turned('button', { pressed: true }), 'the button goes down');
  assert.ok(turned('slide-switch', { position: 1 }), 'the switch slides');
  assert.ok(turned('tilt-switch', { tilted: true }), 'the tilt switch leans');
  assert.ok(turned('joystick', { x: 1, y: 0 }), 'the joystick leans');
  assert.ok(turned('water-sensor', { level: 0.5 }), 'the water rises');
  assert.ok(turned('potentiometer', { position: 1 }), 'the dial turns');
  assert.ok(turned('rotary-encoder', { steps: 3 }), 'the knob turns');
  assert.ok(turned('stepper-uln2003', { angle: 90 }), 'the shaft turns');
  assert.ok(turned('dc-motor', { angle: 45 }), 'the propeller turns');
  assert.ok(turned('mpu6050', { tiltX: 45, tiltY: 0 }), 'the board leans');
});

test('screens are redrawn when what they show changes', () => {
  const pixels = Buffer.alloc(1024, 0xff).toString('base64');
  const views = {
    lcd1602: { lines: ['Hello', 'World'], backlight: true },
    'lcd-i2c': { lines: ['Hello'], backlight: false },
    'oled-ssd1306': { on: true, pixels },
    multimeter: { mode: 2, reading: '4.70', unit: 'kΩ' },
  };
  for (const [type, view] of Object.entries(views)) {
    const { update, made } = build(type);
    const before = made.prints;
    update(view);
    assert.ok(made.prints > before, `${type} did not redraw`);
  }
});

test('a NeoPixel strip has a light for each of its pixels', () => {
  const sprites = (count) => build('neopixel', { props: { count } }).root.children.filter((child) => child.isSprite).length;
  assert.equal(sprites(4), 4);
  assert.equal(sprites(30), 30);
  assert.equal(sprites(500), 30);
});

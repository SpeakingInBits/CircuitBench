// The 3D view of a circuit. Parts can be picked and dragged here, but main.js does the moving,
// sharing the 2D canvas's drag, so snapping, undo and saving work the same in both. main.js imports this file the first time a student opens the view, so three.js costs nothing
// until then. It draws only when something changes, and dispose() gives the memory back.
//
// Every part gets a body and legs from its catalog entry and 2D art, with the art on top, so a
// new part appears here with no extra work. BUILDERS holds the few parts worth modelling by hand.
import * as THREE from './vendor/three/three.module.js';
import { BOARD_TYPE, definition, pinPosition } from '../shared/catalog.js';
import { BAND, LED_HEX, holePattern, partArt, resistorBands } from './art.js';
import { BOARD_TOP, BREADBOARD_TOP, HEADER_TOP, isSurface, partBase, partBody, sceneBounds, surfaces, wireRoute } from './layout3d.js';

const TABLE_COLOR = '#56636d'; // Matches the 2D canvas.
const METAL = '#c4c7cc';
const SELECTED = '#3399ff'; // The 2D canvas's selection outline.
const CLICK_SLOP = 4; // Pixels the pointer can move before a click becomes a drag.
const FIELD_OF_VIEW = 32;
const LOWEST_VIEW = 1.45; // Radians from straight down, which keeps the camera above the table.
const BAR = new THREE.CylinderGeometry(1, 1, 1, 12);
const UP = new THREE.Vector3(0, 1, 0);

// Body height and how far it stands off its surface on its legs, by part type.
const BODY = {
  'keypad-4x4': [3, 2], 'touch-pad': [2, 2], 'lcd1602': [10, 8], 'lcd-i2c': [10, 8], 'shift-register': [6, 3], l293d: [6, 3],
  piezo: [10, 2], battery: [34, 0], dht: [12, 4], hcsr04: [8, 8], 'dc-motor': [20, 4], 'stepper-uln2003': [16, 4],
};
const DEFAULT_BODY = [5, 7];

const at = (x, h, y) => new THREE.Vector3(x, h, y);

function bar(from, to, radius, material) {
  const mesh = new THREE.Mesh(BAR, material);
  const direction = to.clone().sub(from);
  mesh.scale.set(radius, direction.length(), radius);
  mesh.position.copy(from).addScaledVector(direction, 0.5);
  mesh.quaternion.setFromUnitVectors(UP, direction.normalize());
  return mesh;
}

function block(box, bottom, height, material) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(box.w, height, box.h), material);
  mesh.position.set(box.x + box.w / 2, bottom + height / 2, box.y + box.h / 2);
  return mesh;
}

function post(x, y, radius, bottom, height, material) {
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, height, 28), material);
  mesh.position.set(x, bottom + height / 2, y);
  return mesh;
}

// A part's 2D art, drawn onto a texture. Drawing is asynchronous, so while one drawing is in
// progress newer art waits, and only the latest is ever drawn.
class ArtFace {
  constructor(crop, color, limit, events) {
    const scale = Math.min(8, limit / Math.max(crop.w, crop.h));
    this.crop = crop;
    this.color = color;
    this.events = events;
    this.canvas = document.createElement('canvas');
    this.canvas.width = Math.ceil(crop.w * scale);
    this.canvas.height = Math.ceil(crop.h * scale);
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.anisotropy = 8;
  }

  show(art) {
    if (art === this.art) return;
    this.art = art;
    if (!this.busy) this.draw();
  }

  draw() {
    const { art, canvas, crop } = this;
    const image = new Image();
    const finished = () => {
      this.busy = false;
      if (this.art !== art) this.draw();
    };
    this.busy = true;
    image.onload = () => {
      const context = canvas.getContext('2d');
      context.fillStyle = this.color;
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      this.texture.needsUpdate = true;
      this.events.drawn();
      finished();
    };
    image.onerror = () => {
      this.events.failed();
      finished();
    };
    // Unlike the 2D canvas this is parsed as strict XML, which rejects control characters.
    const clean = art.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, ' ');
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${crop.x} ${crop.y} ${crop.w} ${crop.h}" width="${canvas.width}" height="${canvas.height}"><defs>${holePattern()}</defs>${clean}</svg>`;
    image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  }
}

// Adds the art to the top of a body. Displays light up, so they also glow with their own art.
function addFace(kit, body, crop, height, lit) {
  const face = new ArtFace(crop, body.color, kit.textureLimit, kit.events);
  const geometry = body.shape === 'round' ? new THREE.CircleGeometry(body.w / 2, 40) : new THREE.PlaneGeometry(body.w, body.h);
  geometry.rotateX(-Math.PI / 2);
  const material = new THREE.MeshStandardMaterial({ map: face.texture, roughness: 0.75 });
  if (lit) {
    material.emissive = new THREE.Color('#fff');
    material.emissiveMap = face.texture;
    material.emissiveIntensity = 0.6;
  }
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.set(body.x + body.w / 2, height + 0.05, body.y + body.h / 2);
  kit.root.add(mesh);
  return face;
}

function addLegs(kit, pins, body, height, material = kit.solid(METAL)) {
  for (const pin of pins) {
    kit.root.add(bar(at(pin.x, -1, pin.y), at(pin.x, height, pin.y), 0.8, material));
    const x = Math.max(body.x, Math.min(body.x + body.w, pin.x));
    const y = Math.max(body.y, Math.min(body.y + body.h, pin.y));
    if (x !== pin.x || y !== pin.y) kit.root.add(bar(at(pin.x, height, pin.y), at(x, height, y), 0.8, material));
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
  const material = new THREE.MeshStandardMaterial({ color, transparent: true, opacity: 0.82, roughness: 0.25, emissive: color, emissiveIntensity: 0 });
  const bottom = 6;
  const barrel = radius * 1.1;
  kit.root.add(post(x, y, radius * 1.16, bottom, 1.2, material));
  kit.root.add(post(x, y, radius, bottom + 1.2, barrel, material));
  const dome = new THREE.Mesh(new THREE.SphereGeometry(radius, 28, 14, 0, Math.PI * 2, 0, Math.PI / 2), material);
  dome.position.set(x, bottom + 1.2 + barrel, y);
  kit.root.add(dome);
  return { material, glow: addGlow(kit, x, bottom + barrel, y) };
}

function addAxial(kit, length, radius, height, material) {
  const [first, second] = definition(kit.part.type).pins;
  const start = (length - (first.x + second.x)) / -2;
  const lead = kit.solid(METAL);
  for (const pin of [first, second]) kit.root.add(bar(at(pin.x, -1, pin.y), at(pin.x, height, pin.y), 0.8, lead));
  kit.root.add(bar(at(first.x, height, 0), at(second.x, height, 0), 0.8, lead));
  kit.root.add(bar(at(start, height, 0), at(start + length, height, 0), radius, material));
  return (from, width, color) => kit.root.add(bar(at(from, height, 0), at(from + width, height, 0), radius + 0.12, kit.solid(color)));
}

const pinsOf = (kit) => definition(kit.part.type).pins;
const pinMiddle = (pins) => ({
  x: pins.reduce((sum, pin) => sum + pin.x, 0) / pins.length,
  y: pins.reduce((sum, pin) => sum + pin.y, 0) / pins.length,
});

function standingLegs(kit, height) {
  for (const pin of pinsOf(kit)) kit.root.add(bar(at(pin.x, -1, pin.y), at(pin.x, height, pin.y), 0.8, kit.solid(METAL)));
}

// The flat-sided package of small transistors and sensors.
function halfRound(kit) {
  const { x, y } = pinMiddle(pinsOf(kit));
  const shape = new THREE.Shape();
  shape.absarc(0, 0, 10.5, 0, Math.PI);
  shape.closePath();
  const geometry = new THREE.ExtrudeGeometry(shape, { depth: 13, bevelEnabled: false, curveSegments: 20 });
  geometry.rotateX(-Math.PI / 2);
  const mesh = new THREE.Mesh(geometry, kit.solid('#222', { roughness: 0.5 }));
  mesh.position.set(x, 5, y + 4);
  kit.root.add(mesh);
  standingLegs(kit, 6);
}

function board(kit) {
  const { part, root } = kit;
  const entry = definition(part.type);
  const pcb = { shape: 'box', x: 0, y: 0, w: 284, h: entry.h, color: '#23262b' };
  const art = partArt(part);
  const black = kit.solid('#141414');
  root.add(block(pcb, BOARD_TOP - 3, 3, kit.solid(pcb.color)));
  for (const [x, y] of [[12, 12], [272, 12], [12, 198], [272, 198]]) root.add(post(x, y, 3, 0, BOARD_TOP - 3, kit.solid('#8d8f93')));
  addFace(kit, pcb, pcb, BOARD_TOP, false).show(art);

  const raised = (box, height, material, color = '#111') => {
    root.add(block(box, BOARD_TOP, height, material));
    addFace(kit, { ...box, shape: 'box', color }, box, BOARD_TOP + height, false).show(art);
  };
  for (const box of [
    { x: 76, y: 6, w: 98, h: 8 }, { x: 186, y: 6, w: 78, h: 8 }, { x: 96, y: 196, w: 68, h: 8 }, { x: 186, y: 196, w: 58, h: 8 },
    { x: 256, y: 86, w: 18, h: 18 },
  ]) raised(box, HEADER_TOP - BOARD_TOP, black);
  raised({ x: 112, y: 76, w: 48, h: 48 }, 3, black);
  root.add(block({ x: -8, y: 30, w: 34, h: 34 }, BOARD_TOP, 13, kit.solid('#b8bcc2', { metalness: 0.5, roughness: 0.4 })));
  root.add(block({ x: -8, y: 130, w: 40, h: 40 }, BOARD_TOP, 15, black));
  root.add(post(47, 177, 4, BOARD_TOP + 2, 2.5, kit.solid('#c33')));
  root.add(block({ x: 40, y: 170, w: 14, h: 14 }, BOARD_TOP, 2, kit.solid('#555')));

  const led = new THREE.MeshStandardMaterial({ color: '#552222', emissive: '#ff3b30', emissiveIntensity: 0 });
  const pixel = new THREE.MeshStandardMaterial({ color: '#eee', emissive: '#000' });
  root.add(block({ x: 66, y: 34, w: 8, h: 6 }, BOARD_TOP, 1.6, led));
  root.add(block({ x: 84, y: 30, w: 12, h: 12 }, BOARD_TOP, 2.2, pixel));
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

const BUILDERS = {
  [BOARD_TYPE]: board,

  led(kit) {
    const { part } = kit;
    const color = LED_HEX[part.props?.color] ?? LED_HEX.red;
    const { x, y } = pinMiddle(pinsOf(kit));
    standingLegs(kit, 6);
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
    standingLegs(kit, 6);
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
    standingLegs(kit, 4);
    kit.root.add(post(x, y, 7, 3, 20, kit.solid('#1f3d7a', { roughness: 0.4 })));
    kit.root.add(post(x, y, 6.6, 23, 0.4, kit.solid(METAL, { metalness: 0.5 })));
  },

  npn: halfRound,
  tmp36: halfRound,
  ds18b20: halfRound,

  button(kit) {
    const body = { x: 0, y: 3, w: 20, h: 24 };
    const red = kit.solid('#e0403a');
    addLegs(kit, pinsOf(kit), body, 4);
    kit.root.add(block(body, 3, 5, kit.solid('#333')));
    const cap = post(10, 15, 7.5, 8, 5, red);
    kit.root.add(cap);
    return (view) => {
      cap.position.y = view?.pressed ? 9 : 10.5;
      red.color.set(view?.pressed ? '#b02a23' : '#e0403a');
    };
  },

  servo(kit) {
    const body = { x: 0, y: 0, w: 40, h: 40 };
    const blue = kit.solid('#2a5fa8');
    const white = kit.solid('#f0f0f0');
    for (const [pin, color] of pinsOf(kit).map((p, i) => [p, ['#6b4a2b', '#d33', '#e8a33d'][i]])) {
      addLegs(kit, [pin], body, 6, kit.solid(color));
    }
    kit.root.add(block(body, 3, 24, blue));
    kit.root.add(block({ x: -6, y: 15, w: 52, h: 5 }, 18, 2, blue));
    const horn = new THREE.Group();
    horn.position.set(20, 27, 14);
    horn.add(post(0, 0, 6, 0, 3, white));
    horn.add(block({ x: -1.6, y: -20, w: 3.2, h: 20 }, 1, 2, white));
    kit.root.add(horn);
    return (view) => {
      horn.rotation.y = -THREE.MathUtils.degToRad((view?.angle ?? 90) - 90);
    };
  },
};

// The body every other part gets, which keeps following the part's 2D art.
function standardPart(kit) {
  const { part, root } = kit;
  const entry = definition(part.type);
  const body = partBody(part);
  const [height, lift] = entry.background ? [BREADBOARD_TOP, 0] : BODY[part.type] ?? DEFAULT_BODY;
  const material = kit.solid(body.color);
  root.add(body.shape === 'round'
    ? post(body.x + body.w / 2, body.y + body.h / 2, body.w / 2, lift, height, material)
    : block(body, lift, height, material));
  if (!entry.background) addLegs(kit, entry.pins, body, lift + 1);
  const lit = entry.category === 'Displays' || part.type === 'neopixel';
  const face = addFace(kit, body, body.crop, lift + height, lit);
  return (view) => face.show(partArt(part, view));
}

function makeGlowTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 64;
  const context = canvas.getContext('2d');
  const gradient = context.createRadialGradient(32, 32, 0, 32, 32, 32);
  gradient.addColorStop(0, '#fff');
  gradient.addColorStop(0.3, '#fff8');
  gradient.addColorStop(1, '#fff0');
  context.fillStyle = gradient;
  context.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(canvas);
}

// Software rendering works but is slow, and it takes CPU time from the simulation.
function hasGraphicsHardware() {
  const context = document.createElement('canvas').getContext('webgl2', { failIfMajorPerformanceCaveat: true });
  context?.getExtension('WEBGL_lose_context')?.loseContext();
  return !!context;
}

function disposeTree(object) {
  object.traverse((child) => {
    child.geometry?.dispose();
    for (const material of [child.material].flat()) {
      material?.map?.dispose();
      material?.dispose();
    }
  });
}

// Everything but the glow around lights, which would make the box far too big.
function solidBox(root) {
  const box = new THREE.Box3();
  root.updateWorldMatrix(true, true);
  root.traverse((child) => {
    if (child.isMesh) box.expandByObject(child);
  });
  return box;
}

// Throws if this computer can't show WebGL at all.
// `pressable` gives the ids of the parts that respond to a press right now. `press` and `release`
// are called as one is pressed and let go.
// `movable` says whether parts can be moved right now. `grab` is called with a part and the point
// on the table under the pointer, then `drag` as the pointer moves and `drop` when it lets go.
// `toggle` adds a part to the selection or takes it out, and `clear` empties the selection.
export function createScene3d(container, {
  pressable = () => new Set(), press = () => {}, release = () => {},
  movable = () => false, grab = () => {}, drag = () => {}, drop = () => {}, toggle = () => {}, clear = () => {},
} = {}) {
  const hardware = hasGraphicsHardware();
  const renderer = new THREE.WebGLRenderer({ antialias: hardware });
  const canvas = renderer.domElement;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, hardware ? 2 : 1));
  renderer.shadowMap.enabled = hardware;
  canvas.tabIndex = 0;
  canvas.setAttribute('role', 'img');
  canvas.setAttribute('aria-label', '3D view of the circuit. Drag a part to move it. Use the arrow keys to turn the view, and plus and minus to zoom.');
  container.prepend(canvas);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(TABLE_COLOR);
  const camera = new THREE.PerspectiveCamera(FIELD_OF_VIEW, 1, 1, 10000);
  const orbit = { target: at(0, 0, 0), turn: -0.45, tilt: 0.85, distance: 900 };

  scene.add(new THREE.HemisphereLight('#ffffff', '#3b444b', 1.5));
  const sun = new THREE.DirectionalLight('#ffffff', 2.2);
  sun.castShadow = hardware;
  sun.shadow.mapSize.set(1024, 1024);
  sun.shadow.bias = -0.0006;
  scene.add(sun, sun.target);

  const table = new THREE.Mesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ color: TABLE_COLOR, roughness: 0.95 }));
  table.receiveShadow = true;
  scene.add(table);

  const glowTexture = makeGlowTexture();
  const stats = { frames: 0, artDrawn: 0, artFailed: 0 };
  let circuit = new THREE.Group();
  let wires = new THREE.Group();
  let parts = new Map(); // id -> { root, update, view }
  let wireCount = 0;
  let savedDoc;
  let savedShape;
  let lastDoc = { parts: [], wires: [] };
  let frameRequest = 0;
  let selected = [];
  const marks = new THREE.Group(); // Boxes around the selected parts.
  scene.add(marks);

  function draw() {
    frameRequest = 0;
    const flat = Math.sin(orbit.tilt) * orbit.distance;
    camera.position.set(
      orbit.target.x + flat * Math.sin(orbit.turn),
      orbit.target.y + Math.cos(orbit.tilt) * orbit.distance,
      orbit.target.z + flat * Math.cos(orbit.turn),
    );
    camera.lookAt(orbit.target);
    renderer.render(scene, camera);
    stats.frames++;
  }

  function invalidate() {
    frameRequest ||= requestAnimationFrame(draw);
  }

  const events = {
    drawn() {
      stats.artDrawn++;
      invalidate();
    },
    failed() {
      stats.artFailed++;
    },
  };

  function build(doc) {
    scene.remove(circuit);
    disposeTree(circuit);
    circuit = new THREE.Group();
    wires = new THREE.Group(); // The old wires went with the old circuit.
    parts = new Map();
    const supports = surfaces(doc);
    const textureLimit = hardware ? 1536 : 1024;

    for (const part of doc.parts) {
      if (definition(part.type).annotation) continue; // Notes belong to the drawing, not the bench.
      const root = new THREE.Group();
      const materials = new Map();
      const solid = (color, options = {}) => {
        const key = color + JSON.stringify(options);
        if (!materials.has(key)) materials.set(key, new THREE.MeshStandardMaterial({ color, roughness: 0.6, ...options }));
        return materials.get(key);
      };
      const update = (BUILDERS[part.type] ?? standardPart)({ part, root, solid, events, glowTexture, textureLimit });
      root.userData.part = part.id;
      root.userData.surface = isSurface(definition(part.type));
      root.rotation.y = -THREE.MathUtils.degToRad(part.rotation ?? 0);
      if (part.flip) root.scale.x = -1;
      circuit.add(root);
      parts.set(part.id, { root, update, view: null });
    }

    circuit.traverse((child) => {
      if (child.isMesh) child.castShadow = child.receiveShadow = true;
    });
    scene.add(circuit);
    place(doc);
  }

  // Puts every part where the circuit says and redraws the wires. This is all a move needs, so
  // dragging a part does not rebuild the parts or redraw their art.
  function place(doc) {
    const supports = surfaces(doc);
    for (const part of doc.parts) parts.get(part.id)?.root.position.set(part.x, partBase(part, supports), part.y);

    circuit.remove(wires);
    disposeTree(wires);
    wires = new THREE.Group();
    wireCount = 0;
    doc.wires.forEach((wire, index) => {
      const route = wireRoute(doc, wire, index, supports);
      if (!route) return;
      const curve = new THREE.CatmullRomCurve3(route.map((p) => at(p.x, p.h, p.y)), false, 'centripetal');
      const mesh = new THREE.Mesh(new THREE.TubeGeometry(curve, 56, 1.1, 8), new THREE.MeshStandardMaterial({ color: wire.color, roughness: 0.5 }));
      mesh.castShadow = mesh.receiveShadow = true;
      wires.add(mesh);
      wireCount++;
    });
    circuit.add(wires);
    drawMarks();
  }

  function drawMarks() {
    disposeTree(marks);
    marks.clear();
    for (const id of selected) {
      const root = parts.get(id)?.root;
      if (root) marks.add(new THREE.Box3Helper(solidBox(root).expandByScalar(2), SELECTED));
    }
    invalidate();
  }

  function resize() {
    const { clientWidth: width, clientHeight: height } = container;
    if (!width || !height) return;
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    invalidate();
  }

  function fit() {
    const box = sceneBounds(lastDoc);
    const width = box.right - box.left;
    const depth = box.bottom - box.top;
    const reach = Math.hypot(width, depth) / 2 + 30;
    const view = THREE.MathUtils.degToRad(FIELD_OF_VIEW) / 2;
    const spread = Math.min(1, camera.aspect);
    orbit.target.set(box.left + width / 2, 10, box.top + depth / 2);
    orbit.turn = -0.45;
    orbit.tilt = 0.85;
    orbit.distance = (0.85 * reach) / Math.tan(view) / spread;
    camera.far = orbit.distance * 8 + 2000;
    camera.updateProjectionMatrix();

    table.scale.set(reach * 40, 1, reach * 40);
    table.position.set(orbit.target.x, -0.5, orbit.target.z);
    sun.target.position.copy(orbit.target);
    sun.position.copy(orbit.target).add(at(-0.6 * reach, 1.6 * reach, -0.5 * reach));
    Object.assign(sun.shadow.camera, { left: -reach * 1.2, right: reach * 1.2, top: reach * 1.2, bottom: -reach * 1.2, near: 1, far: reach * 5 });
    sun.shadow.camera.updateProjectionMatrix();
    invalidate();
  }

  // --- Looking around ---

  function turnBy(turn, tilt) {
    orbit.turn += turn;
    orbit.tilt = Math.max(0.05, Math.min(LOWEST_VIEW, orbit.tilt + tilt));
    invalidate();
  }

  function zoomBy(factor) {
    orbit.distance = Math.max(80, Math.min(camera.far / 2, orbit.distance * factor));
    invalidate();
  }

  function moveBy(dx, dy) {
    const scale = orbit.distance / container.clientHeight;
    const right = at(Math.cos(orbit.turn), 0, -Math.sin(orbit.turn));
    const forward = at(Math.sin(orbit.turn), 0, Math.cos(orbit.turn));
    orbit.target.addScaledVector(right, -dx * scale).addScaledVector(forward, -dy * scale);
    invalidate();
  }

  // --- Pressing and moving parts ---

  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  const floor = new THREE.Plane(UP.clone(), 0); // The level a held part slides along.
  const onFloor = new THREE.Vector3();

  function aim(event) {
    const box = canvas.getBoundingClientRect();
    pointer.set(((event.clientX - box.left) / box.width) * 2 - 1, 1 - ((event.clientY - box.top) / box.height) * 2);
    raycaster.setFromCamera(pointer, camera);
  }

  // Everything along the pointer's line that belongs to a part, nearest first. Wires are looked
  // through, and so is the table.
  function partHits(event) {
    aim(event);
    const found = [];
    for (const hit of raycaster.intersectObject(circuit, true)) {
      let object = hit.object;
      while (object && object.userData.part === undefined) object = object.parent;
      if (object) found.push({ id: object.userData.part, surface: object.userData.surface, point: hit.point });
    }
    return found;
  }

  // The first pressable part along the pointer's line. Wires and boards are looked through, which
  // keeps small parts easy to hit from any angle.
  function pressableAt(event) {
    const targets = pressable();
    if (targets.size === 0) return undefined;
    return partHits(event).find((hit) => targets.has(hit.id))?.id;
  }

  // The part to pick up. Parts standing on a board or breadboard win over it, even where the
  // pointer's line clips the board's edge first, and the board itself is picked anywhere else.
  function movableAt(event) {
    const found = partHits(event);
    return found.find((hit) => !hit.surface) ?? found[0];
  }

  // Where the pointer's line meets the level the held part was picked up at, in the 2D canvas's
  // units. Null when the pointer is above the horizon.
  function floorPoint(event) {
    aim(event);
    return raycaster.ray.intersectPlane(floor, onFloor) ? { x: onFloor.x, y: onFloor.z } : null;
  }

  let looking = null; // Turning or panning the view: { x, y, panning, travel, clears }
  let holding = false; // Dragging a part.
  let pressing = false;
  // The right and middle buttons pan, as on the 2D canvas.
  const pans = (event) => event.shiftKey || event.altKey || event.button === 1 || event.button === 2;
  canvas.addEventListener('contextmenu', (event) => event.preventDefault());
  canvas.addEventListener('pointerdown', (event) => {
    canvas.focus();
    canvas.setPointerCapture(event.pointerId);
    const plain = event.button === 0 && !pans(event);
    const pressed = plain ? pressableAt(event) : undefined;
    if (pressed !== undefined) {
      pressing = true;
      press(pressed);
      return;
    }
    const hit = plain && movable() ? movableAt(event) : undefined;
    if (hit && (event.ctrlKey || event.metaKey)) {
      toggle(hit.id);
      return;
    }
    if (hit) {
      floor.constant = -hit.point.y;
      holding = true;
      canvas.classList.add('holding');
      grab(hit.id, { x: hit.point.x, y: hit.point.z });
      return;
    }
    // A click on empty table lets go of the selection, but turning the view keeps it.
    looking = { x: event.clientX, y: event.clientY, panning: pans(event), travel: 0, clears: plain && movable() };
  });
  canvas.addEventListener('pointermove', (event) => {
    if (holding) {
      const point = floorPoint(event);
      if (point) drag(point);
      return;
    }
    if (!looking) {
      if (pressing) return;
      const pressed = pressableAt(event) !== undefined;
      canvas.classList.toggle('pressable', pressed);
      canvas.classList.toggle('movable', !pressed && movable() && movableAt(event) !== undefined);
      return;
    }
    const dx = event.clientX - looking.x;
    const dy = event.clientY - looking.y;
    looking.x = event.clientX;
    looking.y = event.clientY;
    looking.travel += Math.abs(dx) + Math.abs(dy);
    if (looking.panning) moveBy(dx, dy);
    else turnBy(-dx * 0.008, -dy * 0.008);
  });
  const letGo = () => {
    if (looking?.clears && looking.travel <= CLICK_SLOP) clear();
    looking = null;
    if (holding) {
      holding = false;
      canvas.classList.remove('holding');
      drop();
    }
    if (pressing) release();
    pressing = false;
  };
  canvas.addEventListener('pointerup', letGo);
  canvas.addEventListener('pointercancel', letGo);
  canvas.addEventListener('wheel', (event) => {
    event.preventDefault();
    zoomBy(Math.exp(event.deltaY * 0.0012));
  }, { passive: false });
  canvas.addEventListener('keydown', (event) => {
    const action = {
      ArrowLeft: () => turnBy(0.12, 0),
      ArrowRight: () => turnBy(-0.12, 0),
      ArrowUp: () => turnBy(0, -0.08),
      ArrowDown: () => turnBy(0, 0.08),
      '+': () => zoomBy(0.9),
      '=': () => zoomBy(0.9),
      '-': () => zoomBy(1.1),
    }[event.key];
    if (!action) return;
    action();
    event.preventDefault();
  });

  const watcher = new ResizeObserver(resize);
  watcher.observe(container);
  resize();

  function updatePart(part, view) {
    const entry = parts.get(part.id);
    const text = JSON.stringify(view) ?? '';
    if (!entry || entry.view === text) return;
    entry.view = text;
    entry.update?.(view);
    invalidate();
  }

  return {
    fit,
    updatePart,
    // Shows a circuit, rebuilding the scene only if the circuit itself changed. When only places
    // changed, as they do in a drag, the parts just move and the wires are redrawn.
    sync(doc, viewOf) {
      const text = JSON.stringify(doc);
      lastDoc = doc;
      if (text !== savedDoc) {
        savedDoc = text;
        const shape = JSON.stringify(doc.parts.map(({ x, y, ...rest }) => rest));
        if (shape === savedShape) place(doc);
        else build(doc);
        savedShape = shape;
      }
      for (const part of doc.parts) updatePart(part, viewOf(part));
      invalidate();
    },
    // Outlines the selected parts.
    showSelection(ids) {
      if (ids.join() === selected.join()) return;
      selected = [...ids];
      drawMarks();
    },
    // Where a part appears on the screen, for the automated tests.
    screenPoint(id) {
      const root = circuit.children.find((child) => child.userData.part === id);
      const center = new THREE.Box3().setFromObject(root).getCenter(new THREE.Vector3()).project(camera);
      const box = canvas.getBoundingClientRect();
      return { clientX: box.left + ((center.x + 1) / 2) * box.width, clientY: box.top + ((1 - center.y) / 2) * box.height };
    },
    info: () => ({
      ...stats,
      hardware,
      parts: parts.size,
      wires: wireCount,
      selected: marks.children.length,
      camera: { x: Math.round(orbit.target.x), z: Math.round(orbit.target.z), turn: orbit.turn, tilt: orbit.tilt },
      textures: renderer.info.memory.textures,
      geometries: renderer.info.memory.geometries,
      triangles: renderer.info.render.triangles,
      drawCalls: renderer.info.render.calls,
    }),
    dispose() {
      cancelAnimationFrame(frameRequest);
      watcher.disconnect();
      disposeTree(scene);
      glowTexture.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
      canvas.remove();
    },
  };
}

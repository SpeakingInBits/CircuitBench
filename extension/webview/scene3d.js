// The 3D view of a circuit. Parts can be picked and dragged here, but main.js does the moving,
// sharing the 2D canvas's drag, so snapping, undo and saving work the same in both. main.js imports
// this file the first time a student opens the view, so three.js costs nothing until then. It
// draws only when something changes, and dispose() gives the memory back.
//
// The parts' shapes are in models3d.js. A part with no model there still appears, as a plain body
// on legs with its 2D art on top, so a new part shows up here before anyone has modelled it.
import * as THREE from './vendor/three/three.module.js';
import { definition } from '../shared/catalog.js';
import { holePattern, partArt } from './art.js';
import { isSurface, partBase, partBody, sceneBounds, surfaces, wireRoute } from './layout3d.js';
import { BUILDERS, addLegs, at, block, post } from './models3d.js';

const TABLE_COLOR = '#56636d'; // Matches the 2D canvas.
const SELECTED = '#3399ff'; // The 2D canvas's selection outline.
const CLICK_SLOP = 4; // Pixels the pointer can move before a click becomes a drag.
const FIELD_OF_VIEW = 32;
const LOWEST_VIEW = 1.45; // Radians from straight down, which keeps the camera above the table.
const UP = new THREE.Vector3(0, 1, 0);
// For a part with no model: how tall its body is, and how far it stands off its surface.
const PLAIN_BODY = [5, 7];

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

// What stands in for a part with no model: a body the shape of the largest thing in its 2D art,
// on its legs, with the art on top.
function plainPart(kit) {
  const { part, root } = kit;
  const body = partBody(part);
  const [height, lift] = PLAIN_BODY;
  const material = kit.solid(body.color);
  root.add(body.shape === 'round'
    ? post(body.x + body.w / 2, body.y + body.h / 2, body.w / 2, lift, height, material)
    : block(body, lift, height, material));
  addLegs(kit, definition(part.type).pins, body, lift + 1);
  const face = new ArtFace(body.crop, body.color, kit.textureLimit, kit.events);
  const geometry = body.shape === 'round' ? new THREE.CircleGeometry(body.w / 2, 40) : new THREE.PlaneGeometry(body.w, body.h);
  geometry.rotateX(-Math.PI / 2);
  const top = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ map: face.texture, roughness: 0.75 }));
  top.position.set(body.x + body.w / 2, lift + height + 0.05, body.y + body.h / 2);
  top.userData.print = true;
  root.add(top);
  return (view) => face.show(partArt(part, view));
}

const makeCanvas = (width, height) => Object.assign(document.createElement('canvas'), { width, height });

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
    if (child.isInstancedMesh) child.dispose();
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
  // `artDrawn` counts everything printed or drawn on a part, and `updates` each change a part showed.
  const stats = { frames: 0, artDrawn: 0, artFailed: 0, updates: 0 };
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
      const update = (BUILDERS[part.type] ?? plainPart)({ part, root, solid, events, glowTexture, textureLimit, canvas: makeCanvas });
      root.userData.part = part.id;
      root.userData.surface = isSurface(definition(part.type));
      root.rotation.y = -THREE.MathUtils.degToRad(part.rotation ?? 0);
      if (part.flip) root.scale.x = -1;
      circuit.add(root);
      parts.set(part.id, { root, update, view: null });
    }

    circuit.traverse((child) => {
      if (!child.isMesh) return;
      // Print lies flat on what it is printed on, so it has no shadow of its own.
      child.castShadow = !child.userData.print;
      child.receiveShadow = true;
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
    stats.updates++;
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

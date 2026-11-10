// The circuit builder: place parts, draw wires, and show the running simulation.
import { BOARD_TYPE, CATALOG, CATEGORIES, defaultProps, definition, emptyCircuit, partBounds, pinPosition, readoutText } from '../shared/catalog.js';
import { buildNets, pinKey, unsimulated } from '../shared/nets.js';
import { pinProblems } from '../shared/pin-check.js';
import { frameLinks } from '../shared/traceback.js';
import { escapeXml, holePattern, partArt, partLabel, partTransform, smoke, warningMark } from './art.js';
import { createDiagram } from './diagram.js';
import { alignParts, copyParts, flipParts, internalWires, moveParts, parseValue, pasteClip, rotateParts, wirePath, wirePoints } from './editing.js';
import { exportFile } from './export.js';
import { SerialFilter, typeInto } from './serial-text.js';

const vscode = acquireVsCodeApi();
const GRID = 10;
const PIN_HIT = 6;
const BEND_HIT = 6;
const PASTE_OFFSET = 20;
const PRESS_KINDS = ['momentary', 'toggle', 'cycle'];
const NS = 'http://www.w3.org/2000/svg';
const WIRE_COLORS = ['#2e9e4f', '#2f7bff', '#ff9f0a', '#b45cff', '#e0c400', '#19b5c9', '#d33', '#222', '#eee'];
const POWER_PIN = /^(3V|5V|VIN|VCC|V\+|\+|\+5V|VDD|VS|5V)$/;
const GROUND_PIN = /^(GND\d?|VSS|-)$/;

const $ = (id) => document.getElementById(id);
const canvas = $('canvas');
const world = $('world');
const diagram = createDiagram($('stage-diagram'));

const state = {
  doc: emptyCircuit(),
  selection: [], // [{ kind: 'part' | 'wire', id }]
  running: false,
  views: {},
  board: {},
  problems: [],
  program: null, // The program's text and file name, to check against the circuit: { text, file }
  codeProblems: [], // Board pins the program uses that nothing is wired to. Shown running or not.
  undo: [],
  redo: [],
  zoom: 1.6,
  pan: { x: 20, y: 20 },
  wiring: null, // { from, points, color }
  drag: null,
  bend: null, // The wire bend being dragged: { wire, index, moved, before }
  marquee: null, // The box being dragged out: { from, to }
  clipboard: null,
  pastes: 0, // Each paste of the same copy lands further along.
  idle: null, // While running, what the simulation cannot reach.
  valueError: null,
  panning: null,
  held: new Set(),
  colorIndex: 0,
  controlValues: {},
  loadError: undefined, // Why circuit.json could not be used. Nothing can be edited until it is fixed.
  scene3d: null, // The 3D view, while it is open.
  diagram: null, // The circuit diagram, while it is open.
  libraryHint: undefined, // A library the program could not import, which can be added.
};

const partById = (id) => state.doc.parts.find((part) => part.id === id);
const viewOf = (part) => (part.type === BOARD_TYPE ? { board: state.board } : state.views[part.id]);
const locked = () => state.running || !!state.loadError;
const snap = (value) => Math.round(value / GRID) * GRID;

const isSelected = (kind, id) => state.selection.some((item) => item.kind === kind && item.id === id);
const selectedParts = () => state.selection.filter((item) => item.kind === 'part').map((item) => partById(item.id)).filter(Boolean);
const selectedWire = () => (state.selection.length === 1 && state.selection[0].kind === 'wire'
  ? state.doc.wires.find((wire) => wire.id === state.selection[0].id) : undefined);

function nextId(prefix) {
  const taken = new Set([...state.doc.parts.map((p) => p.id), ...state.doc.wires.map((w) => w.id)]);
  let n = 1;
  while (taken.has(`${prefix}${n}`)) n++;
  return `${prefix}${n}`;
}

// --- History and saving ---

function snapshot() {
  state.undo.push(JSON.stringify(state.doc));
  if (state.undo.length > 100) state.undo.shift();
  state.redo = [];
  updateToolbar();
}

function changed() {
  vscode.postMessage({ type: 'save', circuit: state.doc });
  render();
}

function restore(from, to) {
  if (from.length === 0 || locked()) return;
  to.push(JSON.stringify(state.doc));
  state.doc = JSON.parse(from.pop());
  state.selection = [];
  changed();
}

// --- Coordinates ---

function toWorld(event) {
  const box = canvas.getBoundingClientRect();
  return {
    x: (event.clientX - box.left - state.pan.x) / state.zoom,
    y: (event.clientY - box.top - state.pan.y) / state.zoom,
  };
}

function applyTransform() {
  world.setAttribute('transform', `translate(${state.pan.x} ${state.pan.y}) scale(${state.zoom})`);
}

function fit() {
  const boxes = state.doc.parts.map(partBounds);
  const left = Math.min(...boxes.map((b) => b.x));
  const top = Math.min(...boxes.map((b) => b.y));
  const right = Math.max(...boxes.map((b) => b.x + b.w));
  const bottom = Math.max(...boxes.map((b) => b.y + b.h));
  const box = canvas.getBoundingClientRect();
  state.zoom = Math.max(0.3, Math.min(3, Math.min((box.width - 40) / (right - left), (box.height - 40) / (bottom - top))));
  state.pan = {
    x: (box.width - (right - left) * state.zoom) / 2 - left * state.zoom,
    y: (box.height - (bottom - top) * state.zoom) / 2 - top * state.zoom,
  };
  applyTransform();
}

// Finds the pin under a point. Parts win over the breadboard holes they sit in.
function pinAt(point) {
  let best = null;
  for (const part of state.doc.parts) {
    const entry = definition(part.type);
    for (const pinDef of entry.pins) {
      const position = pinPosition(part, pinDef);
      const distance = Math.hypot(position.x - point.x, position.y - point.y);
      if (distance > PIN_HIT) continue;
      const score = distance + (entry.background ? PIN_HIT : 0);
      if (!best || score < best.score) best = { score, part, pin: pinDef, position };
    }
  }
  return best;
}

function pinEnd(end) {
  const part = partById(end.part);
  const pinDef = part && definition(part.type).pins.find((p) => p.id === end.pin);
  return pinDef ? pinPosition(part, pinDef) : null;
}

// --- Rendering ---

function partGroup(part) {
  const entry = definition(part.type);
  const interactive = (entry.controls ?? []).some((control) => PRESS_KINDS.includes(control.kind));
  const view = viewOf(part);
  const classes = `part${interactive ? ' interactive' : ''}${state.idle?.parts.has(part.id) ? ' idle' : ''}`;
  return `<g class="${classes}" data-part="${part.id}" transform="${partTransform(part)}">${partArt(part, view)}</g>`;
}

function renderWires() {
  let html = '';
  for (const wire of state.doc.wires) {
    const d = wirePath(state.doc, wire);
    if (!d) continue;
    const classes = `wire${isSelected('wire', wire.id) ? ' selected' : ''}${state.idle?.wires.has(wire) ? ' idle' : ''}`;
    html += `<path class="${classes}" d="${d}" stroke="${escapeXml(wire.color)}"/><path class="wire-hit" data-wire="${escapeXml(wire.id)}" d="${d}"/>`;
  }
  $('layer-wires').innerHTML = html;
}

// Handles on a selected wire: one on each bend, and a smaller one on each stretch to add a bend.
function bendHandles(wire) {
  const points = wirePoints(state.doc, wire);
  if (!points) return '';
  let html = '';
  for (let i = 0; i + 1 < points.length; i++) {
    const [a, b] = [points[i], points[i + 1]];
    html += `<circle class="bend-add" data-bend-add="${i}" cx="${(a.x + b.x) / 2}" cy="${(a.y + b.y) / 2}" r="2.2"/>`;
  }
  (wire.points ?? []).forEach((p, i) => { html += `<circle class="bend" data-bend="${i}" cx="${p.x}" cy="${p.y}" r="3.2"/>`; });
  return html;
}

function renderOverlay(pointer) {
  let html = '';
  for (const part of selectedParts()) {
    const box = partBounds(part);
    html += `<rect class="selected-outline" x="${box.x}" y="${box.y}" width="${box.w}" height="${box.h}"/>`;
  }
  const wire = selectedWire();
  if (wire && !locked()) html += bendHandles(wire);
  if (state.marquee) {
    const box = marqueeBox();
    html += `<rect class="marquee" x="${box.left}" y="${box.top}" width="${box.right - box.left}" height="${box.bottom - box.top}"/>`;
  }
  if (state.wiring) {
    const start = pinEnd(state.wiring.from);
    const points = [start, ...state.wiring.points, pointer ?? state.wiring.pointer ?? start];
    const d = points.map((p, i) => `${i ? 'L' : 'M'}${p.x} ${p.y}`).join(' ');
    html += `<path class="wire preview" d="${d}" stroke="${state.wiring.color}"/>`;
  }
  if (state.hoverPin) {
    const { x, y } = state.hoverPin.position;
    html += `<circle class="pin-mark" cx="${x}" cy="${y}" r="2.6"/>`;
    for (const mark of state.hoverNet ?? []) html += `<circle class="net-mark" cx="${mark.x}" cy="${mark.y}" r="3.2"/>`;
  }
  // The pointer moves far more often than the overlay changes.
  if (html !== state.overlayHtml) {
    state.overlayHtml = html;
    $('layer-overlay').innerHTML = html;
  }
  state.scene3d?.showSelection(selectedParts().map((part) => part.id));
}

function renderLabels() {
  $('layer-labels').innerHTML = state.doc.parts.map(partLabel).join('');
}

// Where a problem shows on the canvas: at its pin if it has one, or else in the middle of the part.
function problemSpot({ part: id, pin }) {
  const part = partById(id);
  if (!part) return null;
  const pinDef = pin && definition(part.type).pins.find((p) => p.id === pin);
  if (pinDef) return { ...pinPosition(part, pinDef), size: 1 };
  const box = partBounds(part);
  return { x: box.x + box.w / 2, y: box.y + box.h / 2, size: Math.min(2, Math.max(1, box.w / 60)) };
}

// Smoke over anything being damaged, and a warning sign on anything that is only wrong. Marks are
// redrawn only when they change, so the smoke keeps drifting between frames.
function renderStatus() {
  const marks = new Map();
  for (const problem of [...(state.running ? state.problems : []), ...state.codeProblems]) {
    const spot = problemSpot(problem);
    const key = `${problem.part}:${problem.pin ?? ''}`;
    if (spot && marks.get(key)?.severity !== 'error') marks.set(key, { ...spot, severity: problem.severity });
  }
  const text = JSON.stringify([...marks]);
  if (text === state.statusText) return;
  state.statusText = text;
  $('layer-status').innerHTML = [...marks.values()].map((mark) => (
    mark.severity === 'error' ? smoke(mark.x, mark.y, mark.size) : warningMark(mark.x, mark.y))).join('');
}

function render() {
  state.idle = state.running ? unsimulated(state.doc) : null;
  checkProgram();
  const background = [];
  const front = [];
  for (const part of state.doc.parts) (definition(part.type).background ? background : front).push(partGroup(part));
  $('layer-background').innerHTML = background.join('');
  $('layer-parts').innerHTML = front.join('');
  renderWires();
  renderLabels();
  renderStatus();
  renderOverlay();
  renderInspector();
  updateToolbar();
  state.scene3d?.sync(state.doc, viewOf);
  state.diagram?.sync(state.doc, state.loadError);
}

function updatePart(id) {
  const part = partById(id);
  const element = canvas.querySelector(`[data-part="${id}"]`);
  if (!part || !element) return;
  const view = viewOf(part);
  element.innerHTML = partArt(part, view);
  state.scene3d?.updatePart(part, view);
}

// --- 3D view ---

// three.js loads the first time this is opened, and closing the view frees its memory.
async function toggle3d() {
  const button = $('view3d');
  const stage = $('stage3d');
  if (state.scene3d) {
    state.scene3d.dispose();
    state.scene3d = null;
    stage.hidden = true;
    button.textContent = '3D view';
    return;
  }
  closeDiagram();
  button.disabled = true;
  $('diagram').disabled = true;
  stage.hidden = false;
  try {
    const { createScene3d } = await import('./scene3d.js');
    state.scene3d = createScene3d(stage, {
      pressable: pressableParts,
      press: (id) => pressPart(partById(id)),
      release: releaseHeld,
      movable: () => !locked(),
      grab: grabPart,
      drag: (point) => state.drag && dragTo(point),
      drop: endPointer,
      toggle: (id) => toggleSelected({ kind: 'part', id }),
      clear: () => {
        state.selection = [];
        refreshSelection();
      },
    });
    state.scene3d.sync(state.doc, viewOf);
    state.scene3d.showSelection(selectedParts().map((part) => part.id));
    state.scene3d.fit();
    button.textContent = '2D view';
    button.disabled = false;
  } catch (error) {
    // The 2D view does everything, so a computer without WebGL just keeps using it.
    console.error(error);
    stage.hidden = true;
    button.title = '3D view is not available on this computer.';
  }
  $('diagram').disabled = false;
}

// --- Circuit diagram ---

function openDiagram() {
  if ($('diagram').disabled) return; // The 3D view is still loading.
  if (state.scene3d) toggle3d();
  state.diagram = diagram;
  $('stage-diagram').hidden = false;
  $('diagram').textContent = '2D view';
  diagram.sync(state.doc, state.loadError);
  diagram.fit();
}

function closeDiagram() {
  state.diagram = null;
  $('stage-diagram').hidden = true;
  $('diagram').textContent = 'Diagram';
}

function updateToolbar() {
  $('undo').disabled = locked() || state.undo.length === 0;
  $('redo').disabled = locked() || state.redo.length === 0;
  const parts = selectedParts();
  const turnable = !locked() && parts.length > 0 && !parts.some((part) => definition(part.type).fixed);
  $('rotate').disabled = !turnable;
  $('flip').disabled = !turnable;
  const removable = state.selection.some((item) => item.kind === 'wire') || parts.some((part) => !definition(part.type).fixed);
  $('delete').disabled = locked() || !removable;
  $('run').textContent = state.running ? 'Restart' : 'Run';
  $('run').disabled = !!state.loadError;
  $('stop').disabled = !state.running;
  document.body.classList.toggle('running', state.running);
}

// --- Palette ---

function renderPalette(filter = '') {
  const query = filter.trim().toLowerCase();
  let html = '';
  for (const category of CATEGORIES) {
    const items = Object.entries(CATALOG).filter(([, entry]) => entry.category === category && !entry.fixed
      && (entry.name.toLowerCase().includes(query) || category.toLowerCase().includes(query)));
    if (items.length === 0) continue;
    html += `<div class="category">${category}</div>`;
    for (const [type, entry] of items) {
      html += `<button class="part-button" data-add="${type}" title="${entry.description ?? entry.name}">${entry.name}</button>`;
    }
  }
  $('parts').innerHTML = html || '<p class="empty">No parts match.</p>';
}

function addPart(type) {
  if (locked()) return;
  const box = canvas.getBoundingClientRect();
  const entry = definition(type);
  const count = state.doc.parts.length;
  snapshot();
  const part = {
    id: nextId(type.replace(/[^a-z]/g, '')),
    type,
    x: snap((box.width / 2 - state.pan.x) / state.zoom - entry.w / 2 + (count % 5) * 20),
    y: snap((box.height / 2 - state.pan.y) / state.zoom - entry.h / 2 + (count % 5) * 20),
    rotation: 0,
    props: defaultProps(type),
  };
  state.doc.parts.push(part);
  state.selection = [{ kind: 'part', id: part.id }];
  changed();
}

// --- Editing ---

function deleteSelection() {
  if (locked()) return;
  const parts = new Set(selectedParts().filter((part) => !definition(part.type).fixed).map((part) => part.id));
  const wires = new Set(state.selection.filter((item) => item.kind === 'wire').map((item) => item.id));
  if (parts.size === 0 && wires.size === 0) return;
  snapshot();
  state.doc.parts = state.doc.parts.filter((part) => !parts.has(part.id));
  state.doc.wires = state.doc.wires.filter((wire) => !wires.has(wire.id) && !parts.has(wire.from.part) && !parts.has(wire.to.part));
  state.selection = [];
  changed();
}

// Applies a turn or flip, which the board cannot take part in.
function transformSelection(change) {
  const parts = selectedParts();
  if (parts.length === 0 || locked() || parts.some((part) => definition(part.type).fixed)) return;
  snapshot();
  change(state.doc, parts);
  changed();
}

const rotateSelection = () => transformSelection(rotateParts);
const flipSelection = () => transformSelection(flipParts);

function nudgeSelection(dx, dy) {
  const parts = selectedParts();
  if (parts.length === 0 || locked()) return;
  snapshot();
  moveParts(state.doc, parts, dx, dy);
  changed();
}

function selectAll() {
  if (locked()) return;
  state.selection = [
    ...state.doc.parts.map((part) => ({ kind: 'part', id: part.id })),
    ...state.doc.wires.map((wire) => ({ kind: 'wire', id: wire.id })),
  ];
  refreshSelection();
}

function copySelection() {
  const clip = copyParts(state.doc, selectedParts());
  if (!clip) return false;
  state.clipboard = clip;
  state.pastes = 0;
  return true;
}

function paste(clip, offset) {
  if (!clip || locked()) return;
  snapshot();
  state.selection = pasteClip(state.doc, clip, offset, nextId);
  changed();
}

function pasteClipboard() {
  state.pastes++;
  paste(state.clipboard, PASTE_OFFSET * state.pastes);
}

function duplicateSelection() {
  paste(copyParts(state.doc, selectedParts()), PASTE_OFFSET);
}

function wireColor(pinDef) {
  if (pinDef.wire) return pinDef.wire;
  if (GROUND_PIN.test(pinDef.id)) return '#222';
  if (POWER_PIN.test(pinDef.id)) return '#d33';
  const color = WIRE_COLORS[state.colorIndex % 6];
  state.colorIndex++;
  return color;
}

function finishWire(target) {
  const { from, points, color } = state.wiring;
  if (from.part === target.part.id && from.pin === target.pin.id) {
    state.wiring = null;
    renderOverlay();
    return;
  }
  snapshot();
  const wire = { id: nextId('wire'), from, to: { part: target.part.id, pin: target.pin.id }, points, color };
  state.doc.wires.push(wire);
  state.wiring = null;
  state.selection = [{ kind: 'wire', id: wire.id }];
  changed();
}

function showTooltip(text, event) {
  const tooltip = $('tooltip');
  tooltip.hidden = !text;
  if (!text) return;
  tooltip.textContent = text;
  const box = canvas.getBoundingClientRect();
  tooltip.style.left = `${event.clientX - box.left + 12}px`;
  tooltip.style.top = `${event.clientY - box.top + 12}px`;
}

function setHover(hit, event) {
  const key = hit ? pinKey(hit.part.id, hit.pin.id) : null;
  if (key !== state.hoverKey) {
    state.hoverKey = key;
    state.hoverPin = hit;
    state.hoverNet = hit ? connectedPins(key) : null;
  }
  showTooltip(hit ? `${definition(hit.part.type).name}: ${hit.pin.label}` : null, event);
}

// What a student needs to know about a part while the program runs.
function runningNote(id) {
  const problems = state.problems.filter((problem) => problem.part === id).map((problem) => problem.message);
  if (problems.length > 0) return problems.join(' ');
  return state.idle?.parts.has(id) ? 'Not connected to the board or a battery, so it is not being simulated.' : null;
}

// Marks everything joined to a pin, which makes breadboard rows easy to understand.
function connectedPins(key) {
  const nets = buildNets(state.doc);
  const root = nets.find(key);
  const marks = [];
  for (const part of state.doc.parts) {
    for (const pinDef of definition(part.type).pins) {
      if (nets.find(pinKey(part.id, pinDef.id)) === root) marks.push(pinPosition(part, pinDef));
    }
  }
  return marks.length > 1 ? marks : [];
}

// --- Pointer handling ---

function controlOf(part, kinds) {
  return (definition(part.type).controls ?? []).find((control) => kinds.includes(control.kind));
}

function sendControl(partId, control, value) {
  state.controlValues[`${partId}:${control}`] = value;
  vscode.postMessage({ type: 'control', part: partId, control, value });
}

// The parts that respond to a press right now, in 2D or 3D.
function pressableParts() {
  return new Set(state.running ? state.doc.parts.filter((part) => controlOf(part, PRESS_KINDS)).map((part) => part.id) : []);
}

// What pressing a part does while the program runs.
function pressPart(part) {
  state.selection = [{ kind: 'part', id: part.id }];
  const hold = controlOf(part, ['momentary']);
  const toggle = controlOf(part, ['toggle']);
  const cycle = controlOf(part, ['cycle']);
  if (hold) {
    sendControl(part.id, hold.id, 1);
    state.held.add(`${part.id}:${hold.id}`);
  } else if (toggle) {
    const key = `${part.id}:${toggle.id}`;
    sendControl(part.id, toggle.id, state.controlValues[key] ? 0 : 1);
    renderControls();
  } else if (cycle) {
    const value = state.controlValues[`${part.id}:${cycle.id}`] ?? cycle.default ?? 0;
    sendControl(part.id, cycle.id, (value + 1) % cycle.options.length);
    renderControls();
  }
  renderOverlay();
}

function releaseHeld() {
  for (const key of state.held) {
    const [part, control] = key.split(':');
    sendControl(part, control, 0);
  }
  state.held.clear();
}

function refreshSelection() {
  renderWires();
  renderOverlay();
  renderInspector();
  updateToolbar();
}

function toggleSelected(item) {
  state.selection = isSelected(item.kind, item.id)
    ? state.selection.filter((other) => other.kind !== item.kind || other.id !== item.id)
    : [...state.selection, item];
  refreshSelection();
}

// Starts dragging a bend, or adds one partway along the wire and drags that.
function grabBend(event, point) {
  const wire = selectedWire();
  const { bend, bendAdd } = event.target.dataset ?? {};
  if (!wire || (bend === undefined && bendAdd === undefined)) return false;
  const before = JSON.stringify(state.doc);
  wire.points ??= [];
  const index = Number(bend ?? bendAdd);
  if (bendAdd !== undefined) wire.points.splice(index, 0, { x: snap(point.x), y: snap(point.y) });
  state.bend = { wire, index, moved: bendAdd !== undefined, before };
  renderWires();
  renderOverlay();
  return true;
}

function startDrag(grabbed, point, collapse) {
  const parts = selectedParts();
  state.drag = {
    grabbed,
    dx: point.x - grabbed.x,
    dy: point.y - grabbed.y,
    from: parts.map((part) => ({ part, x: part.x, y: part.y })),
    wires: internalWires(state.doc, parts).map((wire) => ({ wire, points: (wire.points ?? []).map((p) => ({ ...p })) })),
    moved: false,
    before: JSON.stringify(state.doc),
    collapse, // Pressing one of several selected parts picks it alone, unless that press drags them.
  };
}

// Selects a part and starts dragging it, in 2D or 3D. A part that is already one of several
// selected drags the whole selection.
function grabPart(id, point) {
  const part = partById(id);
  const grouped = isSelected('part', id) && state.selection.length > 1;
  if (!grouped) state.selection = [{ kind: 'part', id }];
  refreshSelection();
  startDrag(part, point, grouped);
}

canvas.addEventListener('pointerdown', (event) => {
  canvas.focus();
  canvas.setPointerCapture(event.pointerId);
  const point = toWorld(event);
  const partElement = event.target.closest?.('[data-part]');
  const wireElement = event.target.closest?.('[data-wire]');
  const startPan = () => { state.panning = { x: event.clientX - state.pan.x, y: event.clientY - state.pan.y }; };

  // The right and middle buttons only move the view, so they never pick, wire or press what is under them.
  if (event.button !== 0 || event.altKey) {
    startPan();
    return;
  }

  if (state.running) {
    if (partElement) {
      pressPart(partById(partElement.dataset.part));
    } else {
      startPan();
    }
    return;
  }

  if (state.loadError) {
    startPan();
    return;
  }

  const hit = pinAt(point);
  if (state.wiring) {
    if (hit) {
      finishWire(hit);
    } else {
      state.wiring.points.push({ x: snap(point.x), y: snap(point.y) });
      renderOverlay(point);
    }
    return;
  }
  if (grabBend(event, point)) return;

  const item = wireElement ? { kind: 'wire', id: wireElement.dataset.wire }
    : partElement ? { kind: 'part', id: partElement.dataset.part } : null;
  const onBackground = item?.kind === 'part' && definition(partById(item.id).type).background;
  if (event.shiftKey || event.ctrlKey || event.metaKey) {
    // Shift-dragging across a breadboard draws a box, so only Ctrl picks the breadboard itself.
    if (item && !(event.shiftKey && onBackground)) toggleSelected(item);
    else if (event.shiftKey) state.marquee = { from: point, to: point };
    return;
  }

  // A click on a part's body should grab the part, even over the breadboard hole beneath it.
  const overPart = partElement && !definition(partById(partElement.dataset.part).type).background;
  if (hit && !(overPart && definition(hit.part.type).background)) {
    state.wiring = { from: { part: hit.part.id, pin: hit.pin.id }, points: [], color: wireColor(hit.pin) };
    state.selection = [];
    refreshSelection();
    renderOverlay(point);
    return;
  }
  if (wireElement) {
    state.selection = [item];
    refreshSelection();
    return;
  }
  if (partElement) {
    grabPart(partElement.dataset.part, point);
    return;
  }
  state.selection = [];
  refreshSelection();
  startPan();
});

function dragTo(point) {
  const { grabbed, dx, dy, from, wires } = state.drag;
  const anchor = from.find((item) => item.part === grabbed);
  const moveX = snap(point.x - dx) - anchor.x;
  const moveY = snap(point.y - dy) - anchor.y;
  if (grabbed.x === anchor.x + moveX && grabbed.y === anchor.y + moveY) return;
  for (const { part, x, y } of from) {
    part.x = x + moveX;
    part.y = y + moveY;
    canvas.querySelector(`[data-part="${part.id}"]`)?.setAttribute('transform', partTransform(part));
  }
  for (const { wire, points } of wires) wire.points = points.map((p) => ({ x: p.x + moveX, y: p.y + moveY }));
  state.drag.moved = true;
  renderWires();
  renderLabels();
  renderOverlay();
  state.scene3d?.sync(state.doc, viewOf);
}

canvas.addEventListener('pointermove', (event) => {
  const point = toWorld(event);
  if (state.panning) {
    state.pan = { x: event.clientX - state.panning.x, y: event.clientY - state.panning.y };
    applyTransform();
    return;
  }
  if (state.bend) {
    const { wire, index } = state.bend;
    wire.points[index] = { x: snap(point.x), y: snap(point.y) };
    state.bend.moved = true;
    renderWires();
    renderOverlay();
    return;
  }
  if (state.marquee) {
    state.marquee.to = point;
    renderOverlay();
    return;
  }
  if (state.drag) {
    dragTo(point);
    return;
  }
  if (state.running) {
    setHover(null, event);
    showTooltip(runningNote(event.target.closest?.('[data-part]')?.dataset.part), event);
    return;
  }
  setHover(pinAt(point), event);
  if (state.wiring) state.wiring.pointer = point;
  renderOverlay(point);
});

function marqueeBox() {
  const { from, to } = state.marquee;
  return { left: Math.min(from.x, to.x), right: Math.max(from.x, to.x), top: Math.min(from.y, to.y), bottom: Math.max(from.y, to.y) };
}

// Picks whatever lies wholly inside the box.
function finishMarquee() {
  const { left, right, top, bottom } = marqueeBox();
  const inside = (p) => p.x >= left && p.x <= right && p.y >= top && p.y <= bottom;
  const covered = (box) => inside(box) && inside({ x: box.x + box.w, y: box.y + box.h });
  state.marquee = null;
  state.selection = [
    ...state.doc.parts.filter((part) => covered(partBounds(part))).map((part) => ({ kind: 'part', id: part.id })),
    ...state.doc.wires.filter((wire) => wirePoints(state.doc, wire)?.every(inside)).map((wire) => ({ kind: 'wire', id: wire.id })),
  ];
  refreshSelection();
}

function commitDrag(before) {
  state.undo.push(before);
  state.redo = [];
  vscode.postMessage({ type: 'save', circuit: state.doc });
  render();
}

function endPointer() {
  if (state.bend?.moved) commitDrag(state.bend.before);
  state.bend = null;
  if (state.marquee) finishMarquee();
  if (state.drag?.moved) {
    commitDrag(state.drag.before);
  } else if (state.drag?.collapse) {
    state.selection = [{ kind: 'part', id: state.drag.grabbed.id }];
    refreshSelection();
  }
  state.drag = null;
  state.panning = null;
  releaseHeld();
}

// Double-clicking a bend straightens the wire there.
canvas.addEventListener('dblclick', (event) => {
  const wire = selectedWire();
  if (!wire || locked()) return;
  const point = toWorld(event);
  const index = (wire.points ?? []).findIndex((p) => Math.hypot(p.x - point.x, p.y - point.y) <= BEND_HIT);
  if (index < 0) return;
  snapshot();
  wire.points.splice(index, 1);
  changed();
});

canvas.addEventListener('pointerleave', () => showTooltip(null));
canvas.addEventListener('pointerup', endPointer);
// Right-dragging pans, so the menu must not open when the button comes up.
canvas.addEventListener('contextmenu', (event) => event.preventDefault());
canvas.addEventListener('pointercancel', endPointer);

canvas.addEventListener('wheel', (event) => {
  event.preventDefault();
  const box = canvas.getBoundingClientRect();
  const x = event.clientX - box.left;
  const y = event.clientY - box.top;
  const factor = Math.exp(-event.deltaY * 0.0015);
  const zoom = Math.max(0.25, Math.min(5, state.zoom * factor));
  state.pan.x = x - ((x - state.pan.x) / state.zoom) * zoom;
  state.pan.y = y - ((y - state.pan.y) / state.zoom) * zoom;
  state.zoom = zoom;
  applyTransform();
}, { passive: false });

window.addEventListener('keydown', (event) => {
  const typing = ['INPUT', 'SELECT', 'TEXTAREA'].includes(event.target.tagName) || event.target.id === 'console';
  // The 3D view keeps the arrow keys for turning itself.
  if (typing || event.defaultPrevented) return;
  const mod = event.ctrlKey || event.metaKey;
  const key = event.key.toLowerCase();
  const nudge = { arrowleft: [-GRID, 0], arrowright: [GRID, 0], arrowup: [0, -GRID], arrowdown: [0, GRID] }[key];
  if (event.key === 'Escape') {
    if (state.wiring) state.wiring = null;
    else state.selection = [];
    refreshSelection();
  } else if (event.key === 'Delete' || event.key === 'Backspace') {
    deleteSelection();
  } else if (key === 'r' && !mod) {
    rotateSelection();
  } else if (key === 'f' && !mod) {
    flipSelection();
  } else if (nudge && !mod) {
    nudgeSelection(...nudge);
  } else if (mod && key === 'z' && !event.shiftKey) {
    restore(state.undo, state.redo);
  } else if (mod && (key === 'y' || key === 'z')) {
    restore(state.redo, state.undo);
  } else if (mod && key === 'a') {
    selectAll();
  } else if (mod && key === 'c') {
    // Text picked out of the Problems tab copies as usual.
    if (window.getSelection()?.toString() || !copySelection()) return;
  } else if (mod && key === 'x') {
    if (locked() || !copySelection()) return;
    deleteSelection();
  } else if (mod && key === 'v') {
    pasteClipboard();
  } else if (mod && key === 'd') {
    duplicateSelection();
  } else {
    return;
  }
  event.preventDefault();
});

// --- Inspector ---

function field(label, control) {
  return `<label class="field"><span>${label}</span>${control}</label>`;
}

function formatChoice(value, unit) {
  if (unit === 'ohm') return value >= 1e6 ? `${value / 1e6}M ohm` : value >= 1000 ? `${value / 1000}k ohm` : `${value} ohm`;
  return unit ? `${value} ${unit}` : `${value}`;
}

function propField(part, key, spec) {
  const disabled = state.running ? 'disabled' : '';
  const value = part.props?.[key];
  if (spec.type === 'text') {
    return field(spec.label, `<textarea data-prop="${key}" rows="3" ${disabled}>${escapeXml(value ?? '')}</textarea>`);
  }
  const options = spec.choices.map((choice) => formatChoice(choice, spec.unit));
  if (spec.custom) {
    const list = `choices-${key}`;
    return field(spec.label, `<input data-prop="${key}" list="${list}" value="${escapeXml(formatChoice(value, spec.unit))}" ${disabled}>`
      + `<datalist id="${list}">${options.map((option) => `<option value="${option}"></option>`).join('')}</datalist>`);
  }
  const items = spec.choices.map((choice, i) => `<option value="${choice}" ${String(value) === String(choice) ? 'selected' : ''}>${options[i]}</option>`).join('');
  return field(spec.label, `<select data-prop="${key}" ${disabled}>${items}</select>`);
}

const ALIGN_BUTTONS = [['left', 'Left'], ['center', 'Center'], ['right', 'Right'], ['top', 'Top'], ['middle', 'Middle'], ['bottom', 'Bottom']];

function selectionSummary() {
  const parts = selectedParts();
  const align = parts.length > 1 && !locked()
    ? `<div class="align" role="group" aria-label="Align parts">${ALIGN_BUTTONS.map(([edge, label]) => `<button data-align="${edge}">${label}</button>`).join('')}</div>` : '';
  return `<h2>${state.selection.length} items selected</h2><p>Drag any of them to move them all. Copy, delete, rotate and flip work on the whole selection.</p>${align}`;
}

function renderInspector() {
  const [selection] = state.selection;
  let html = '';
  if (state.loadError) {
    html += `<h2>circuit.json needs fixing</h2><p>${state.loadError.replace(/</g, '&lt;')}</p><p>Your file has not been changed. Fix it and save it, and the circuit will load.</p>`;
  } else if (state.selection.length > 1) {
    html += selectionSummary();
  } else if (selection?.kind === 'part') {
    const part = partById(selection.id);
    if (part) {
      const entry = definition(part.type);
      html += `<h2>${entry.name}</h2><p>${entry.description ?? ''}</p>`;
      for (const [key, spec] of Object.entries(entry.props ?? {})) html += propField(part, key, spec);
      if (state.valueError) html += `<p class="field-error" role="alert">${escapeXml(state.valueError)}</p>`;
      if (!entry.annotation) html += field('Label', `<input data-label value="${escapeXml(part.label ?? '')}" ${state.running ? 'disabled' : ''}>`);
    }
  } else if (selection?.kind === 'wire') {
    const wire = state.doc.wires.find((w) => w.id === selection.id);
    if (wire) {
      html += '<h2>Wire</h2>';
      html += `<div class="swatches" role="group" aria-label="Wire color">${WIRE_COLORS.map((color) => `<button class="swatch" data-color="${color}" aria-label="${color}" aria-pressed="${wire.color === color}" style="background:${color}"></button>`).join('')}</div>`;
      html += '<p>Drag a dot to bend the wire. Double-click a bend to remove it.</p>';
    }
  } else {
    html += state.running
      ? '<h2>Running</h2><p>Use the controls below, or press parts on the canvas.</p>'
      : '<h2>Build your circuit</h2><p>Add parts from the list. Click a pin to start a wire, click empty space to add a bend, and click another pin to finish. Press R to rotate and F to flip. Shift-drag to select several things.</p>';
  }
  $('details').innerHTML = html;
  renderControls();
}

function renderControls() {
  if (!state.running) {
    $('controls').innerHTML = '';
    return;
  }
  let html = '';
  for (const part of state.doc.parts) {
    const controls = definition(part.type).controls ?? [];
    const readouts = definition(part.type).readouts ?? [];
    if (controls.length === 0 && readouts.length === 0) continue;
    html += `<div class="control-part"><h3>${definition(part.type).name} <span class="status">${part.id}</span></h3>`;
    // What the program is doing to an output part, which the 3D view shows only as movement.
    for (const readout of readouts) {
      html += `<p class="readout">${readout.label}: <span data-output="${part.id}:${readout.id}">${readoutText(readout, state.views[part.id]?.[readout.id])}</span></p>`;
    }
    for (const control of controls) {
      const key = `${part.id}:${control.id}`;
      const value = state.controlValues[key] ?? control.default ?? 0;
      if (control.kind === 'slider') {
        const unit = control.unit ? ` ${control.unit}` : '';
        html += field(`${control.label}: <output data-readout="${key}">${value}${unit}</output>`, `<input type="range" data-slider="${key}" data-unit="${unit}" min="${control.min}" max="${control.max}" step="${control.step}" value="${value}">`);
      } else if (control.kind === 'momentary') {
        html += `<button data-hold="${key}">${control.label}</button> `;
      } else if (control.kind === 'toggle') {
        html += `<button data-toggle="${key}" aria-pressed="${!!value}">${control.label}: ${value ? 'on' : 'off'}</button> `;
      } else if (control.kind === 'stepper') {
        html += `<button data-step="${key}" data-delta="-1">Left</button> <button data-step="${key}" data-delta="1">Right</button> `;
      } else if (control.kind === 'cycle') {
        html += `<div class="segments" role="group" aria-label="${control.label}">${control.options.map((option, i) => `<button data-cycle="${key}" data-value="${i}" aria-pressed="${value === i}">${option}</button>`).join('')}</div>`;
      } else if (control.kind === 'keys') {
        html += `<div class="keys">${[...control.keys].map((label, i) => `<button data-key="${key}" data-value="${i + 1}">${label}</button>`).join('')}</div>`;
      }
    }
    html += '</div>';
  }
  // Redrawing drops the keyboard's place, so the same control gets the focus back.
  const focused = $('controls').contains(document.activeElement) ? controlSelector(document.activeElement) : null;
  $('controls').innerHTML = html;
  if (focused) $('controls').querySelector(focused)?.focus();
}

// Finds a control again after the list is redrawn.
function controlSelector(element) {
  return Object.entries(element.dataset).map(([name, value]) => `[data-${name}="${value}"]`).join('');
}

// The new value for a property, or undefined if what was typed cannot be used.
function propValue(spec, raw) {
  if (spec.type === 'text') return raw;
  if (spec.custom) return parseValue(raw, spec.unit) ?? undefined;
  return Number.isNaN(Number(raw)) ? raw : Number(raw);
}

$('details').addEventListener('change', (event) => {
  const [part] = selectedParts();
  if (!part) return;
  const key = event.target.dataset.prop;
  if ('label' in event.target.dataset) {
    snapshot();
    const label = event.target.value.trim();
    if (label) part.label = label;
    else delete part.label;
    changed();
  } else if (key) {
    const spec = definition(part.type).props[key];
    const value = propValue(spec, event.target.value);
    if (value === undefined) {
      state.valueError = `"${event.target.value}" is not a value this part can have. Try 220, 4.7k or 1M.`;
      renderInspector();
      state.valueError = null;
      return;
    }
    snapshot();
    (part.props ??= {})[key] = value;
    changed();
  }
});

$('details').addEventListener('click', (event) => {
  const { color, align } = event.target.dataset ?? {};
  if (align) {
    snapshot();
    alignParts(selectedParts(), align);
    changed();
  }
  const wire = selectedWire();
  if (color && wire) {
    snapshot();
    wire.color = color;
    changed();
  }
});

const splitKey = (key) => key.split(':');

$('controls').addEventListener('input', (event) => {
  const key = event.target.dataset.slider;
  if (!key) return;
  const [part, control] = splitKey(key);
  const value = Number(event.target.value);
  sendControl(part, control, value);
  const readout = $('controls').querySelector(`[data-readout="${key}"]`);
  if (readout) readout.textContent = `${value}${event.target.dataset.unit}`;
});

const holdKey = (button) => button.dataset.hold ?? button.dataset.key;

// Presses a momentary control, and lets it go again on the first of `events` that `target` sees.
function holdControl(button, target, events) {
  const [part, control] = splitKey(holdKey(button));
  sendControl(part, control, Number(button.dataset.value ?? 1));
  const release = () => {
    sendControl(part, control, 0);
    for (const name of events) target.removeEventListener(name, release);
  };
  for (const name of events) target.addEventListener(name, release);
}

$('controls').addEventListener('pointerdown', (event) => {
  // Only the main button presses, as with a click, so a right-click does not hold a button down.
  if (event.button === 0 && holdKey(event.target)) holdControl(event.target, window, ['pointerup', 'pointercancel']);
});

// Space or Enter holds a button down for as long as the key is, so the keyboard works like the mouse.
$('controls').addEventListener('keydown', (event) => {
  if ((event.key !== ' ' && event.key !== 'Enter') || !holdKey(event.target)) return;
  event.preventDefault();
  if (!event.repeat) holdControl(event.target, event.target, ['keyup', 'blur']);
});

$('controls').addEventListener('click', (event) => {
  const { toggle, step, cycle } = event.target.dataset;
  if (cycle) {
    const [part, control] = splitKey(cycle);
    sendControl(part, control, Number(event.target.dataset.value));
    renderControls();
  } else if (toggle) {
    const [part, control] = splitKey(toggle);
    sendControl(part, control, state.controlValues[toggle] ? 0 : 1);
    renderControls();
  } else if (step) {
    const [part, control] = splitKey(step);
    sendControl(part, control, (state.controlValues[step] ?? 0) + Number(event.target.dataset.delta));
  }
});

// --- Serial console ---

const CONSOLE_MAX_CHARS = 60000;
const consoleElement = $('console');
const serialFilter = new SerialFilter();
let consoleText = '';

// Shows the console text, with each `File "code.py", line 4` of a traceback as a link to that line.
function renderConsole() {
  const links = frameLinks(consoleText);
  if (links.length === 0) {
    consoleElement.textContent = consoleText;
    return;
  }
  const pieces = [];
  let at = 0;
  for (const { start, end, file, line } of links) {
    const link = document.createElement('span');
    link.className = 'trace-link';
    link.textContent = consoleText.slice(start, end);
    link.title = `Open ${file.replace(/^\/+/, '')} at line ${line}`;
    Object.assign(link.dataset, { file, line });
    pieces.push(consoleText.slice(at, start), link);
    at = end;
  }
  pieces.push(consoleText.slice(at));
  consoleElement.replaceChildren(...pieces);
}

const atConsoleEnd = () => consoleElement.scrollHeight - consoleElement.scrollTop - consoleElement.clientHeight < 4;

function appendSerial(chunk) {
  const { text, title } = serialFilter.push(chunk);
  if (title !== undefined) $('board-title').textContent = title;
  if (!text) return;
  // The console follows new output only from its end, so a student can scroll back and read.
  const following = atConsoleEnd();
  consoleText = typeInto(consoleText, text).slice(-CONSOLE_MAX_CHARS);
  renderConsole();
  if (following) consoleElement.scrollTop = consoleElement.scrollHeight;
}

consoleElement.addEventListener('click', (event) => {
  const link = event.target.closest('.trace-link');
  if (link) vscode.postMessage({ type: 'openFrame', file: link.dataset.file, line: Number(link.dataset.line) });
});

// Offers to add the library a program could not import. Empty hides it.
function showLibraryHint(name) {
  state.libraryHint = name;
  $('library-hint-text').textContent = name ? `${name} is not in this project's lib folder.` : '';
  $('add-library').textContent = name ? `Add ${name}` : '';
  $('library-hint').hidden = !name || consoleElement.hidden;
}

consoleElement.addEventListener('keydown', (event) => {
  let text = event.key.length === 1 ? event.key : { Enter: '\r', Backspace: '\b', Tab: '\t' }[event.key];
  if (event.ctrlKey && event.key.toLowerCase() === 'c') text = '\x03';
  if (event.ctrlKey && event.key.toLowerCase() === 'd') text = '\x04';
  if (text) {
    vscode.postMessage({ type: 'input', text });
    event.preventDefault();
  }
});

function showTab(name) {
  const onConsole = name === 'console';
  consoleElement.hidden = !onConsole;
  $('library-hint').hidden = !onConsole || !state.libraryHint;
  $('problems').hidden = onConsole;
  for (const [tab, active] of [[$('tab-console'), onConsole], [$('tab-problems'), !onConsole]]) {
    tab.classList.toggle('active', active);
    tab.setAttribute('aria-selected', active);
  }
  // A hidden console forgets where it was scrolled to.
  if (onConsole) consoleElement.scrollTop = consoleElement.scrollHeight;
}

// Compares the program with the circuit again, after either one changes.
function checkProgram() {
  const problems = state.program && !state.loadError ? pinProblems(state.program.text, state.doc, state.program.file) : [];
  const text = JSON.stringify(problems);
  if (text === state.codeProblemText) return;
  state.codeProblemText = text;
  state.codeProblems = problems;
  renderProblems();
}

function renderProblems() {
  const problems = [...state.problems, ...state.codeProblems];
  const count = problems.length;
  $('problem-count').textContent = count ? `(${count})` : '';
  $('tab-problems').classList.toggle('alert', problems.some((p) => p.severity === 'error'));
  $('problems').innerHTML = count
    ? problems.map((p) => `<button class="problem ${p.severity}" data-problem-part="${escapeXml(p.part)}"${p.line ? ` data-problem-line="${p.line}"` : ''}><span class="tag">${p.severity}</span><span>${escapeXml(p.message)}</span></button>`).join('')
    : '<p class="empty">No problems found.</p>';
}

// --- Sound ---

let audio;
const tones = new Map();
const audioContext = () => (audio ??= new AudioContext());

const TONE_GAIN = 0.04;

// `level` is how loud the buzzer is, from 0 to 1: a passive one is quieter away from 50% duty.
function setTone(id, frequency, level = 1) {
  const existing = tones.get(id);
  if (!frequency || !level) {
    existing?.oscillator.stop();
    tones.delete(id);
    return;
  }
  if (existing) {
    existing.oscillator.frequency.value = frequency;
    existing.volume.gain.value = TONE_GAIN * level;
    return;
  }
  const context = audioContext();
  const oscillator = context.createOscillator();
  const volume = context.createGain();
  oscillator.type = 'square';
  oscillator.frequency.value = frequency;
  volume.gain.value = TONE_GAIN * level;
  oscillator.connect(volume).connect(context.destination);
  oscillator.start();
  tones.set(id, { oscillator, volume });
}

function stopSound() {
  for (const id of [...tones.keys()]) setTone(id, 0);
}

let pcmTime = 0;
function playSamples(samples, rate, channels) {
  const context = audioContext();
  const frames = Math.floor(samples.length / channels);
  if (frames === 0) return;
  const buffer = context.createBuffer(channels, frames, rate);
  for (let c = 0; c < channels; c++) {
    const data = buffer.getChannelData(c);
    for (let i = 0; i < frames; i++) data[i] = samples[i * channels + c] / 32768;
  }
  const source = context.createBufferSource();
  source.buffer = buffer;
  source.connect(context.destination);
  pcmTime = Math.max(pcmTime, context.currentTime + 0.02);
  source.start(pcmTime);
  pcmTime += buffer.duration;
}

// --- OLED ---

// Every frame is drawn on the same surface, because a display can change 30 times a second.
let oled;

function oledImage(view) {
  if (!view.on) return null;
  const bytes = Uint8Array.from(atob(view.pixels), (c) => c.charCodeAt(0));
  if (!oled) {
    const surface = document.createElement('canvas');
    surface.width = 128;
    surface.height = 64;
    const context = surface.getContext('2d');
    oled = { surface, context, image: context.createImageData(128, 64) };
  }
  const { surface, context, image } = oled;
  for (let y = 0; y < 64; y++) {
    for (let x = 0; x < 128; x++) {
      const on = (bytes[(y >> 3) * 128 + x] >> (y & 7)) & 1;
      const offset = (y * 128 + x) * 4;
      image.data[offset] = on ? 120 : 0;
      image.data[offset + 1] = on ? 220 : 0;
      image.data[offset + 2] = on ? 255 : 0;
      image.data[offset + 3] = 255;
    }
  }
  context.putImageData(image, 0, 0);
  return surface.toDataURL();
}

// --- Messages from the extension ---

function updateReadouts(part, view) {
  for (const readout of (part && definition(part.type).readouts) ?? []) {
    const element = $('controls').querySelector(`[data-output="${part.id}:${readout.id}"]`);
    const text = readoutText(readout, view[readout.id]);
    if (element && element.textContent !== text) element.textContent = text;
  }
}

function applyFrame({ views, board, problems }) {
  for (const [id, view] of Object.entries(views)) {
    const part = partById(id);
    if (part?.type === 'oled-ssd1306' && view.pixels !== undefined) view.image = oledImage(view);
    state.views[id] = view;
    if (view.tone !== undefined) setTone(id, view.tone, view.level);
    updatePart(id);
    updateReadouts(part, view);
  }
  const boardText = JSON.stringify(board);
  if (boardText !== state.boardText) {
    state.boardText = boardText;
    state.board = board;
    updatePart(state.doc.parts.find((p) => p.type === BOARD_TYPE).id);
  }
  const problemText = JSON.stringify(problems);
  if (problemText !== state.problemText) {
    state.problemText = problemText;
    state.problems = problems;
    renderProblems();
    renderStatus();
  }
}

function setRunning(running) {
  const wasRunning = state.running;
  state.running = running;
  state.wiring = null;
  // Every run is a new board, with all its parts and controls back at their defaults.
  state.views = {};
  state.board = {};
  state.boardText = undefined;
  state.controlValues = {};
  // Stopping leaves the list up to read, but a new run starts with a clean slate.
  if (running) {
    state.problems = [];
    state.problemText = undefined;
    renderProblems();
  }
  stopSound();
  if (running && !wasRunning) audioContext().resume?.();
  $('status').textContent = running ? 'Running' : 'Stopped';
  render();
}

const handlers = {
  load(message) {
    state.doc = message.circuit ?? emptyCircuit();
    state.loadError = message.error;
    state.undo = [];
    state.redo = [];
    state.selection = [];
    render();
    fit();
    state.scene3d?.fit();
    state.diagram?.fit();
  },
  showDiagram: openDiagram,
  serial: (message) => appendSerial(message.text),
  clearConsole() {
    consoleText = '';
    consoleElement.textContent = '';
    serialFilter.reset();
    showLibraryHint(undefined);
  },
  libraryHint: (message) => showLibraryHint(message.name),
  frame: applyFrame,
  program(message) {
    state.program = { text: message.text, file: message.file };
    checkProgram();
    renderStatus();
  },
  running: (message) => setRunning(message.running),
  audioStart(message) {
    state.audioFormat = message;
    pcmTime = 0;
  },
  audio(message) {
    if (state.audioFormat) playSamples(message.samples, state.audioFormat.sampleRate, state.audioFormat.channels);
  },
  async export(message) {
    let result;
    try {
      result = await exportFile(message.format, state.doc, viewOf);
    } catch (error) {
      result = { error: error.message };
    }
    vscode.postMessage({ type: 'reply', id: message.id, result });
  },
  // Used by the automated tests.
  async test(message) {
    const { runTestStep } = await import('./test-driver.js');
    const result = await runTestStep(message.step, { state, vscode, toScreen, render, fit });
    vscode.postMessage({ type: 'reply', id: message.id, result });
  },
};

function toScreen(point) {
  const box = canvas.getBoundingClientRect();
  return { clientX: box.left + point.x * state.zoom + state.pan.x, clientY: box.top + point.y * state.zoom + state.pan.y };
}

window.addEventListener('message', ({ data }) => handlers[data.type]?.(data));

// --- Startup ---

$('defs').innerHTML = holePattern();
$('run').addEventListener('click', () => vscode.postMessage({ type: 'run' }));
$('stop').addEventListener('click', () => vscode.postMessage({ type: 'stop' }));
$('undo').addEventListener('click', () => restore(state.undo, state.redo));
$('redo').addEventListener('click', () => restore(state.redo, state.undo));
$('rotate').addEventListener('click', rotateSelection);
$('flip').addEventListener('click', flipSelection);
$('delete').addEventListener('click', deleteSelection);
$('fit').addEventListener('click', () => (state.scene3d ?? state.diagram ?? { fit }).fit());
$('view3d').addEventListener('click', toggle3d);
$('diagram').addEventListener('click', () => (state.diagram ? closeDiagram() : openDiagram()));
$('export').addEventListener('click', () => vscode.postMessage({ type: 'export' }));
$('import').addEventListener('click', () => vscode.postMessage({ type: 'import' }));
$('problems').addEventListener('click', (event) => {
  const button = event.target.closest('[data-problem-part]');
  const id = button?.dataset.problemPart;
  // A problem in the program opens it at that line.
  if (button?.dataset.problemLine) vscode.postMessage({ type: 'showLine', line: Number(button.dataset.problemLine) });
  if (!id || !partById(id)) return;
  state.selection = [{ kind: 'part', id }];
  refreshSelection();
});
$('search').addEventListener('input', (event) => renderPalette(event.target.value));
$('parts').addEventListener('click', (event) => {
  const type = event.target.dataset?.add;
  if (type) addPart(type);
});
$('add-library').addEventListener('click', () => vscode.postMessage({ type: 'addLibrary', name: state.libraryHint }));
$('tab-console').addEventListener('click', () => showTab('console'));
$('tab-problems').addEventListener('click', () => showTab('problems'));
new ResizeObserver(() => applyTransform()).observe(canvas);

renderPalette();
renderProblems();
render();
applyTransform();
vscode.postMessage({ type: 'ready' });

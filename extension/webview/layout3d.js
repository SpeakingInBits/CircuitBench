// Where things sit in the 3D view. This is only geometry, so it can be tested without a GPU.
// Positions use the editor's units, where 10 is 0.1 inch, and `h` is the height above the table.
import { definition, pinPosition } from '../shared/catalog.js';
import { partArt } from './art.js';

export const BREADBOARD_TOP = 16;
export const BOARD_TOP = 14;
export const HEADER_TOP = 22;

// A wire joins a part's leg this far above whatever the part stands on.
const LEG_JOIN = 5;
// A part's body counts as over its pins when they are this close to it.
const PIN_MARGIN = 4.5;

const RECT = /<rect x="(-?[\d.]+)" y="(-?[\d.]+)" width="([\d.]+)" height="([\d.]+)" rx="[^"]*" fill="([^"]+)"([^>]*)>/g;
const CIRCLE = /<circle cx="(-?[\d.]+)" cy="(-?[\d.]+)" r="([\d.]+)" fill="([^"]+)"([^>]*)>/g;

const isBoard = (entry) => entry.category === 'Boards' && !entry.background;
// Boards and breadboards, which other parts stand on.
export const isSurface = (entry) => entry.background || isBoard(entry);
const isSolid =(fill, extra) => fill !== 'none' && !fill.startsWith('url(') && !extra.includes('opacity');

// The largest solid shape in a part's 2D art is its body, so a new part needs no 3D model.
export function artBody(svg) {
  const shapes = [];
  for (const [, x, y, w, h, color, extra] of svg.matchAll(RECT)) {
    if (isSolid(color, extra)) shapes.push({ shape: 'box', x: Number(x), y: Number(y), w: Number(w), h: Number(h), color, area: w * h });
  }
  for (const [, cx, cy, r, color, extra] of svg.matchAll(CIRCLE)) {
    if (isSolid(color, extra)) shapes.push({ shape: 'round', x: cx - r, y: cy - r, w: 2 * r, h: 2 * r, color, area: Math.PI * r * r });
  }
  return shapes.reduce((best, shape) => (!best || shape.area > best.area ? shape : best), null);
}

// The art shows small parts from the side, with the body beyond the pins. Real ones stand on
// their legs, so such a body moves over its pins. `crop` still says where it is in the art.
export function partBody(part) {
  const entry = definition(part.type);
  const body = artBody(partArt(part)) ?? { shape: 'box', x: 0, y: 0, w: Math.max(entry.w, 10), h: Math.max(entry.h, 10), color: '#555' };
  const crop = { x: body.x, y: body.y, w: body.w, h: body.h };
  const over = entry.pins.some((pin) => pin.x >= body.x - PIN_MARGIN && pin.x <= body.x + body.w + PIN_MARGIN
    && pin.y >= body.y - PIN_MARGIN && pin.y <= body.y + body.h + PIN_MARGIN);
  if (over || entry.pins.length === 0) return { ...body, crop };
  const middle = (axis) => entry.pins.reduce((sum, pin) => sum + pin[axis], 0) / entry.pins.length;
  return { ...body, x: middle('x') - body.w / 2, y: middle('y') - body.h / 2, crop };
}

function outline(part, box) {
  const a = pinPosition(part, { x: box.x, y: box.y });
  const b = pinPosition(part, { x: box.x + box.w, y: box.y + box.h });
  return { left: Math.min(a.x, b.x), right: Math.max(a.x, b.x), top: Math.min(a.y, b.y), bottom: Math.max(a.y, b.y) };
}

// The boards and breadboards that other parts can stand on.
export function surfaces(doc) {
  const found = [];
  for (const part of doc.parts) {
    const entry = definition(part.type);
    if (isBoard(entry)) found.push({ ...outline(part, { x: 0, y: 0, w: entry.w, h: entry.h }), h: BOARD_TOP });
    else if (entry.background) found.push({ ...outline(part, partBody(part)), h: BREADBOARD_TOP });
  }
  return found;
}

export function surfaceAt(supports, x, y) {
  let height = 0;
  for (const s of supports) {
    if (x >= s.left && x <= s.right && y >= s.top && y <= s.bottom) height = Math.max(height, s.h);
  }
  return height;
}

// The height a part stands at: the table, or the board its legs reach.
export function partBase(part, supports) {
  const entry = definition(part.type);
  if (isSurface(entry)) return 0;
  const points = entry.pins.length ? entry.pins.map((pin) => pinPosition(part, pin)) : [{ x: part.x, y: part.y }];
  return Math.max(...points.map((point) => surfaceAt(supports, point.x, point.y)));
}

function pinPoint(doc, supports, end) {
  const part = doc.parts.find((p) => p.id === end.part);
  const entry = part && definition(part.type);
  const pin = entry?.pins.find((p) => p.id === end.pin);
  if (!pin) return null;
  const h = entry.background ? BREADBOARD_TOP : isBoard(entry) ? HEADER_TOP : partBase(part, supports) + LEG_JOIN;
  return { ...pinPosition(part, pin), h };
}

// A jumper wire leaves one pin straight up, arches over and drops into the other. Longer wires
// arch higher, and `index` staggers them so wires between the same places don't overlap.
export function wireRoute(doc, wire, index = 0, supports = surfaces(doc)) {
  const start = pinPoint(doc, supports, wire.from);
  const end = pinPoint(doc, supports, wire.to);
  if (!start || !end) return null;
  const span = Math.hypot(end.x - start.x, end.y - start.y);
  const top = Math.max(start.h, end.h) + 12 + Math.min(40, span * 0.12) + (index % 4) * 2.5;
  const rise = (point) => ({ x: point.x, y: point.y, h: point.h + (top - point.h) * 0.6 });
  const bends = (wire.points ?? []).map((point) => ({ x: point.x, y: point.y, h: top }));
  const middle = bends.length ? bends : [{ x: (start.x + end.x) / 2, y: (start.y + end.y) / 2, h: top }];
  return [start, rise(start), ...middle, rise(end), end];
}

// The area the circuit covers on the table.
export function sceneBounds(doc) {
  const boxes = doc.parts.filter((part) => !definition(part.type).annotation).map((part) => {
    const entry = definition(part.type);
    return outline(part, isBoard(entry) ? { x: 0, y: 0, w: entry.w, h: entry.h } : partBody(part));
  });
  if (boxes.length === 0) return { left: 0, right: 100, top: 0, bottom: 100 };
  return {
    left: Math.min(...boxes.map((box) => box.left)),
    right: Math.max(...boxes.map((box) => box.right)),
    top: Math.min(...boxes.map((box) => box.top)),
    bottom: Math.max(...boxes.map((box) => box.bottom)),
  };
}

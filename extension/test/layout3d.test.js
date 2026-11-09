import assert from 'node:assert/strict';
import test from 'node:test';
import { BOARD_TYPE, CATALOG, defaultProps, definition, emptyCircuit } from '../shared/catalog.js';
import { BOARD_TOP, BREADBOARD_TOP, HEADER_TOP, artBody, isSurface, partBase, partBody, sceneBounds, surfaces, wireRoute } from '../webview/layout3d.js';

const part = (id, type, x, y, rotation = 0) => ({ id, type, x, y, rotation, props: defaultProps(type) });

function circuit(...parts) {
  const doc = emptyCircuit();
  doc.parts.push(...parts);
  return doc;
}

test('every catalog part gets a usable body from its art', () => {
  for (const type of Object.keys(CATALOG)) {
    const body = partBody(part('p', type, 0, 0));
    assert.ok(body.w > 0 && body.h > 0, `${type} has no size`);
    assert.ok(Number.isFinite(body.x) && Number.isFinite(body.y), `${type} has no position`);
    assert.match(body.color, /^#/, `${type} has no color`);
  }
});

test('the body is the largest solid shape, not a see-through highlight', () => {
  const body = artBody('<rect x="0" y="0" width="10" height="10" rx="0" fill="#123" /><circle cx="5" cy="5" r="40" fill="#fff" opacity="0.3"/>');
  assert.deepEqual([body.shape, body.w, body.color], ['box', 10, '#123']);
  assert.equal(artBody('<path d="M0 0"/>'), null);
});

test('a body drawn beyond its legs moves over them, and keeps its place in the art', () => {
  const body = partBody(part('t', 'thermistor', 0, 0));
  assert.equal(body.x + body.w / 2, 5);
  assert.equal(body.y + body.h / 2, 10);
  assert.equal(body.crop.y, -6);
});

test('a module with pins along its edge stays where it was drawn', () => {
  const body = partBody(part('m', 'mcp9808', 0, 0));
  assert.equal(body.y, body.crop.y);
});

test('parts stand on the breadboard or the table, depending on their pins', () => {
  const plugged = part('r1', 'resistor', 100, 340);
  const loose = part('r2', 'resistor', 900, 900);
  const onBoard = part('r3', 'resistor', 100, 100);
  const doc = circuit(part('bb', 'breadboard-half', 40, 290), plugged, loose, onBoard);
  const supports = surfaces(doc);
  assert.equal(partBase(plugged, supports), BREADBOARD_TOP);
  assert.equal(partBase(loose, supports), 0);
  assert.equal(partBase(onBoard, supports), BOARD_TOP);
  assert.equal(partBase(doc.parts[1], supports), 0, 'a breadboard stands on the table');
});

test('boards and breadboards are surfaces, and parts are not', () => {
  assert.equal(isSurface(definition('breadboard-half')), true);
  assert.equal(isSurface(definition(BOARD_TYPE)), true);
  assert.equal(isSurface(definition('resistor')), false);
});

test('a rotated breadboard still holds parts in its new position', () => {
  const inside = part('r1', 'resistor', 500, 200);
  const doc = circuit(part('bb', 'breadboard-half', 600, 100, 90), inside);
  assert.equal(partBase(inside, surfaces(doc)), BREADBOARD_TOP);
});

test('a wire runs from pin to pin and arches over both ends', () => {
  const doc = circuit(part('bb', 'breadboard-half', 40, 290));
  const route = wireRoute(doc, { from: { part: 'board', pin: 'D5' }, to: { part: 'bb', pin: 'b4' } });
  const first = route[0];
  const last = route.at(-1);
  assert.equal(first.h, HEADER_TOP);
  assert.equal(last.h, BREADBOARD_TOP);
  assert.deepEqual([first.x, first.y], [250, 50]);
  assert.deepEqual([last.x, last.y], [100, 350]);
  const peak = Math.max(...route.map((point) => point.h));
  assert.ok(peak > HEADER_TOP + 10);
});

test('a wire keeps the bends the student drew', () => {
  const route = wireRoute(circuit(), {
    from: { part: 'board', pin: 'D5' }, to: { part: 'board', pin: 'A0' }, points: [{ x: 400, y: 50 }, { x: 400, y: 240 }],
  });
  assert.equal(route.length, 6);
  assert.deepEqual([route[2].x, route[2].y], [400, 50]);
  assert.deepEqual([route[3].x, route[3].y], [400, 240]);
});

test('a wire to a missing pin is left out', () => {
  assert.equal(wireRoute(circuit(), { from: { part: 'board', pin: 'D5' }, to: { part: 'gone', pin: '1' } }), null);
});

test('the bounds cover every part', () => {
  const box = sceneBounds(circuit(part('bb', 'breadboard-half', 40, 290)));
  assert.deepEqual(box, { left: 40, right: 370, top: 40, bottom: 500 });
  assert.ok(Number.isFinite(sceneBounds({ parts: [], wires: [] }).right));
});

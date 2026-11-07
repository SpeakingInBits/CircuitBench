// Tests editing, export and project packages without a browser.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { defaultProps, definition, emptyCircuit, noteLines, partBounds, pinPosition } from '../shared/catalog.js';
import { buildNets, pinKey } from '../shared/nets.js';
import { createPackage, isSafeName, readPackage } from '../shared/project-package.js';
import { partArt } from '../webview/art.js';
import { alignParts, copyParts, flipParts, internalWires, moveParts, parseValue, pasteClip, rotateParts, wirePoints } from '../webview/editing.js';
import { circuitImage, diagramImage, partsList, partsListCsv } from '../webview/export.js';
import { layoutDiagram } from '../webview/diagram-layout.js';

const part = (id, type, x, y, extra = {}) => ({ id, type, x, y, rotation: 0, props: defaultProps(type), ...extra });
const pin = (doc, id, pinId) => {
  const found = doc.parts.find((p) => p.id === id);
  return pinPosition(found, definition(found.type).pins.find((p) => p.id === pinId));
};

function sample() {
  const doc = emptyCircuit();
  doc.parts.push(part('r1', 'resistor', 500, 500), part('l1', 'led', 600, 500));
  doc.wires.push({ id: 'wire1', from: { part: 'r1', pin: '2' }, to: { part: 'l1', pin: 'A' }, points: [{ x: 560, y: 480 }], color: '#222' });
  doc.wires.push({ id: 'wire2', from: { part: 'board', pin: 'D2' }, to: { part: 'r1', pin: '1' }, points: [], color: '#222' });
  return doc;
}

const idMaker = (doc) => (prefix) => {
  const taken = new Set([...doc.parts, ...doc.wires].map((item) => item.id));
  let n = 1;
  while (taken.has(`${prefix}${n}`)) n++;
  return `${prefix}${n}`;
};

test('typed values: the ways people write a resistance', () => {
  for (const [text, ohms] of [['220', 220], ['4.7k', 4700], ['4k7', 4700], ['1M', 1e6], ['2M2', 2.2e6], ['100 ohm', 100], ['4.7k ohm', 4700], ['1kΩ', 1000], ['0.5', 0.5]]) {
    assert.equal(parseValue(text, 'ohm'), ohms, text);
  }
});

test('typed values: nonsense and zero are refused', () => {
  for (const text of ['', 'abc', '0', '-5', '1.2k3', '12 34', '1e400', '4x7']) assert.equal(parseValue(text, 'ohm'), null, text);
  assert.equal(parseValue('47', 'uF'), 47);
  assert.equal(parseValue('100 uF', 'uF'), 100);
  assert.equal(parseValue('1k', 'uF'), null);
});

test('copy and paste brings the wires between the parts, with new ids', () => {
  const doc = sample();
  const parts = doc.parts.filter((p) => p.id !== 'board');
  const clip = copyParts(doc, parts);
  assert.deepEqual(clip.wires.map((w) => w.id), ['wire1'], 'the wire to the board stays behind');

  const added = pasteClip(doc, clip, 20, idMaker(doc));
  assert.deepEqual(added, [{ kind: 'part', id: 'resistor1' }, { kind: 'part', id: 'led1' }, { kind: 'wire', id: 'wire3' }]);
  const pasted = doc.wires.find((w) => w.id === 'wire3');
  assert.deepEqual(pasted.from, { part: 'resistor1', pin: '2' });
  assert.deepEqual(pasted.to, { part: 'led1', pin: 'A' });
  assert.deepEqual(pasted.points, [{ x: 580, y: 500 }]);
  assert.equal(doc.parts.find((p) => p.id === 'resistor1').x, 520);
});

test('the board is never copied', () => {
  const doc = sample();
  assert.equal(copyParts(doc, [doc.parts[0]]), null);
  assert.deepEqual(copyParts(doc, doc.parts).parts.map((p) => p.id), ['r1', 'l1']);
});

test('moving parts carries the bends of wires between them, and no others', () => {
  const doc = sample();
  moveParts(doc, doc.parts.filter((p) => p.id !== 'board'), 30, -10);
  assert.deepEqual(doc.wires[0].points, [{ x: 590, y: 470 }]);
  assert.deepEqual(doc.wires[1].points, []);
});

test('rotating a group keeps its pins joined and on the grid', () => {
  const doc = sample();
  const parts = doc.parts.filter((p) => p.id !== 'board');
  doc.parts.find((p) => p.id === 'l1').x = 540; // Its anode now sits on the resistor's second lead.
  const joined = () => buildNets(doc).sameNet(pinKey('r1', '2'), pinKey('l1', 'A'));
  doc.parts.find((p) => p.id === 'l1').y = 490;
  assert.ok(joined());
  for (let turns = 1; turns <= 4; turns++) {
    rotateParts(doc, parts);
    assert.ok(joined(), `after ${turns} turns`);
    for (const p of parts) {
      assert.equal(p.x % 10, 0);
      assert.equal(p.y % 10, 0);
    }
  }
  assert.equal(parts[0].rotation, 0);
});

test('rotating one part turns it where it stands', () => {
  const doc = sample();
  const [, resistor] = doc.parts;
  rotateParts(doc, [resistor]);
  assert.deepEqual([resistor.x, resistor.y, resistor.rotation], [500, 500, 90]);
});

test('flipping a part swaps its pins left to right, and twice restores it', () => {
  const doc = sample();
  const [, resistor] = doc.parts;
  const before = [pin(doc, 'r1', '1'), pin(doc, 'r1', '2')];
  flipParts(doc, [resistor]);
  assert.equal(resistor.flip, true);
  assert.deepEqual([pin(doc, 'r1', '2'), pin(doc, 'r1', '1')], before);
  flipParts(doc, [resistor]);
  assert.equal(resistor.flip, false);
  assert.deepEqual([pin(doc, 'r1', '1'), pin(doc, 'r1', '2')], before);
});

test('flipping a rotated group keeps its pins joined and on the grid', () => {
  const doc = sample();
  const parts = doc.parts.filter((p) => p.id !== 'board');
  doc.parts.find((p) => p.id === 'l1').x = 540;
  doc.parts.find((p) => p.id === 'l1').y = 490;
  rotateParts(doc, parts);
  flipParts(doc, parts);
  assert.ok(buildNets(doc).sameNet(pinKey('r1', '2'), pinKey('l1', 'A')));
  for (const p of parts) assert.equal(p.x % 5, 0);
  assert.equal(pin(doc, 'r1', '1').x % 10, 0);
});

test('a flipped part keeps its writing readable', () => {
  const art = partArt(part('b', 'battery', 0, 0, { flip: true }));
  assert.match(art, /<text x="15" y="20" transform="matrix\(-1 0 0 1 30 0\)"/);
});

test('aligning lines parts up', () => {
  const parts = [part('a', 'led', 100, 100), part('b', 'led', 300, 150), part('c', 'led', 200, 300)];
  alignParts(parts, 'left');
  assert.deepEqual(parts.map((p) => p.x), [100, 100, 100]);
  alignParts(parts, 'bottom');
  assert.deepEqual(parts.map((p) => p.y), [300, 300, 300]);
});

test('a note grows with its text and has no place in the diagram', () => {
  assert.deepEqual(noteLines('one\ntwo'), ['one', 'two']);
  assert.ok(noteLines('word '.repeat(30)).every((line) => line.length <= 30));
  const doc = emptyCircuit();
  const note = part('n', 'note', 400, 400);
  doc.parts.push(note);
  const short = partBounds(note).h;
  note.props.text = 'a\nb\nc';
  assert.ok(partBounds(note).h > short);
  assert.ok(!layoutDiagram(doc).parts.some((item) => item.id === 'n'));
});

test('a part label replaces its name in the diagram', () => {
  const doc = sample();
  doc.parts[1].label = 'Current limit';
  assert.ok(layoutDiagram(doc).parts.some((item) => item.name === 'Current limit'));
});

test('wire points follow the parts at both ends', () => {
  const doc = sample();
  assert.deepEqual(wirePoints(doc, doc.wires[0]), [{ x: 540, y: 500 }, { x: 560, y: 480 }, { x: 600, y: 510 }]);
  assert.equal(wirePoints(doc, { from: { part: 'gone', pin: '1' }, to: { part: 'r1', pin: '1' } }), null);
  assert.deepEqual(internalWires(doc, doc.parts.slice(0, 2)).map((w) => w.id), ['wire2']);
});

test('the parts list groups matching parts and counts wires', () => {
  const doc = sample();
  doc.parts.push(part('r2', 'resistor', 700, 500, { label: 'Pull-up' }), part('r3', 'resistor', 800, 500, { props: { ohms: 1000 } }), part('n', 'note', 900, 500));
  assert.deepEqual(partsList(doc).map((row) => [row.quantity, row.name, row.value]), [
    [1, 'Metro M0 Express', ''], [2, 'Resistor', '220 Ω'], [1, 'LED', 'red'], [1, 'Resistor', '1 kΩ'], [2, 'Jumper wire', ''],
  ]);
  assert.deepEqual(partsList(doc)[1].parts, ['r1', 'Pull-up']);
});

test('the parts list cannot smuggle a formula into a spreadsheet', () => {
  const doc = emptyCircuit();
  doc.parts[0].label = '=HYPERLINK("x")';
  const csv = partsListCsv(doc);
  assert.ok(csv.startsWith('Quantity,Part,Value,Used as\r\n'));
  assert.ok(csv.includes(`"'=HYPERLINK(""x"")"`), csv);
});

test('images cover the whole circuit and escape what students type', () => {
  const doc = sample();
  doc.parts.push(part('n', 'note', 900, 900, { props: { text: '<script>&' }, label: '<b>' }));
  const { svg, width, height } = circuitImage(doc);
  assert.ok(width > 900 && height > 800);
  assert.ok(!svg.includes('<script>') && !svg.includes('<b>'));
  assert.ok(svg.includes('&lt;script&gt;&amp;'));
  assert.ok(svg.includes('id="holes"'), 'breadboards need their hole pattern');
  const diagram = diagramImage(sample());
  assert.match(diagram.svg, /^<svg xmlns=/);
  assert.ok(!diagram.svg.includes('var(--'), 'a saved file has no theme to read');
});

const packaged = (overrides = {}) => JSON.stringify({ ...JSON.parse(createPackage({
  name: 'blink', circuit: emptyCircuit(), files: { '/code.py': 'print("hi")\n', '/lib/thing.mpy': Buffer.from([0, 255, 1]) },
})), ...overrides });

test('a package holds a project byte for byte', () => {
  const { name, circuit, files } = readPackage(packaged());
  assert.equal(name, 'blink');
  assert.deepEqual(circuit, emptyCircuit());
  assert.deepEqual(files.map((file) => file.path), ['code.py', 'lib/thing.mpy']);
  assert.equal(files[0].data.toString(), 'print("hi")\n');
  assert.deepEqual([...files[1].data], [0, 255, 1]);
});

test('an example project survives a round trip', () => {
  const folder = new URL('../examples/blink/', import.meta.url);
  const code = fs.readFileSync(new URL('code.py', folder));
  const circuit = JSON.parse(fs.readFileSync(new URL('circuit.json', folder), 'utf8'));
  const unpacked = readPackage(createPackage({ name: 'blink', circuit, files: { '/code.py': code } }));
  assert.deepEqual(unpacked.circuit, circuit);
  assert.deepEqual(unpacked.files[0].data, code);
});

test('a package cannot write outside its project', () => {
  for (const path of ['../evil.py', 'lib/../../evil.py', '/etc/passwd', 'C:\\evil.py', 'C:/evil.py', '.vscode/tasks.json', 'lib/.hidden', 'a\\b', 'CON', 'lib/nul.py', 'evil.py ', 'evil.', '', 'lib//x']) {
    assert.throws(() => readPackage(packaged({ files: { [path]: 'AA==' } })), /unsafe file/, path);
  }
});

test('a package cannot replace the circuit through its files', () => {
  assert.throws(() => readPackage(packaged({ files: { 'Circuit.JSON': 'AA==' } })), /unsafe file/);
});

test('a package saved under the old name still opens', () => {
  assert.equal(readPackage(packaged({ format: 'metro-simulator-project' })).name, 'blink');
});

test('a package with a bad name, circuit or size is handled', () => {
  assert.equal(readPackage(packaged({ name: '../../evil' })).name, 'imported-project');
  assert.throws(() => readPackage('not json'), /not a project package/);
  assert.throws(() => readPackage('{"format":"other"}'), /not a project package/);
  assert.throws(() => readPackage(packaged({ version: 2 })), /newer version/);
  assert.throws(() => readPackage(packaged({ circuit: { parts: [], wires: [] } })), /cannot be used/);
  assert.throws(() => readPackage(packaged({ files: null })), /no files/);
  assert.throws(() => readPackage(packaged({ files: { 'big.bin': Buffer.alloc(3 * 1024 * 1024).toString('base64') } })), /larger than/);
});

test('only ordinary names are safe', () => {
  assert.ok(isSafeName('code.py'));
  assert.ok(isSafeName('my project'));
  for (const name of ['..', '.', '.git', 'a/b', 'a:b', 'aux', 'x'.repeat(101), 7, undefined]) assert.equal(isSafeName(name), false, name);
});

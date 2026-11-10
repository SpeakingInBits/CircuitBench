// The numbers the controls panel shows for output parts, such as a servo's angle.
import assert from 'node:assert/strict';
import test from 'node:test';
import { definition, readoutText } from '../shared/catalog.js';

const readout = (type, id) => definition(type).readouts.find((r) => r.id === id);

test('a servo shows its angle in degrees, starting at 90', () => {
  const angle = readout('servo', 'angle');
  assert.equal(readoutText(angle, 45), '45°');
  assert.equal(readoutText(angle, 0), '0°');
  assert.equal(readoutText(angle, undefined), '90°');
});

test('a buzzer shows the frequency it plays, and off when silent', () => {
  const tone = readout('piezo', 'tone');
  assert.equal(readoutText(tone, 440), '440 Hz');
  assert.equal(readoutText(tone, 261.63), '262 Hz');
  assert.equal(readoutText(tone, 0), 'off');
  assert.equal(readoutText(tone, undefined), 'off');
});

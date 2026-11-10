// Tests the serial console's text handling without a page or any firmware.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SerialFilter, typeInto } from '../webview/serial-text.js';

const TITLE = '\x1b]0;code.py | 10.3.1\x1b\\';

test('text after a title in the same chunk is shown straight away', () => {
  const { text, title } = new SerialFilter().push(`${TITLE}hello\r\n`);
  assert.equal(text, 'hello\n');
  assert.equal(title, 'code.py | 10.3.1');
});

test('a title split across chunks is held back, then removed', () => {
  const filter = new SerialFilter();
  assert.equal(filter.push('before \x1b]0;code').text, 'before ');
  assert.equal(filter.push('.py\x1b').text, '');
  const last = filter.push('\\after');
  assert.equal(last.text, 'after');
  assert.equal(last.title, 'code.py');
});

test('a color code split across chunks is removed', () => {
  const filter = new SerialFilter();
  assert.equal(filter.push('a\x1b').text, 'a');
  assert.equal(filter.push('[3').text, '');
  assert.equal(filter.push('1mb').text, 'b');
});

test('the latest of several titles wins', () => {
  assert.equal(new SerialFilter().push(`${TITLE}x\x1b]0;done\x1b\\y`).title, 'done');
});

test('a stray escape character cannot hold back later output', () => {
  const filter = new SerialFilter();
  assert.equal(filter.push('\x1b').text, '');
  assert.match(filter.push('hello').text, /hello/);
  const unterminated = new SerialFilter();
  unterminated.push('\x1b]title with no end');
  assert.match(unterminated.push('x'.repeat(300)).text, /x{300}/);
});

test('reset forgets a held back sequence', () => {
  const filter = new SerialFilter();
  filter.push('\x1b]0;old');
  filter.reset();
  assert.equal(filter.push('new').text, 'new');
});

test('backspace removes the last character', () => {
  assert.equal(typeInto('abc', '\b\bz'), 'az');
  assert.equal(typeInto('', '\bq'), 'q');
  assert.equal(typeInto('abc', 'def\n'), 'abcdef\n');
});

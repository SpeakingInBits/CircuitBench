// Tests reading CircuitPython tracebacks out of the serial console's text. The samples are what
// the simulated board prints, with escapes removed.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { frameLinks, missingModule, parseTracebacks } from '../shared/traceback.js';

const TYPO = `code.py output:
Traceback (most recent call last):
  File "code.py", line 4, in <module>
AttributeError: can't set attribute 'valu'

Code done running.
`;

const IN_LIBRARY = `Traceback (most recent call last):
  File "code.py", line 3, in <module>
  File "/lib/helper.py", line 2, in go
ZeroDivisionError: division by zero
`;

const CHAINED = `Traceback (most recent call last):
  File "code.py", line 2, in <module>
ZeroDivisionError: division by zero

During handling of the above exception, another exception occurred:

Traceback (most recent call last):
  File "code.py", line 4, in <module>
ValueError: bad
`;

test('a traceback gives its frames and its error', () => {
  const [traceback, ...rest] = parseTracebacks(TYPO);
  assert.equal(rest.length, 0);
  assert.deepEqual(traceback.frames, [{ file: 'code.py', line: 4, scope: '<module>' }]);
  assert.equal(traceback.type, 'AttributeError');
  assert.equal(traceback.message, "can't set attribute 'valu'");
  assert.equal(TYPO.slice(traceback.end), '\nCode done running.\n');
});

test('frames are listed outermost first, with the library frame last', () => {
  const [traceback] = parseTracebacks(IN_LIBRARY);
  assert.deepEqual(traceback.frames.map((frame) => `${frame.file}:${frame.line}`), ['code.py:3', '/lib/helper.py:2']);
  assert.equal(traceback.type, 'ZeroDivisionError');
});

test('a syntax error has a frame with no scope', () => {
  const [traceback] = parseTracebacks('Traceback (most recent call last):\n  File "code.py", line 2\nSyntaxError: invalid syntax\n');
  assert.deepEqual(traceback.frames, [{ file: 'code.py', line: 2, scope: undefined }]);
  assert.equal(traceback.type, 'SyntaxError');
  assert.equal(traceback.message, 'invalid syntax');
});

test('an error with no message is read', () => {
  const [traceback] = parseTracebacks('Traceback (most recent call last):\n  File "code.py", line 9, in <module>\nKeyboardInterrupt\n');
  assert.equal(traceback.type, 'KeyboardInterrupt');
  assert.equal(traceback.message, '');
});

test('chained tracebacks are both read, the last one last', () => {
  const tracebacks = parseTracebacks(CHAINED);
  assert.deepEqual(tracebacks.map((traceback) => traceback.type), ['ZeroDivisionError', 'ValueError']);
  assert.equal(tracebacks[1].frames[0].line, 4);
});

test('a traceback still arriving is not read until its error line ends', () => {
  const whole = IN_LIBRARY;
  for (const cut of [10, whole.indexOf('ZeroDivision'), whole.length - 1]) {
    assert.deepEqual(parseTracebacks(whole.slice(0, cut)), [], `cut at ${cut}`);
  }
  assert.equal(parseTracebacks(whole).length, 1);
});

test('ordinary output, and a header with no frames, are not tracebacks', () => {
  assert.deepEqual(parseTracebacks('hello\nFile "code.py", line 3\nCode done running.\n'), []);
  assert.deepEqual(parseTracebacks('Traceback (most recent call last):\nprinted by the program\n'), []);
});

test('a missing module is found in an ImportError only', () => {
  const missing = parseTracebacks("Traceback (most recent call last):\n  File \"code.py\", line 2, in <module>\nImportError: no module named 'adafruit_hcsr04'\n");
  assert.equal(missingModule(missing[0]), 'adafruit_hcsr04');
  assert.equal(missingModule({ type: 'ImportError', message: "no module named 'adafruit_display_text.label'" }), 'adafruit_display_text');
  assert.equal(missingModule({ type: 'ImportError', message: "can't import name x" }), undefined);
  assert.equal(missingModule({ type: 'NameError', message: "no module named 'x'" }), undefined);
});

test('the console links each frame line, and nothing else', () => {
  const text = `print says File "fake.py", line 1\n${IN_LIBRARY}`;
  const links = frameLinks(text);
  assert.deepEqual(links.map(({ file, line }) => [file, line]), [['code.py', 3], ['/lib/helper.py', 2]]);
  assert.deepEqual(links.map(({ start, end }) => text.slice(start, end)), ['File "code.py", line 3', 'File "/lib/helper.py", line 2']);
});

// Reads the tracebacks CircuitPython prints when a program stops with an error, such as:
//
//   Traceback (most recent call last):
//     File "code.py", line 3, in <module>
//     File "/lib/helper.py", line 2, in go
//   ZeroDivisionError: division by zero
//
// A syntax error has no ", in ..." part. The text is the console text, with escapes removed.

const HEADER = 'Traceback (most recent call last):';
const FRAME = /^ {2}File "([^"\n]+)", line (\d+)(?:, in ([^\n]+))?$/;
const ERROR = /^([A-Za-z_][\w.]*)(?:: ?(.*))?$/;
const MISSING_MODULE = /^no module named '([^'.]+)/;

// Every complete traceback in the text, in order. One still arriving is left out, so text that
// ends partway through a traceback gives it once the error line and its line break arrive.
// `end` is where each one stops in the text.
export function parseTracebacks(text) {
  const found = [];
  let start = text.indexOf(HEADER);
  while (start !== -1) {
    let at = start + HEADER.length + 1;
    const frames = [];
    let error;
    for (;;) {
      const lineEnd = text.indexOf('\n', at);
      if (lineEnd === -1) break;
      const line = text.slice(at, lineEnd);
      at = lineEnd + 1;
      const frame = line.match(FRAME);
      if (frame) {
        frames.push({ file: frame[1], line: Number(frame[2]), scope: frame[3] });
        continue;
      }
      const match = frames.length > 0 && line.match(ERROR);
      if (match) error = { type: match[1], message: match[2] ?? '' };
      break;
    }
    if (error) found.push({ frames, ...error, end: at });
    start = text.indexOf(HEADER, error ? at : start + HEADER.length);
  }
  return found;
}

// The module an ImportError could not find, for a traceback or an error message.
export function missingModule(traceback) {
  if (traceback.type !== 'ImportError') return undefined;
  return traceback.message.match(MISSING_MODULE)?.[1];
}

// Where the console shows `File "name", line N` at the start of a traceback line, so it can be a
// link. Positions are offsets into the text.
export function frameLinks(text) {
  const links = [];
  for (const match of text.matchAll(/^ {2}(File "([^"\n]+)", line (\d+))/gm)) {
    const start = match.index + 2;
    links.push({ start, end: start + match[1].length, file: match[2], line: Number(match[3]) });
  }
  return links;
}

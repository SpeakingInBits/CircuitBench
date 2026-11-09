// Turns the raw bytes a board prints into what the serial console shows.

// The end of an escape sequence that has not finished arriving. The length limit stops a stray
// escape character from holding back everything printed after it.
const UNFINISHED_ESCAPE = /\x1b(?:\][^\x1b]{0,200}\x1b?|\[[0-9;]{0,20})?$/;

export class SerialFilter {
  constructor() {
    this.reset();
  }

  reset() {
    this.partial = '';
  }

  // Returns the printable text from a chunk, and the latest board title in it, if any. A sequence
  // can arrive split across chunks, so an unfinished one waits for the next chunk.
  push(chunk) {
    let text = this.partial + chunk;
    const unfinished = text.match(UNFINISHED_ESCAPE);
    this.partial = unfinished ? unfinished[0] : '';
    if (unfinished) text = text.slice(0, unfinished.index);
    const title = [...text.matchAll(/\x1b\]0;(.*?)\x1b\\/g)].at(-1)?.[1];
    const clean = text.replace(/\x1b\].*?\x1b\\/g, '').replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').replace(/\r/g, '');
    return { text: clean, title };
  }
}

// Adds text to what the console shows, with backspace removing the last character.
export function typeInto(content, text) {
  if (!text.includes('\b')) return content + text;
  let result = content;
  for (const character of text) {
    if (character === '\b') result = result.slice(0, -1);
    else result += character;
  }
  return result;
}

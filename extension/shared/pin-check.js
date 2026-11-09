// Compares the program with the circuit: a board pin the code uses but nothing is wired to is the
// usual reason an LED stays dark. Plain text matching, so it needs no Python.
import { BOARD_PINS, BOARD_TYPE, definition } from './catalog.js';
import { buildNets, pinKey } from './nets.js';

// Names in the board module that stand for a header pin.
const ALIASES = { LED: 'D13', TX: 'D1', RX: 'D0' };
// Pins with a part on the board itself, so they always have something to drive.
const ON_BOARD = new Set(['D13', 'NEOPIXEL']);
// Buses the board module sets up on its fixed pins, and whether they need all of them wired or
// any one. SPI needs its clock, but a part may only send or only receive.
const BUSES = {
  I2C: { pins: ['SCL', 'SDA'], need: 'all' },
  STEMMA_I2C: { pins: ['SCL', 'SDA'], need: 'all' },
  SPI: { pins: ['SCK'], need: 'all' },
  UART: { pins: ['D1', 'D0'], need: 'any' },
};
const PIN_NAMES = { D0: 'D0 (RX)', D1: 'D1 (TX)' };

// Blanks out comments and strings, keeping every line break so line numbers still match.
export function codeOnly(text) {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '#') {
      while (i < text.length && text[i] !== '\n') {
        out += ' ';
        i++;
      }
    } else if (c === '"' || c === "'") {
      const quote = text.startsWith(c.repeat(3), i) ? c.repeat(3) : c;
      out += ' '.repeat(quote.length);
      i += quote.length;
      while (i < text.length && !text.startsWith(quote, i)) {
        if (quote.length === 1 && text[i] === '\n') break;
        if (text[i] === '\\' && text[i + 1] !== '\n') {
          out += '  ';
          i += 2;
          continue;
        }
        out += text[i] === '\n' ? '\n' : ' ';
        i++;
      }
      if (text.startsWith(quote, i)) {
        out += ' '.repeat(quote.length);
        i += quote.length;
      }
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

// Every name the program takes from the board module, at the line it is first used:
// [{ name, line, call }] where call is true for board.I2C() and the like.
export function boardUses(text) {
  const lines = codeOnly(text).split('\n');
  const modules = new Set();
  const imported = new Map(); // A local name from `from board import X as Y`, to the board name.
  for (const line of lines) {
    const plain = line.match(/^\s*import\s+(.+)$/);
    if (plain) {
      for (const item of plain[1].split(',')) {
        const [, module, alias] = item.trim().match(/^(\w+)(?:\s+as\s+(\w+))?$/) ?? [];
        if (module === 'board') modules.add(alias ?? 'board');
      }
    }
    const from = line.match(/^\s*from\s+board\s+import\s+\(?([^)]*)\)?/);
    if (from) {
      for (const item of from[1].split(',')) {
        const [, name, alias] = item.trim().match(/^(\w+)(?:\s+as\s+(\w+))?$/) ?? [];
        if (name) imported.set(alias ?? name, name);
      }
    }
  }

  const uses = new Map();
  const note = (match, name, line) => {
    if (!uses.has(name)) uses.set(name, { name, line, call: !!match.groups.call });
  };
  const call = '(?<call>\\s*\\()?';
  const attribute = modules.size && new RegExp(`(?<![\\w.])(?:${[...modules].join('|')})\\s*\\.\\s*(\\w+)${call}`, 'g');
  const bare = imported.size && new RegExp(`(?<![\\w.])(${[...imported.keys()].join('|')})\\b${call}`, 'g');
  lines.forEach((line, i) => {
    if (attribute) for (const match of line.matchAll(attribute)) note(match, match[1], i + 1);
    if (bare && !/^\s*from\s/.test(line)) for (const match of line.matchAll(bare)) note(match, imported.get(match[1]), i + 1);
  });
  return [...uses.values()].sort((a, b) => a.line - b.line);
}

// Board pins that reach another part, or another board pin, through wires and breadboard rows.
export function wiredBoardPins(circuit) {
  const board = circuit.parts.find((part) => part.type === BOARD_TYPE);
  if (!board) return new Set();
  const nets = buildNets(circuit);
  const counts = new Map();
  for (const part of circuit.parts) {
    const entry = definition(part.type);
    if (entry.background || entry.annotation) continue;
    for (const pinDef of entry.pins) {
      const root = nets.find(pinKey(part.id, pinDef.id));
      counts.set(root, (counts.get(root) ?? 0) + 1);
    }
  }
  return new Set(Object.keys(BOARD_PINS).filter((pin) => counts.get(nets.find(pinKey(board.id, pin))) > 1));
}

const listed = (names, word) => (names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} ${word} ${names.at(-1)}`);

// A warning for each board pin the program uses that nothing is wired to. Each warning points at
// the board pin and at the line that uses it.
export function pinProblems(text, circuit, file = 'code.py') {
  const board = circuit.parts.find((part) => part.type === BOARD_TYPE);
  if (!board || !text) return [];
  const uses = boardUses(text);
  const wired = wiredBoardPins(circuit);
  const usedPins = new Set();
  const missing = [];
  for (const use of uses) {
    const pin = ALIASES[use.name] ?? use.name;
    const bus = use.call && BUSES[use.name];
    if (bus) {
      bus.pins.forEach((p) => usedPins.add(p));
      const unwired = bus.pins.filter((p) => !wired.has(p));
      if (bus.need === 'all' && unwired.length > 0) missing.push({ use, pins: unwired });
      if (bus.need === 'any' && unwired.length === bus.pins.length) missing.push({ use, pins: unwired, either: true });
      continue;
    }
    if (use.call || !(pin in BOARD_PINS)) continue;
    usedPins.add(pin);
    if (!ON_BOARD.has(pin) && !wired.has(pin)) missing.push({ use, pins: [pin] });
  }
  if (missing.length === 0) return [];

  // Pins with something on them that the program never uses are probably where it meant to go.
  const spare = [...wired].filter((pin) => !usedPins.has(pin) && !ON_BOARD.has(pin));
  const hint = spare.length === 0 ? ''
    : ` ${listed(spare, 'and')} ${spare.length === 1 ? 'is' : 'are'} wired, but the code never uses ${spare.length === 1 ? 'it' : 'them'}.`;
  return missing.map(({ use, pins, either }) => {
    const names = pins.map((p) => PIN_NAMES[p] ?? p);
    const what = `board.${use.name}${use.call ? '()' : ''}`;
    return {
      severity: 'warning',
      part: board.id,
      pin: pins[0],
      file,
      line: use.line,
      message: `${file} line ${use.line} uses ${what}, but nothing is wired to ${listed(names, either ? 'or' : 'and')}.${hint}`,
    };
  });
}

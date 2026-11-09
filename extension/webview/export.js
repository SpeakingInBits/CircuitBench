// Turns the circuit into files: images of the build and the diagram, and a parts list.
import { definition, partBounds } from '../shared/catalog.js';
import { escapeXml, holePattern, partArt, partLabel, partTransform } from './art.js';
import { partValue, renderDiagram } from './diagram-art.js';
import { layoutDiagram } from './diagram-layout.js';
import { wirePath, wirePoints } from './editing.js';

const MARGIN = 12;
const WORKBENCH_COLOR = '#56636d';
const PNG_SCALE = 2;

// A diagram outside VS Code has no theme to borrow from, so it gets the colors of a printed page.
const DIAGRAM_STYLE = `text{font-family:sans-serif}
.d-line,.d-wire{fill:none;stroke:#222;stroke-width:1.4;stroke-linecap:round;stroke-linejoin:round}
.d-solid{fill:#222;stroke:none}.d-tint{stroke:none;fill-opacity:.55}
.d-body{fill:#f4f4f4;stroke:#222;stroke-width:1.4}.d-hit{fill:none;stroke:none}
.d-text{fill:#222;font-size:11px}.d-name{font-weight:600}.d-muted{fill:#666;font-size:10px}
.d-pin{font-family:monospace;font-size:10px}`;

function svgDocument(x, y, width, height, content) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="${x} ${y} ${width} ${height}">${content}</svg>`;
}

// The circuit as drawn on the canvas, showing the running state if there is one.
export function circuitImage(doc, viewOf = () => undefined) {
  const shown = doc.parts.map(partBounds);
  const bends = doc.wires.flatMap((wire) => wirePoints(doc, wire) ?? []);
  const left = Math.min(...shown.map((b) => b.x), ...bends.map((p) => p.x)) - MARGIN;
  const top = Math.min(...shown.map((b) => b.y), ...bends.map((p) => p.y)) - MARGIN;
  const right = Math.max(...shown.map((b) => b.x + b.w), ...bends.map((p) => p.x)) + MARGIN;
  const bottom = Math.max(...shown.map((b) => b.y + b.h), ...bends.map((p) => p.y)) + MARGIN;
  const width = right - left;
  const height = bottom - top;

  const group = (part) => `<g transform="${partTransform(part)}">${partArt(part, viewOf(part))}</g>`;
  const layer = (background) => doc.parts.filter((part) => !!definition(part.type).background === background).map(group).join('');
  const wires = doc.wires.map((wire) => {
    const d = wirePath(doc, wire);
    return d ? `<path d="${d}" fill="none" stroke="${escapeXml(wire.color)}" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round"/>` : '';
  }).join('');
  const content = `<defs>${holePattern()}</defs><rect x="${left}" y="${top}" width="${width}" height="${height}" fill="${WORKBENCH_COLOR}"/>`
    + layer(true) + layer(false) + wires + doc.parts.map(partLabel).join('');
  return { svg: svgDocument(left, top, width, height, content), width, height };
}

export function diagramImage(doc) {
  const model = layoutDiagram(doc);
  const content = `<style>${DIAGRAM_STYLE}</style><rect width="${model.width}" height="${model.height}" fill="#fff"/>${renderDiagram(model)}`;
  return { svg: svgDocument(0, 0, model.width, model.height, content), width: model.width, height: model.height };
}

// One row per kind of part, in the order they were placed, ending with the wires.
export function partsList(doc) {
  const rows = new Map();
  for (const part of doc.parts) {
    const entry = definition(part.type);
    if (entry.annotation) continue;
    const value = partValue(part);
    const key = `${part.type}:${value}`;
    if (!rows.has(key)) rows.set(key, { quantity: 0, name: entry.name, value, parts: [] });
    const row = rows.get(key);
    row.quantity++;
    row.parts.push(part.label || part.id);
  }
  const list = [...rows.values()];
  if (doc.wires.length > 0) list.push({ quantity: doc.wires.length, name: 'Jumper wire', value: '', parts: [] });
  return list;
}

// A spreadsheet treats a cell starting with these as a formula, and a label is free text.
const csvCell = (value) => {
  const text = String(value);
  const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

export function partsListCsv(doc) {
  const lines = [['Quantity', 'Part', 'Value', 'Used as']];
  for (const row of partsList(doc)) lines.push([row.quantity, row.name, row.value, row.parts.join(' ')]);
  return `${lines.map((line) => line.map(csvCell).join(',')).join('\r\n')}\r\n`;
}

async function toPng({ svg, width, height }) {
  const image = new Image();
  image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  await image.decode();
  const surface = document.createElement('canvas');
  surface.width = Math.ceil(width * PNG_SCALE);
  surface.height = Math.ceil(height * PNG_SCALE);
  surface.getContext('2d').drawImage(image, 0, 0, surface.width, surface.height);
  return surface.toDataURL('image/png').split(',')[1];
}

// A file's contents, for the extension to save.
export async function exportFile(format, doc, viewOf) {
  switch (format) {
    case 'circuit-svg': return { data: circuitImage(doc, viewOf).svg, encoding: 'utf8' };
    case 'circuit-png': return { data: await toPng(circuitImage(doc, viewOf)), encoding: 'base64' };
    case 'diagram-svg': return { data: diagramImage(doc).svg, encoding: 'utf8' };
    case 'diagram-png': return { data: await toPng(diagramImage(doc)), encoding: 'base64' };
    case 'parts-csv': return { data: partsListCsv(doc), encoding: 'utf8' };
    default: throw new Error(`Unknown export format ${format}`);
  }
}

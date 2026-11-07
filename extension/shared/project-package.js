// A whole project in one file, so a student can hand in their work or an instructor can share a
// starting point. It is JSON, with each file's bytes in base64, so it needs no zip library.
//
// A package can come from anyone, so nothing in it is trusted: every path is checked before the
// extension writes to disk. Dot files are refused, which keeps out .vscode tasks and settings.
import { circuitProblem } from './catalog.js';

// Packages saved before the extension was renamed keep the old extension and format, and still open.
export const PACKAGE_EXTENSIONS = ['circuitbench', 'metrosim'];
export const MAX_PACKAGE_BYTES = 8 * 1024 * 1024;

const FORMAT = 'circuit-bench-project';
const OLD_FORMAT = 'metro-simulator-project';
const VERSION = 1;
const MAX_PROJECT_BYTES = 2 * 1024 * 1024;
const DEFAULT_NAME = 'imported-project';
const CIRCUIT_FILE = 'circuit.json';
const UNSAFE_CHARACTERS = /[<>:"/\\|?*\u0000-\u001f]/;
const RESERVED_NAME = /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i;

// Whether a file or folder name is safe to create on Windows, macOS and Linux.
export function isSafeName(name) {
  return typeof name === 'string' && name.length > 0 && name.length <= 100 && !name.startsWith('.')
    && !/[. ]$/.test(name) && !UNSAFE_CHARACTERS.test(name) && !RESERVED_NAME.test(name);
}

const isSafePath = (path) => typeof path === 'string' && path.split('/').every(isSafeName) && path.toLowerCase() !== CIRCUIT_FILE;

// `files` maps paths to their contents, as readProjectFiles gives them.
export function createPackage({ name, circuit, files }) {
  const encoded = {};
  for (const [path, data] of Object.entries(files)) encoded[path.replace(/^\//, '')] = Buffer.from(data).toString('base64');
  return JSON.stringify({ format: FORMAT, version: VERSION, name, circuit, files: encoded });
}

// Checks a package and returns { name, circuit, files }, or throws with what is wrong with it.
export function readPackage(text) {
  let bundle;
  try {
    bundle = JSON.parse(text);
  } catch {
    throw new Error('This is not a project package.');
  }
  if (bundle?.format !== FORMAT && bundle?.format !== OLD_FORMAT) throw new Error('This is not a project package.');
  if (bundle.version !== VERSION) throw new Error('This package needs a newer version of the simulator.');
  const problem = circuitProblem(bundle.circuit);
  if (problem) throw new Error(`The package's circuit cannot be used. ${problem}`);
  if (typeof bundle.files !== 'object' || bundle.files === null) throw new Error('The package has no files.');

  const files = [];
  let total = 0;
  for (const [path, encoded] of Object.entries(bundle.files)) {
    if (!isSafePath(path) || typeof encoded !== 'string') throw new Error(`The package has an unsafe file: ${JSON.stringify(path)}.`);
    const data = Buffer.from(encoded, 'base64');
    total += data.length;
    if (total > MAX_PROJECT_BYTES) throw new Error('The package is larger than the 2MB CIRCUITPY drive.');
    files.push({ path, data });
  }
  return { name: isSafeName(bundle.name) ? bundle.name : DEFAULT_NAME, circuit: bundle.circuit, files };
}

// VS Code entry point. Everything simulated lives in sim/, and the UI lives in webview/.
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vscode = require('vscode');

const CIRCUIT_FILE = 'circuit.json';
const DIAGRAM_VIEW = 'circuitBench.diagram';
const START_VIEW = 'circuitBench.start';
const IGNORED = new Set(['.git', '.vscode', 'typings', 'node_modules', '__pycache__', CIRCUIT_FILE]);
const MAX_PROJECT_BYTES = 2 * 1024 * 1024;
const MAX_TRACEBACK_CHARS = 20000;
const MISSING_LIBRARY = 'missing-library';
const SAVE_DELAY_MS = 300;

// Everything Export can save. `suffix` keeps a project's files apart in one folder.
const EXPORTS = [
  { format: 'package', label: 'Project package', detail: 'The program, circuit and libraries in one file. Open it with Import.', extension: 'circuitbench', suffix: '' },
  { format: 'circuit-png', label: 'Circuit picture (PNG)', detail: 'The build as it looks on the canvas.', extension: 'png', suffix: '-circuit' },
  { format: 'circuit-svg', label: 'Circuit picture (SVG)', detail: 'The same, and it stays sharp at any size.', extension: 'svg', suffix: '-circuit' },
  { format: 'diagram-png', label: 'Circuit diagram (PNG)', detail: 'The schematic, on a white page.', extension: 'png', suffix: '-diagram' },
  { format: 'diagram-svg', label: 'Circuit diagram (SVG)', detail: 'The same, and it stays sharp at any size.', extension: 'svg', suffix: '-diagram' },
  { format: 'parts-csv', label: 'Parts list (CSV)', detail: 'What to gather to build it, for a spreadsheet.', extension: 'csv', suffix: '-parts' },
];

// Libraries each library needs in order to import.
const LIBRARY_NEEDS = {
  adafruit_character_lcd: ['adafruit_bus_device', 'adafruit_mcp230xx'],
  adafruit_displayio_ssd1306: ['adafruit_display_text'],
  adafruit_ds18x20: ['adafruit_onewire'],
  adafruit_ds3231: ['adafruit_bus_device', 'adafruit_register'],
  adafruit_max7219: ['adafruit_bus_device', 'adafruit_framebuf'],
  adafruit_mcp9808: ['adafruit_bus_device', 'adafruit_register'],
  adafruit_mpu6050: ['adafruit_bus_device', 'adafruit_register'],
  adafruit_ssd1306: ['adafruit_bus_device', 'adafruit_framebuf'],
  adafruit_74hc595: ['adafruit_bus_device'],
  neopixel: ['adafruit_pixelbuf'],
};

let session;

function readProjectFiles(folder, activeDocument) {
  const files = {};
  let total = 0;
  const walk = (directory, prefix) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (IGNORED.has(entry.name) || entry.name.startsWith('.')) continue;
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(full, `${prefix}/${entry.name}`);
      } else {
        const data = fs.readFileSync(full);
        total += data.length;
        if (total > MAX_PROJECT_BYTES) throw new Error('This project is larger than the 2MB CIRCUITPY drive.');
        files[`${prefix}/${entry.name}`] = data;
      }
    }
  };
  walk(folder, '');
  // Whatever Python file is open runs as the program, as if saved to the board as code.py.
  if (activeDocument?.languageId === 'python') files['/code.py'] = activeDocument.getText();
  return files;
}

const sameFolder = (a, b) => path.relative(a, b) === '';

function isInside(folder, file) {
  const relative = path.relative(folder, file);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

// A file the board reads, the same way readProjectFiles chooses them.
function isBoardFile(folder, file) {
  return isInside(folder, file) && path.relative(folder, file).split(path.sep).every((name) => !IGNORED.has(name) && !name.startsWith('.'));
}

// The project is the nearest folder holding a circuit or a program, so a file in lib/ or .vscode/
// still belongs to the project around it. A button on an editor passes that editor's file, which
// matters for circuit.json: its diagram is not a text editor.
function projectFolder(resource) {
  const document = vscode.window.activeTextEditor?.document;
  const fromButton = resource instanceof vscode.Uri;
  const uri = fromButton ? resource : document?.uri;
  const current = session?.folder ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (uri?.scheme !== 'file') return current;
  const start = path.dirname(uri.fsPath);
  const workspace = vscode.workspace.getWorkspaceFolder(uri)?.uri.fsPath;
  if (workspace) {
    for (let folder = start; ; folder = path.dirname(folder)) {
      if (fs.existsSync(path.join(folder, CIRCUIT_FILE)) || fs.existsSync(path.join(folder, 'code.py'))) return folder;
      if (sameFolder(folder, workspace)) break;
    }
  }
  const isProjectFile = path.basename(uri.fsPath) === CIRCUIT_FILE
    || (fromButton ? uri.fsPath.endsWith('.py') : document.languageId === 'python');
  return isProjectFile ? start : current;
}

// Explains what to do when there is no folder to work in, and offers to do it.
async function noProject() {
  const actions = {
    'New Project from Example': 'circuitBench.newProject',
    'Open Folder': 'workbench.action.files.openFolder',
    'Import Project Package': 'circuitBench.importPackage',
  };
  const answer = await vscode.window.showWarningMessage('Open a project folder first, or start a new project.', ...Object.keys(actions));
  if (answer) await vscode.commands.executeCommand(actions[answer]);
}

// Everything the board will read from disk has to include what the student just typed.
async function saveProjectFiles(folder) {
  for (const document of vscode.workspace.textDocuments) {
    const { fsPath } = document.uri;
    if (document.isDirty && document.uri.scheme === 'file' && isInside(folder, fsPath) && path.basename(fsPath) !== CIRCUIT_FILE) {
      await document.save();
    }
  }
}

function pageHtml(context, webview, page) {
  const webviewRoot = webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'webview'));
  return fs.readFileSync(path.join(context.extensionPath, 'webview', page), 'utf8')
    .replaceAll('{{nonce}}', crypto.randomBytes(16).toString('hex'))
    .replaceAll('{{cspSource}}', webview.cspSource)
    .replaceAll('{{webviewRoot}}', webviewRoot.toString());
}

class Session {
  constructor(context) {
    this.context = context;
    this.folder = undefined;
    this.panel = undefined;
    this.ready = undefined;
    this.board = undefined;
    this.document = undefined;
    this.nvm = undefined;
    this.circuitError = undefined;
    this.pendingSave = undefined;
    this.queue = Promise.resolve();
    this.pendingReplies = new Map();
    this.nextRequest = 1;
    // Where the last run's files came from, to find the files its tracebacks name.
    this.program = undefined;
    this.diagnostics = vscode.languages.createDiagnosticCollection('CircuitPython');
    context.subscriptions.push(this.diagnostics);
  }

  post(message) {
    this.panel?.webview.postMessage(message);
  }

  circuitPath() {
    return path.join(this.folder, CIRCUIT_FILE);
  }

  // A project may not have a circuit yet. One that exists but cannot be used sets circuitError,
  // and is then left alone so the student can repair it.
  async readCircuit() {
    this.circuitError = undefined;
    try {
      const circuit = JSON.parse(fs.readFileSync(this.circuitPath(), 'utf8'));
      const { circuitProblem } = await import('./shared/catalog.js');
      this.circuitError = circuitProblem(circuit) ?? undefined;
      return this.circuitError ? undefined : circuit;
    } catch (error) {
      if (error.code !== 'ENOENT') this.circuitError = error.message;
      return undefined;
    }
  }

  showCircuitError() {
    const action = `Open ${CIRCUIT_FILE}`;
    vscode.window.showErrorMessage(`${CIRCUIT_FILE} needs fixing before it can be used: ${this.circuitError}`, action).then((answer) => {
      if (answer === action) vscode.window.showTextDocument(vscode.Uri.file(this.circuitPath()));
    });
  }

  async loadCircuit() {
    this.circuit = await this.readCircuit();
    this.post({ type: 'load', circuit: this.circuit, error: this.circuitError });
    this.sendProgram();
    if (this.circuitError) this.showCircuitError();
  }

  saveCircuit(circuit) {
    if (this.circuitError) return;
    this.circuit = circuit;
    clearTimeout(this.saveTimer);
    // The file is chosen now, because the project can change before the timer fires.
    this.pendingSave = { file: this.circuitPath(), circuit };
    this.saveTimer = setTimeout(() => this.flushSave(), SAVE_DELAY_MS);
  }

  flushSave() {
    clearTimeout(this.saveTimer);
    const pending = this.pendingSave;
    this.pendingSave = undefined;
    if (!pending) return;
    try {
      fs.writeFileSync(pending.file, `${JSON.stringify(pending.circuit, null, 2)}\n`);
    } catch (error) {
      vscode.window.showErrorMessage(`Could not save the circuit: ${error.message}`);
    }
  }

  // Remembers the program, because no text editor is active while the panel has focus.
  noteEditor(editor) {
    const document = editor?.document;
    if (document?.languageId === 'python' && document.uri.scheme === 'file') {
      this.document = document;
      this.sendProgram();
    }
  }

  // The open Python file runs as code.py, if it sits at the top of this project.
  programDocument() {
    const { document } = this;
    if (!document || document.isClosed) return undefined;
    return sameFolder(this.folder, path.dirname(document.uri.fsPath)) ? document : undefined;
  }

  // The page compares the program with the circuit, so it gets the program whenever that may have
  // changed: the open Python file at the top of the project, or else code.py.
  sendProgram() {
    if (!this.panel || !this.folder) return;
    const document = this.programDocument();
    const file = document?.uri.fsPath ?? path.join(this.folder, 'code.py');
    let text = document?.getText();
    try {
      text ??= fs.readFileSync(file, 'utf8');
    } catch {
      // No code.py yet, so there is nothing to compare.
    }
    this.programPath = text === undefined ? undefined : file;
    this.post({ type: 'program', text: text ?? '', file: path.basename(file) });
  }

  // Opens the program at a line the Problems tab points to, beside the panel.
  async showLine(line) {
    if (!this.programPath) return;
    const document = await vscode.workspace.openTextDocument(this.programPath);
    const shown = vscode.window.visibleTextEditors.find((editor) => editor.document === document);
    const start = new vscode.Position(Math.max(0, line - 1), 0);
    await vscode.window.showTextDocument(document, {
      viewColumn: shown?.viewColumn ?? vscode.ViewColumn.One,
      selection: new vscode.Range(start, start),
    });
  }

  // Like a real board, saving a file the program reads restarts a running program with it.
  async onDocumentSaved(document) {
    if (!this.panel || !this.folder || document.uri.scheme !== 'file') return;
    if (document.languageId === 'python') this.sendProgram();
    const file = document.uri.fsPath;
    if (sameFolder(file, this.circuitPath())) {
      await this.stop();
      await this.loadCircuit();
    } else if (this.board && isBoardFile(this.folder, file)) {
      await this.reload(this.board);
    }
  }

  // Run saves files itself, and by the time those saves come back here it has started another
  // board, so they do not start it again.
  reload(board) {
    return this.enqueue(async () => {
      if (this.board === board) await this.startBoard('\nCode saved, reloading.\nsoft reboot\n\n');
    });
  }

  async open(folder) {
    if (!folder) {
      noProject();
      return false;
    }
    if (this.panel && this.folder === folder && !this.circuitError) {
      this.panel.reveal(undefined, true);
      await this.ready;
      return true;
    }
    this.flushSave();
    if (this.panel && this.folder !== folder) await this.stop();
    this.folder = folder;
    if (this.panel) {
      this.panel.reveal(undefined, true);
      await this.ready;
    } else {
      this.panel = vscode.window.createWebviewPanel('circuitBench', 'Circuit Simulator', {
        viewColumn: vscode.ViewColumn.Beside, preserveFocus: true,
      }, {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [this.context.extensionUri],
      });
      this.ready = new Promise((resolve) => { this.markReady = resolve; });
      this.panel.webview.onDidReceiveMessage((message) => this.onMessage(message));
      this.panel.onDidDispose(() => {
        this.flushSave();
        this.stop();
        this.panel = undefined;
      });
      this.panel.webview.html = pageHtml(this.context, this.panel.webview, 'index.html');
      await this.ready;
    }
    await this.loadCircuit();
    return true;
  }

  async showDiagram(folder) {
    if (await this.open(folder)) this.post({ type: 'showDiagram' });
  }

  onMessage(message) {
    switch (message.type) {
      case 'ready': this.markReady(); break;
      case 'save': this.saveCircuit(message.circuit); break;
      case 'run': this.run(); break;
      case 'stop': this.stop(); break;
      case 'input': this.board?.write(message.text); break;
      case 'control': this.board?.setControl(message.part, message.control, message.value); break;
      case 'export': this.exportProject(); break;
      case 'showLine': this.showLine(message.line); break;
      case 'import': vscode.commands.executeCommand('circuitBench.importPackage'); break;
      case 'openFrame': this.openFrame(message.file, message.line); break;
      case 'addLibrary': this.addMissingLibrary(message.name); break;
      case 'reply':
        this.pendingReplies.get(message.id)?.(message.result);
        this.pendingReplies.delete(message.id);
        break;
      default: break;
    }
  }

  // Starting and stopping take turns. Otherwise a double click could start a second board that
  // nothing holds on to, and so nothing could stop.
  enqueue(task) {
    this.queue = this.queue.then(task).catch((error) => {
      vscode.window.showErrorMessage(`Simulator error: ${error?.message ?? error}`);
    });
    return this.queue;
  }

  stop() {
    return this.enqueue(async () => {
      await this.releaseBoard();
      this.post({ type: 'running', running: false });
    });
  }

  run() {
    return this.enqueue(() => this.startBoard());
  }

  async releaseBoard() {
    const { board } = this;
    this.board = undefined;
    // Messages still on their way from the old board must not reach the new run.
    board?.removeAllListeners();
    await board?.stop();
  }

  // A reload keeps what the console showed, as a real board does, and adds `notice` to it.
  async startBoard(notice) {
    if (!this.panel) return;
    if (this.circuitError) {
      this.showCircuitError();
      return;
    }
    this.noteEditor(vscode.window.activeTextEditor);
    await saveProjectFiles(this.folder);
    let files;
    try {
      files = readProjectFiles(this.folder, this.programDocument());
    } catch (error) {
      vscode.window.showErrorMessage(error.message);
      return;
    }
    if (!files['/code.py']) {
      vscode.window.showWarningMessage('This project has no code.py. Open a Python file to run it.');
      return;
    }
    const { Board } = await import('./sim/board-host.js');
    const { emptyCircuit } = await import('./shared/catalog.js');
    const { SerialFilter } = await import('./webview/serial-text.js');
    const { parseTracebacks } = await import('./shared/traceback.js');
    await this.releaseBoard();
    this.post(notice ? { type: 'serial', text: notice } : { type: 'clearConsole' });
    // Error marks, and the offer to add a library, are about the program being replaced. A reload
    // keeps the console, so the offer is taken back separately.
    this.diagnostics.clear();
    if (notice) this.post({ type: 'libraryHint' });
    this.program = {
      folder: this.folder,
      uri: this.programDocument()?.uri ?? vscode.Uri.file(path.join(this.folder, 'code.py')),
    };
    const board = new Board({
      files,
      circuit: this.circuit ?? emptyCircuit(),
      nvm: this.nvm,
    });
    this.board = board;
    const forward = (type) => board.on(type, (message) => this.post(message));
    // Output not yet part of a traceback that has been reported.
    const output = new SerialFilter();
    let unread = '';
    board.on('serial', (text) => {
      this.post({ type: 'serial', text });
      unread = (unread + output.push(text).text).slice(-MAX_TRACEBACK_CHARS);
      const traceback = parseTracebacks(unread).at(-1);
      if (!traceback) return;
      unread = unread.slice(traceback.end);
      this.reportTraceback(traceback, board).catch((error) => console.error(error));
    });
    ['frame', 'audioStart', 'audio', 'audioStop'].forEach(forward);
    board.on('nvm', ({ data }) => { this.nvm = data; });
    board.on('reset', () => this.run());
    board.on('crash', (text) => this.post({ type: 'serial', text: `\n[Simulator error] ${text}\n` }));
    this.post({ type: 'running', running: true });
  }

  // The project file a traceback names. The program runs as code.py whatever its own name is,
  // and libraries the board only has compiled have no file to show.
  frameUri(file) {
    if (!this.program) return undefined;
    const relative = file.replace(/^\/+/, '');
    if (relative === 'code.py') return this.program.uri;
    const full = path.join(this.program.folder, ...relative.split('/'));
    return isInside(this.program.folder, full) && fs.existsSync(full) ? vscode.Uri.file(full) : undefined;
  }

  // Marks where the program stopped: the deepest line in the project, and the line in the
  // program that led there, which is the one a student is most likely to need to change.
  async reportTraceback(traceback, board) {
    if (traceback.type === 'KeyboardInterrupt') return;
    const { missingModule } = await import('./shared/traceback.js');
    const places = traceback.frames.map((frame) => ({ ...frame, uri: this.frameUri(frame.file) })).filter((frame) => frame.uri);
    const deepest = places.at(-1);
    if (!deepest) return;
    const fromProgram = places.findLast((place) => place.uri.toString() === this.program.uri.toString());
    const library = missingModule(traceback);
    const offer = library && fs.existsSync(libraryPath(this.context, library)) ? library : undefined;
    let text = traceback.message ? `${traceback.type}: ${traceback.message}` : traceback.type;
    if (offer) text += `. The ${offer} library is not in this project's lib folder.`;
    const rangeOf = async ({ uri, line }) => {
      const document = await vscode.workspace.openTextDocument(uri);
      const row = document.lineAt(Math.min(Math.max(line - 1, 0), document.lineCount - 1));
      return new vscode.Range(row.lineNumber, row.firstNonWhitespaceCharacterIndex, row.lineNumber, row.text.length);
    };
    const marked = [deepest];
    if (fromProgram && fromProgram !== deepest) marked.push(fromProgram);
    const located = await Promise.all(marked.map(async (place) => new vscode.Location(place.uri, await rangeOf(place))));
    if (this.board !== board) return;
    const where = `${path.basename(deepest.uri.fsPath)}, line ${deepest.line}`;
    const entries = located.map((location, i) => {
      const diagnostic = new vscode.Diagnostic(location.range, i === 0 ? text : `${text} (in ${where})`, vscode.DiagnosticSeverity.Error);
      diagnostic.source = 'CircuitPython';
      if (offer) diagnostic.code = MISSING_LIBRARY;
      const other = located[1 - i];
      if (other) diagnostic.relatedInformation = [new vscode.DiagnosticRelatedInformation(other, i === 0 ? 'Called from here' : 'The error happened here')];
      return [location.uri, [diagnostic]];
    });
    // Entries for the same file are merged.
    this.diagnostics.clear();
    this.diagnostics.set(entries);
    this.post({ type: 'libraryHint', name: offer });
  }

  // Opens the file a console link names, beside the panel rather than in place of it.
  async openFrame(file, line) {
    const uri = this.frameUri(file);
    if (!uri) {
      vscode.window.showInformationMessage(`${file} is not a file in this project, so it cannot be opened. It is probably part of a library.`);
      return;
    }
    const editors = vscode.window.visibleTextEditors;
    const viewColumn = editors.find((editor) => editor.document.uri.toString() === uri.toString())?.viewColumn
      ?? editors[0]?.viewColumn ?? vscode.ViewColumn.One;
    const position = new vscode.Position(Math.max(line - 1, 0), 0);
    await vscode.window.showTextDocument(uri, { viewColumn, selection: new vscode.Range(position, position) });
  }

  async addMissingLibrary(name) {
    if (await addLibrary(this.context, name, this.program?.folder ?? this.folder)) this.post({ type: 'libraryHint' });
  }

  // Sends the page a message and waits for its reply.
  ask(message) {
    const id = this.nextRequest++;
    return new Promise((resolve) => {
      this.pendingReplies.set(id, resolve);
      this.post({ ...message, id });
    });
  }

  // Used by the automated tests to drive the page.
  testStep(step) {
    return this.ask({ type: 'test', step });
  }

  async packageText() {
    const { createPackage } = await import('./shared/project-package.js');
    const { emptyCircuit } = await import('./shared/catalog.js');
    this.flushSave();
    await saveProjectFiles(this.folder);
    const circuit = await this.readCircuit();
    return createPackage({ name: path.basename(this.folder), circuit: circuit ?? emptyCircuit(), files: readProjectFiles(this.folder) });
  }

  // Writes one kind of export. The page draws everything except the package, which is read from disk.
  async exportTo(format, file) {
    if (format === 'package') {
      fs.writeFileSync(file, await this.packageText());
      return;
    }
    const reply = await this.ask({ type: 'export', format });
    if (reply.error) throw new Error(reply.error);
    fs.writeFileSync(file, Buffer.from(reply.data, reply.encoding));
  }

  async exportProject() {
    if (this.circuitError) {
      this.showCircuitError();
      return;
    }
    const pick = await vscode.window.showQuickPick(EXPORTS, { placeHolder: 'What would you like to save?' });
    if (!pick) return;
    const name = `${path.basename(this.folder)}${pick.suffix}.${pick.extension}`;
    const target = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(path.join(this.folder, name)),
      filters: { [pick.label]: [pick.extension] },
    });
    if (!target) return;
    try {
      await this.exportTo(pick.format, target.fsPath);
      vscode.window.showInformationMessage(`Saved ${path.basename(target.fsPath)}.`);
    } catch (error) {
      vscode.window.showErrorMessage(`Could not export: ${error.message}`);
    }
  }
}

// Opens circuit.json as a diagram. It reads the file through VS Code, so it follows the builder's
// saves and any typing in a text editor, and the file stays the only copy of the circuit.
class DiagramEditor {
  constructor(context) {
    this.context = context;
    this.shown = undefined; // What the page last drew, for the automated tests.
  }

  resolveCustomTextEditor(document, panel) {
    const { webview } = panel;
    const send = () => webview.postMessage({ type: 'load', text: document.getText() });
    webview.options = { enableScripts: true, localResourceRoots: [this.context.extensionUri] };
    const changes = vscode.workspace.onDidChangeTextDocument((event) => {
      if (event.document === document) send();
    });
    panel.onDidDispose(() => changes.dispose());
    webview.onDidReceiveMessage((message) => {
      switch (message.type) {
        case 'ready': send(); break;
        case 'shown': this.shown = message; break;
        case 'edit': session.open(path.dirname(document.uri.fsPath)); break;
        case 'text': vscode.commands.executeCommand('vscode.openWith', document.uri, 'default'); break;
        default: break;
      }
    });
    webview.html = pageHtml(this.context, webview, 'diagram.html');
  }
}

function copyFolder(from, to) {
  fs.mkdirSync(to, { recursive: true });
  fs.cpSync(from, to, { recursive: true });
}

function libraryPath(context, name) {
  const base = path.join(context.extensionPath, 'libs', name);
  return fs.existsSync(`${base}.mpy`) ? `${base}.mpy` : base;
}

function installLibrary(context, folder, name, seen = new Set()) {
  if (seen.has(name)) return;
  seen.add(name);
  const source = libraryPath(context, name);
  if (fs.existsSync(source)) {
    const target = path.join(folder, 'lib', path.basename(source));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.cpSync(source, target, { recursive: true });
  }
  for (const needed of LIBRARY_NEEDS[name] ?? []) installLibrary(context, folder, needed, seen);
}

async function newProject(context) {
  const examples = path.join(context.extensionPath, 'examples');
  const picks = fs.readdirSync(examples).map((name) => {
    const info = JSON.parse(fs.readFileSync(path.join(examples, name, 'example.json'), 'utf8'));
    return { label: info.title, detail: info.description, name, libraries: info.libraries ?? [] };
  });
  const pick = await vscode.window.showQuickPick(picks, { placeHolder: 'Choose a starting project' });
  if (!pick) return;
  const parent = await vscode.window.showOpenDialog({
    canSelectFolders: true, canSelectFiles: false, openLabel: 'Create project here',
  });
  if (!parent) return;
  const target = path.join(parent[0].fsPath, pick.name);
  if (fs.existsSync(target)) {
    vscode.window.showErrorMessage(`${target} already exists.`);
    return;
  }
  copyFolder(path.join(examples, pick.name), target);
  fs.rmSync(path.join(target, 'example.json'));
  for (const library of pick.libraries) installLibrary(context, target, library);
  await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(target));
}

// Writes a package out as a new folder and returns it. Nothing in the package runs, and it can
// only add files under the new folder.
async function unpackProject(file, parent) {
  const { MAX_PACKAGE_BYTES, readPackage } = await import('./shared/project-package.js');
  if (fs.statSync(file).size > MAX_PACKAGE_BYTES) throw new Error('This file is too large to be a project package.');
  const { name, circuit, files } = readPackage(fs.readFileSync(file, 'utf8'));
  const target = path.join(parent, name);
  if (fs.existsSync(target)) throw new Error(`${target} already exists.`);
  for (const { path: relative, data } of files) {
    const destination = path.join(target, ...relative.split('/'));
    if (!isInside(target, destination)) throw new Error(`The package has an unsafe file: ${relative}.`);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, data);
  }
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, CIRCUIT_FILE), `${JSON.stringify(circuit, null, 2)}\n`);
  return target;
}

async function importPackage() {
  const { PACKAGE_EXTENSIONS } = await import('./shared/project-package.js');
  const files = await vscode.window.showOpenDialog({
    canSelectMany: false, openLabel: 'Import', filters: { 'Project package': PACKAGE_EXTENSIONS },
  });
  if (!files) return;
  const parent = await vscode.window.showOpenDialog({
    canSelectFolders: true, canSelectFiles: false, openLabel: 'Create project here',
  });
  if (!parent) return;
  try {
    const target = await unpackProject(files[0].fsPath, parent[0].fsPath);
    await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(target));
  } catch (error) {
    vscode.window.showErrorMessage(`Could not import: ${error.message}`);
  }
}

// Copies a library into the project, asking which one unless it is given. Returns whether it did.
async function addLibrary(context, name, folder = projectFolder()) {
  if (!folder) {
    noProject();
    return false;
  }
  const libs = path.join(context.extensionPath, 'libs');
  const names = fs.readdirSync(libs).map((entry) => entry.replace(/\.mpy$/, '')).sort();
  const pick = names.includes(name) ? name : await vscode.window.showQuickPick(names, { placeHolder: 'Library to copy into this project\'s lib folder' });
  if (!pick) return false;
  installLibrary(context, folder, pick);
  vscode.window.showInformationMessage(`Added ${pick} to ${path.join(folder, 'lib')}.`);
  return true;
}

// Offers to add the library an ImportError names, from the light bulb and the Problems tab.
const missingLibraryFixes = {
  provideCodeActions(document, range, { diagnostics }) {
    return diagnostics.filter((diagnostic) => diagnostic.code === MISSING_LIBRARY).map((diagnostic) => {
      const name = diagnostic.message.match(/no module named '([^']+)'/)?.[1];
      const action = new vscode.CodeAction(`Add the ${name} library to this project`, vscode.CodeActionKind.QuickFix);
      action.command = { command: 'circuitBench.addLibrary', title: action.title, arguments: [name] };
      action.diagnostics = [diagnostic];
      action.isPreferred = true;
      return action;
    });
  },
};

// Copies CircuitPython's type stubs into the project so Pylance can offer autocomplete.
function setupEditor(context) {
  const folder = projectFolder();
  if (!folder) {
    noProject();
    return;
  }
  const stubs = path.join(context.extensionPath, 'stubs');
  if (fs.existsSync(stubs)) fs.cpSync(stubs, path.join(folder, 'typings'), { recursive: true });
  const settingsPath = path.join(folder, '.vscode', 'settings.json');
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  let settings = {};
  if (fs.existsSync(settingsPath)) {
    try {
      settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    } catch {
      // Settings files can hold comments, which rewriting this one would lose.
      const action = 'Open settings.json';
      vscode.window.showWarningMessage('Autocomplete is nearly set up. This settings.json has comments or errors, so it was left alone. Add "python.analysis.extraPaths": ["lib"] to it yourself.', action).then((answer) => {
        if (answer === action) vscode.window.showTextDocument(vscode.Uri.file(settingsPath));
      });
      return;
    }
  }
  settings['python.analysis.extraPaths'] = [...new Set([].concat(settings['python.analysis.extraPaths'] ?? [], 'lib'))];
  settings['python.analysis.diagnosticSeverityOverrides'] = {
    ...settings['python.analysis.diagnosticSeverityOverrides'], reportMissingModuleSource: 'none',
  };
  fs.writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
  vscode.window.showInformationMessage('CircuitPython autocomplete is set up. Install the Python extension if you have not already.');
}

function findBoardDrive() {
  const candidates = [];
  if (process.platform === 'win32') {
    for (let letter = 68; letter <= 90; letter++) candidates.push(`${String.fromCharCode(letter)}:\\`);
  } else if (process.platform === 'darwin') {
    candidates.push('/Volumes/CIRCUITPY');
  } else {
    candidates.push(`/media/${os.userInfo().username}/CIRCUITPY`, `/run/media/${os.userInfo().username}/CIRCUITPY`);
  }
  return candidates.find((drive) => fs.existsSync(path.join(drive, 'boot_out.txt')));
}

async function copyToBoard() {
  const folder = projectFolder();
  if (!folder) {
    noProject();
    return;
  }
  const drive = findBoardDrive();
  if (!drive) {
    vscode.window.showWarningMessage('No CIRCUITPY drive found. Plug in your board with a data USB cable.');
    return;
  }
  const answer = await vscode.window.showWarningMessage(`Copy this project to ${drive}? Files with the same names will be replaced.`, { modal: true }, 'Copy');
  if (answer !== 'Copy') return;
  const files = readProjectFiles(folder);
  for (const [file, data] of Object.entries(files)) {
    const target = path.join(drive, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, data);
  }
  vscode.window.showInformationMessage(`Copied ${Object.keys(files).length} files to ${drive}.`);
}

function activate(context) {
  session = new Session(context);
  const diagramEditor = new DiagramEditor(context);
  session.noteEditor(vscode.window.activeTextEditor);
  const command = (id, handler) => context.subscriptions.push(vscode.commands.registerCommand(id, handler));
  command('circuitBench.open', (resource) => session.open(projectFolder(resource)));
  command('circuitBench.diagram', () => session.showDiagram(projectFolder()));
  command('circuitBench.run', async () => {
    if (await session.open(projectFolder())) await session.run();
  });
  command('circuitBench.stop', () => session.stop());
  command('circuitBench.newProject', () => newProject(context));
  // A name comes from the fix for a missing library. A menu would pass something else.
  command('circuitBench.addLibrary', (name) => addLibrary(context, typeof name === 'string' ? name : undefined));
  command('circuitBench.setupEditor', () => setupEditor(context));
  command('circuitBench.copyToBoard', copyToBoard);
  command('circuitBench.export', async () => {
    if (await session.open(projectFolder())) await session.exportProject();
  });
  command('circuitBench.importPackage', importPackage);
  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(DIAGRAM_VIEW, diagramEditor),
    // The Start view is all buttons. Its welcome text shows while this tree stays empty.
    vscode.window.registerTreeDataProvider(START_VIEW, { getChildren: () => [], getTreeItem: (item) => item }),
    vscode.window.onDidChangeActiveTextEditor((editor) => session.noteEditor(editor)),
    vscode.workspace.onDidSaveTextDocument((document) => session.onDocumentSaved(document)),
    // An error mark is out of date as soon as its file changes.
    vscode.workspace.onDidChangeTextDocument((event) => {
      if (event.contentChanges.length > 0) session.diagnostics.delete(event.document.uri);
    }),
    vscode.languages.registerCodeActionsProvider({ language: 'python', scheme: 'file' }, missingLibraryFixes, {
      providedCodeActionKinds: [vscode.CodeActionKind.QuickFix],
    }),
    {
      dispose() {
        session.flushSave();
        session.stop();
      },
    },
  );
  return { session, diagramEditor, unpackProject };
}

module.exports = { activate };

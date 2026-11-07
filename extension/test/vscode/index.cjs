// End-to-end test run inside a real VS Code window with `Code --extensionTestsPath`. It builds
// a circuit through the page's own controls, runs a program and checks the page reacts.
const fs = require('node:fs');
const path = require('node:path');
const vscode = require('vscode');

const CODE = `import analogio, board, digitalio, pwmio, time
led = digitalio.DigitalInOut(board.D5)
led.direction = digitalio.Direction.OUTPUT
button = digitalio.DigitalInOut(board.D2)
button.switch_to_input(pull=digitalio.Pull.UP)
pot = analogio.AnalogIn(board.A0)
print("READY")
last = None
while True:
    led.value = not button.value
    value = pot.value >> 4
    if last is None or abs(value - last) > 20:
        print("POT", value)
        last = value
    time.sleep(0.02)
`;

const TICKING_CODE = `import time
count = 0
while True:
    count += 1
    print("TICK", count)
    time.sleep(0.03)
`;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const pinOf = (doc, id, pin, catalog) => {
  const part = doc.parts.find((p) => p.id === id);
  const definition = catalog.definition(part.type).pins.find((p) => p.id === pin);
  return catalog.pinPosition(part, definition);
};

async function waitForDiagram(step, ready) {
  let shown;
  for (let i = 0; i < 100; i++) {
    ({ diagram: shown } = await step({ action: 'read' }));
    if (shown && ready(shown)) return shown;
    await sleep(100);
  }
  throw new Error(`The diagram never showed what was expected: ${JSON.stringify(shown)}`);
}

async function waitForFileDiagram(diagramEditor, ready) {
  for (let i = 0; i < 100; i++) {
    if (diagramEditor.shown && ready(diagramEditor.shown)) return diagramEditor.shown;
    await sleep(100);
  }
  throw new Error(`The file's diagram never showed what was expected: ${JSON.stringify(diagramEditor.shown)}`);
}

// The open circuit diagram, which fails the test if circuit.json opened some other way.
async function diagramTab() {
  for (let i = 0; i < 50; i++) {
    const tab = vscode.window.tabGroups.all.flatMap((group) => group.tabs).find((item) => item.input?.viewType === 'circuitBench.diagram');
    if (tab) return tab;
    await sleep(100);
  }
  throw new Error('circuit.json did not open as a diagram');
}

async function waitFor3d(step, ready) {
  for (let i = 0; i < 100; i++) {
    const { view3d } = await step({ action: 'read' });
    if (view3d?.frames > 0 && view3d.artDrawn > 0 && ready(view3d)) return view3d;
    await sleep(100);
  }
  throw new Error('The 3D view never drew what was expected');
}

async function run() {
  const folder = process.env.SIM_TEST_FOLDER;
  const output = process.env.SIM_TEST_OUTPUT;
  const holdMs = Number(process.env.SIM_TEST_HOLD_MS ?? 0);
  const report = { vscode: vscode.version, node: process.versions.node, steps: {} };
  try {
    const file = path.join(folder, 'code.py');
    fs.writeFileSync(file, CODE);
    const document = await vscode.workspace.openTextDocument(file);
    await vscode.window.showTextDocument(document, vscode.ViewColumn.One);
    await vscode.commands.executeCommand('circuitBench.open');
    const extension = vscode.extensions.getExtension('SpeakingInBits.circuit-bench');
    const { session } = extension.exports;
    const catalog = await import(path.join(extension.extensionPath, 'shared', 'catalog.js').replace(/\\/g, '/').replace(/^([A-Z]):/, 'file:///$1:'));
    // A step that fails inside the page never answers, so give up rather than hang.
    const step = (action) => Promise.race([
      session.testStep(action),
      sleep(15000).then(() => { throw new Error(`No answer from the page for ${JSON.stringify(action)}`); }),
    ]);

    // Place parts from the palette and drag them into position.
    const resistor = (await step({ action: 'palette', type: 'resistor' })).id;
    await step({ action: 'move', id: resistor, grab: { x: 20, y: 0 }, x: 400, y: 80 });
    const led = (await step({ action: 'palette', type: 'led' })).id;
    await step({ action: 'move', id: led, grab: { x: 5, y: -1 }, x: 480, y: 70 });
    const button = (await step({ action: 'palette', type: 'button' })).id;
    await step({ action: 'move', id: button, grab: { x: 10, y: 15 }, x: 400, y: 130 });
    const pot = (await step({ action: 'palette', type: 'potentiometer' })).id;
    await step({ action: 'move', id: pot, grab: { x: 10, y: 6 }, x: 480, y: 130 });
    await step({ action: 'fit' });

    // Draw wires by clicking pins.
    const wire = async (fromId, fromPin, toId, toPin) => {
      const doc = await step({ action: 'doc' });
      await step({ action: 'clickPoint', point: pinOf(doc, fromId, fromPin, catalog) });
      return step({ action: 'clickPoint', point: pinOf(doc, toId, toPin, catalog) });
    };
    await wire('board', 'D5', resistor, '1');
    await wire(resistor, '2', led, 'A');
    await wire(led, 'K', 'board', 'GND1');
    await wire('board', 'D2', button, '1a');
    await wire(button, '2a', 'board', 'GND2');
    await wire('board', '3V', pot, '2');
    await wire(pot, '1', 'board', 'GND3');
    const last = await wire(pot, 'W', 'board', 'A0');
    report.steps.wiresDrawn = last.wires;
    if (last.wires !== 8) throw new Error(`Expected 8 wires, got ${last.wires}`);

    // Undo, then redo, a wire.
    const undone = await step({ action: 'key', key: 'z', ctrl: true });
    const redone = await step({ action: 'key', key: 'y', ctrl: true });
    report.steps.undoRedo = `${undone.wires} then ${redone.wires}`;
    if (undone.wires !== 7 || redone.wires !== 8) throw new Error('Undo or redo failed');

    // Saved next to the code.
    await new Promise((resolve) => setTimeout(resolve, 500));
    const saved = JSON.parse(fs.readFileSync(path.join(folder, 'circuit.json'), 'utf8'));
    report.steps.savedWires = saved.wires.length;
    if (saved.wires.length !== 8) throw new Error('circuit.json was not saved');

    // The builder shows the diagram without circuit.json being opened, inside the webview's
    // security policy, and it follows the circuit as it changes.
    await step({ action: 'click', selector: '#diagram' });
    report.steps.diagram = await waitForDiagram(step, (shown) => shown.parts === 4);
    if (report.steps.diagram.wires < 3 || report.steps.diagram.flags < 4) throw new Error(`The diagram is wrong: ${JSON.stringify(report.steps.diagram)}`);
    await step({ action: 'palette', type: 'resistor' });
    await waitForDiagram(step, (shown) => shown.parts === 5);
    await step({ action: 'key', key: 'z', ctrl: true });
    await waitForDiagram(step, (shown) => shown.parts === 4);
    await step({ action: 'click', selector: '#diagram' });
    if ((await step({ action: 'read' })).diagram !== null) throw new Error('The diagram did not close');

    // Opening circuit.json shows the diagram too, and it follows what the builder saves.
    const { diagramEditor } = extension.exports;
    // Not a preview, which would replace code.py and leave the group empty once it closes.
    await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(path.join(folder, 'circuit.json')), { viewColumn: vscode.ViewColumn.One, preview: false });
    const opened = await diagramTab();
    report.steps.fileDiagram = await waitForFileDiagram(diagramEditor, (shown) => shown.parts === 4);
    if (report.steps.fileDiagram.wires !== report.steps.diagram.wires) throw new Error(`The two diagrams differ: ${JSON.stringify(report.steps.fileDiagram)}`);
    await step({ action: 'palette', type: 'resistor' });
    await waitForFileDiagram(diagramEditor, (shown) => shown.parts === 5);
    await step({ action: 'key', key: 'z', ctrl: true });
    await waitForFileDiagram(diagramEditor, (shown) => shown.parts === 4);
    await vscode.window.tabGroups.close(opened);

    // Run it, then use the part on the canvas and the slider.
    await step({ action: 'click', selector: '#run' });
    await step({ action: 'waitRunning', running: true });
    report.steps.startToReadyMs = (await step({ action: 'waitConsole', text: 'READY' })).ms;
    const doc = await step({ action: 'doc' });
    const part = doc.parts.find((p) => p.id === button);
    await step({ action: 'pressPart', point: { x: part.x + 10, y: part.y + 15 } });
    report.steps.pressToLedMs = (await step({ action: 'waitView', id: led, equals: [['burned', false]] })).ms;
    const lit = await waitBright(step, led, true);
    report.steps.ledBrightness = lit;
    await step({ action: 'release' });
    await waitBright(step, led, false);
    await step({ action: 'slider', key: `${pot}:position`, value: 0.25 });
    report.steps.sliderToConsoleMs = (await step({ action: 'waitConsole', text: 'POT 10' })).ms;

    // The 3D view opens during a run, inside the webview's security policy, and follows the
    // simulation: turning the potentiometer redraws its art.
    await step({ action: 'click', selector: '#view3d' });
    const view3d = await waitFor3d(step, () => true);
    report.steps.view3d = view3d;
    if (view3d.artFailed > 0 || view3d.parts !== doc.parts.length || view3d.wires !== 8) throw new Error(`3D view is wrong: ${JSON.stringify(view3d)}`);
    await step({ action: 'slider', key: `${pot}:position`, value: 0.75 });
    report.steps.view3dFollowsRun = (await waitFor3d(step, (now) => now.artDrawn > view3d.artDrawn)).artDrawn;
    await step({ action: 'click', selector: '#view3d' });
    if ((await step({ action: 'read' })).view3d !== null) throw new Error('3D view did not close');

    // Only one of the 3D view and the diagram is open at a time.
    await step({ action: 'click', selector: '#diagram' });
    await step({ action: 'click', selector: '#view3d' });
    await waitFor3d(step, () => true);
    if ((await step({ action: 'read' })).diagram !== null) throw new Error('The 3D view did not replace the diagram');
    await step({ action: 'click', selector: '#diagram' });
    const swapped = await step({ action: 'read' });
    if (swapped.view3d !== null || !swapped.diagram) throw new Error('The diagram did not replace the 3D view');
    await step({ action: 'click', selector: '#diagram' });

    // Stop, and the page returns to editing.
    await step({ action: 'click', selector: '#stop' });
    await step({ action: 'waitRunning', running: false });
    report.steps.stopped = true;
    const final = await step({ action: 'read' });
    report.sharedArrayBufferInWebview = final.sharedArrayBuffer;
    report.problems = final.problems;

    // Autocomplete setup writes stubs and settings into the project.
    await vscode.commands.executeCommand('circuitBench.setupEditor');
    report.steps.stubsInstalled = fs.existsSync(path.join(folder, 'typings', 'digitalio-stubs'));
    if (!report.steps.stubsInstalled) throw new Error('Autocomplete stubs were not copied');

    // A shipped example, which has a breadboard, opens and runs.
    const example = path.join(path.dirname(folder), 'e2e-example');
    fs.cpSync(path.join(extension.extensionPath, 'examples', 'led-and-button'), example, { recursive: true });
    const exampleDocument = await vscode.workspace.openTextDocument(path.join(example, 'code.py'));
    await vscode.window.showTextDocument(exampleDocument, vscode.ViewColumn.One);
    await vscode.commands.executeCommand('circuitBench.run');
    await step({ action: 'waitRunning', running: true });
    await step({ action: 'waitConsole', text: 'code.py output:' });
    const exampleDoc = await step({ action: 'doc' });
    const exampleButton = exampleDoc.parts.find((p) => p.id === 'button1');
    await step({ action: 'fit' });
    await step({ action: 'pressPart', point: { x: exampleButton.x + 10, y: exampleButton.y + 15 } });
    report.steps.exampleLedBrightness = await waitBright(step, 'led1', true);
    report.problems = (await step({ action: 'read' })).problems;

    // The panel's Run button saves and runs what is typed, even though the panel has the focus.
    const program = await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(file), vscode.ViewColumn.One);
    await vscode.commands.executeCommand('circuitBench.open');
    await program.edit((edit) => edit.insert(new vscode.Position(0, 0), 'print("UNSAVED EDIT")\n'));
    await vscode.commands.executeCommand('workbench.action.focusNextGroup');
    await sleep(500);
    report.steps.activeEditorWithPanelFocused = vscode.window.activeTextEditor?.document.fileName ?? null;
    if (report.steps.activeEditorWithPanelFocused !== null) throw new Error('The panel did not take the focus');
    await step({ action: 'click', selector: '#run' });
    await step({ action: 'waitConsole', text: 'UNSAVED EDIT' });
    if (program.document.isDirty) throw new Error('Run did not save the program');

    // Another Python file at the top of the project runs as the program, from the panel too.
    const blinkFile = path.join(folder, 'blink.py');
    fs.writeFileSync(blinkFile, 'print("BLINK PROGRAM")\n');
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(blinkFile), vscode.ViewColumn.One);
    await vscode.commands.executeCommand('workbench.action.focusNextGroup');
    await sleep(500);
    await step({ action: 'click', selector: '#run' });
    await step({ action: 'waitConsole', text: 'BLINK PROGRAM' });
    await vscode.window.showTextDocument(program.document, vscode.ViewColumn.One);
    await vscode.commands.executeCommand('workbench.action.focusNextGroup');
    await sleep(500);
    await step({ action: 'click', selector: '#run' });
    await sleep(300);

    // Restart returns the controls to their defaults, on the page as well as on the board.
    await step({ action: 'slider', key: `${pot}:position`, value: 0.25 });
    await step({ action: 'click', selector: '#run' });
    await sleep(300);
    await step({ action: 'waitConsole', text: 'READY' });
    const restarted = await step({ action: 'read' });
    report.steps.sliderAfterRestart = restarted.sliders[`${pot}:position`];
    if (Number(report.steps.sliderAfterRestart) !== 0.5 || Object.keys(restarted.controlValues).length > 0) {
      throw new Error('Restart left old control values on the page');
    }

    // Two runs at once, as from a double click, leave one board, and Stop stops it. They are
    // started directly because clicks in the page do not reliably overlap.
    const reopened = await vscode.window.showTextDocument(program.document, vscode.ViewColumn.One);
    await reopened.edit((edit) => edit.replace(new vscode.Range(0, 0, reopened.document.lineCount, 0), TICKING_CODE));
    await reopened.document.save();
    await Promise.all([session.run(), session.run()]);
    await sleep(600);
    await step({ action: 'waitConsole', text: 'TICK' });
    await step({ action: 'click', selector: '#stop' });
    await step({ action: 'waitRunning', running: false });
    await sleep(300);
    const afterStop = (await step({ action: 'read' })).console;
    await sleep(500);
    report.steps.outputStoppedAfterStop = afterStop === (await step({ action: 'read' })).console;
    if (!report.steps.outputStoppedAfterStop) throw new Error('A board kept running after Stop');

    // Stop still counts when it arrives while a run is starting.
    await Promise.all([session.run(), session.stop()]);
    report.steps.boardAfterStopDuringStart = session.board === undefined ? 'none' : 'running';
    if (session.board) throw new Error('Stop was ignored while a run was starting');

    // A file in lib/ belongs to the project around it.
    fs.mkdirSync(path.join(folder, 'lib'), { recursive: true });
    fs.writeFileSync(path.join(folder, 'lib', 'helper.py'), 'VALUE = 1\n');
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(path.join(folder, 'lib', 'helper.py')), vscode.ViewColumn.One);
    await vscode.commands.executeCommand('circuitBench.open');
    report.steps.folderFromLib = path.basename(session.folder);
    if (path.relative(session.folder, folder) !== '') throw new Error(`lib/ became the project: ${session.folder}`);

    // Run saves every open file in the project, and a file in lib/ does not replace the program.
    const helper = vscode.window.activeTextEditor;
    await helper.edit((edit) => edit.replace(new vscode.Range(0, 0, 1, 0), 'VALUE = 2\n'));
    const mainProgram = await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(file), vscode.ViewColumn.One);
    await mainProgram.edit((edit) => edit.replace(new vscode.Range(0, 0, mainProgram.document.lineCount, 0), 'import helper\nprint("HELPER", helper.VALUE)\n'));
    await vscode.window.showTextDocument(helper.document, vscode.ViewColumn.One);
    await step({ action: 'click', selector: '#run' });
    await step({ action: 'waitConsole', text: 'HELPER 2' });
    await step({ action: 'click', selector: '#stop' });
    await step({ action: 'waitRunning', running: false });

    // A broken circuit.json is reported and left alone until it is fixed.
    const circuitFile = path.join(folder, 'circuit.json');
    const goodCircuit = fs.readFileSync(circuitFile, 'utf8');
    const circuitEditor = await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(circuitFile), vscode.ViewColumn.One);
    await circuitEditor.edit((edit) => edit.insert(new vscode.Position(0, 0), 'not json '));
    await circuitEditor.document.save();
    await sleep(500);
    const broken = await step({ action: 'read' });
    report.steps.brokenCircuitError = broken.loadError;
    if (!broken.loadError) throw new Error('A broken circuit.json was not reported');
    await vscode.commands.executeCommand('circuitBench.diagram');
    report.steps.brokenDiagram = (await waitForDiagram(step, (shown) => shown.problem)).problem;
    await step({ action: 'click', selector: '#diagram' });
    await vscode.commands.executeCommand('vscode.openWith', vscode.Uri.file(circuitFile), 'circuitBench.diagram', vscode.ViewColumn.Beside);
    const brokenFile = await diagramTab();
    report.steps.brokenFileDiagram = (await waitForFileDiagram(diagramEditor, (shown) => shown.problem)).problem;
    await vscode.window.tabGroups.close(brokenFile);
    await step({ action: 'palette', type: 'resistor' });
    await sleep(600);
    if (!fs.readFileSync(circuitFile, 'utf8').startsWith('not json ')) throw new Error('A broken circuit.json was overwritten');
    await circuitEditor.edit((edit) => edit.delete(new vscode.Range(0, 0, 0, 9)));
    await circuitEditor.document.save();
    await sleep(500);
    const repaired = await step({ action: 'read' });
    if (repaired.loadError || (await step({ action: 'doc' })).wires.length !== 8) throw new Error('The fixed circuit.json did not load');
    if (fs.readFileSync(circuitFile, 'utf8') !== goodCircuit) throw new Error('circuit.json changed');

    // Autocomplete setup keeps existing settings, and never rewrites a file with comments.
    const settingsFile = path.join(folder, '.vscode', 'settings.json');
    const commented = '{\n  // Keep this comment\n  "editor.tabSize": 2,\n}\n';
    fs.writeFileSync(settingsFile, commented);
    await vscode.commands.executeCommand('circuitBench.setupEditor');
    if (fs.readFileSync(settingsFile, 'utf8') !== commented) throw new Error('Setup rewrote a settings file with comments');
    fs.writeFileSync(settingsFile, '{ "editor.tabSize": 2, "python.analysis.extraPaths": ["other"] }');
    await vscode.commands.executeCommand('circuitBench.setupEditor');
    const merged = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    report.steps.mergedSettings = merged;
    if (merged['editor.tabSize'] !== 2 || merged['python.analysis.extraPaths'].join() !== 'other,lib') throw new Error('Setup lost existing settings');

    // Switching projects sends a waiting save to the project it came from.
    const other = path.join(path.dirname(folder), `${path.basename(folder)}-other`);
    fs.mkdirSync(other, { recursive: true });
    fs.writeFileSync(path.join(other, 'code.py'), 'print("OTHER PROJECT")\n');
    session.saveCircuit({ ...(await step({ action: 'doc' })), marker: 'first project' });
    await session.open(other);
    await sleep(600);
    if (fs.existsSync(path.join(other, 'circuit.json'))) throw new Error('A save landed in the wrong project');
    if (JSON.parse(fs.readFileSync(circuitFile, 'utf8')).marker !== 'first project') throw new Error('A waiting save was lost');

    // The panel runs the project it shows, not the program left open from another project.
    await step({ action: 'click', selector: '#run' });
    await step({ action: 'waitConsole', text: 'OTHER PROJECT' });
    await step({ action: 'click', selector: '#stop' });
    await step({ action: 'waitRunning', running: false });

    // A meter reads the real board, a part with no resistor smokes, and a loose part turns grey.
    const meter = (await step({ action: 'palette', type: 'multimeter' })).id;
    await step({ action: 'move', id: meter, grab: { x: 30, y: 40 }, x: 400, y: 80 });
    const doomed = (await step({ action: 'palette', type: 'led' })).id;
    await step({ action: 'move', id: doomed, grab: { x: 5, y: -1 }, x: 520, y: 80 });
    const loose = (await step({ action: 'palette', type: 'led' })).id;
    await step({ action: 'move', id: loose, grab: { x: 5, y: -1 }, x: 580, y: 80 });
    const pushed = (await step({ action: 'palette', type: 'button' })).id;
    await step({ action: 'move', id: pushed, grab: { x: 10, y: 15 }, x: 640, y: 80 });
    await step({ action: 'fit' });
    await wire(meter, 'V', 'board', '3V');
    await wire(meter, 'COM', 'board', 'GND1');
    await wire(doomed, 'A', 'board', '5V');
    await wire(doomed, 'K', 'board', 'GND2');
    await wire(pushed, '1a', 'board', 'D3');
    await step({ action: 'click', selector: '#run' });
    await step({ action: 'waitView', id: meter, equals: [['reading', '3.30'], ['unit', 'V']] });
    await step({ action: 'waitView', id: doomed, equals: [['burned', true]] });
    await sleep(200);
    const damaged = await step({ action: 'read' });
    report.steps.damage = { smoke: damaged.smoke, idle: damaged.idle };
    if (damaged.smoke < 1) throw new Error('The burned LED has no smoke');
    if (damaged.idle.join() !== loose) throw new Error(`Wrong parts greyed out: ${damaged.idle}`);

    // Parts work by clicking in 3D as they do in 2D, and anywhere else still turns the view.
    await step({ action: 'click', selector: '#view3d' });
    await waitFor3d(step, () => true);
    await sleep(300);
    const missed = await step({ action: 'press3d' });
    await step({ action: 'release3d' });
    if (missed.held !== 0) throw new Error('A press on empty space pressed something');
    const held = await step({ action: 'press3d', id: pushed });
    report.steps.press3d = held;
    if (held.held !== 1) throw new Error(`The 3D press missed the button: ${JSON.stringify(held)}`);
    await step({ action: 'waitView', id: pushed, equals: [['pressed', true]] });
    await step({ action: 'release3d' });
    await step({ action: 'waitView', id: pushed, equals: [['pressed', false]] });
    await step({ action: 'press3d', id: meter });
    await step({ action: 'release3d' });
    await step({ action: 'waitView', id: meter, equals: [['mode', 1]] });
    await step({ action: 'click', selector: '#view3d' });

    // Everything exports from the real page, and a package comes back as the same project.
    const exported = path.join(path.dirname(folder), `${path.basename(folder)}-exports`);
    fs.mkdirSync(exported, { recursive: true });
    const exportPath = (name) => path.join(exported, name);
    await session.exportTo('circuit-png', exportPath('circuit.png'));
    await session.exportTo('diagram-png', exportPath('diagram.png'));
    await session.exportTo('circuit-svg', exportPath('circuit.svg'));
    await session.exportTo('parts-csv', exportPath('parts.csv'));
    await session.exportTo('package', exportPath('project.circuitbench'));
    await step({ action: 'click', selector: '#stop' });
    await step({ action: 'waitRunning', running: false });
    for (const name of ['circuit.png', 'diagram.png']) {
      if (fs.readFileSync(exportPath(name)).toString('latin1', 1, 4) !== 'PNG') throw new Error(`${name} is not a PNG`);
    }
    if (!fs.readFileSync(exportPath('circuit.svg'), 'utf8').startsWith('<svg')) throw new Error('The picture is not an SVG');
    if (!fs.readFileSync(exportPath('parts.csv'), 'utf8').includes('1,Multimeter')) throw new Error('The parts list lost the meter');

    const { unpackProject } = extension.exports;
    const restored = await unpackProject(exportPath('project.circuitbench'), exported);
    report.steps.restored = path.basename(restored);
    if (fs.readFileSync(path.join(restored, 'code.py'), 'utf8') !== 'print("OTHER PROJECT")\n') throw new Error('The package changed the program');
    const original = fs.readFileSync(path.join(other, 'circuit.json'), 'utf8');
    if (fs.readFileSync(path.join(restored, 'circuit.json'), 'utf8') !== original) throw new Error('The package changed the circuit');
    let refused = false;
    await unpackProject(exportPath('project.circuitbench'), exported).catch(() => { refused = true; });
    if (!refused) throw new Error('Importing replaced an existing folder');
    report.passed = true;
  } catch (error) {
    report.passed = false;
    report.error = String(error?.stack ?? error);
  }
  fs.writeFileSync(output, JSON.stringify(report, null, 2));
  if (holdMs > 0) await new Promise((resolve) => setTimeout(resolve, holdMs));
}

async function waitBright(step, id, on) {
  const started = Date.now();
  while (Date.now() - started < 4000) {
    const { views } = await step({ action: 'read' });
    const level = views[id]?.brightness ?? 0;
    if (on ? level > 0.3 : level === 0) return level;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`LED did not turn ${on ? 'on' : 'off'}`);
}

module.exports = { run };

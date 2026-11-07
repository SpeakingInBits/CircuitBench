// Runs test/vscode/index.cjs in a real VS Code window, using a throwaway project and profile.
// Needs a built extension (see the README) and an installed VS Code. Set SIM_VSCODE to the VS Code
// executable if it is not in the usual place.
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TIMEOUT_MS = 180000;

const extension = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fail = (message) => {
  console.error(message);
  process.exit(1);
};

if (!fs.existsSync(path.join(extension, 'firmware', 'firmware.cjs'))) {
  fail('No firmware found. Follow the build steps in the README first.');
}
const code = [
  process.env.SIM_VSCODE,
  path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Microsoft VS Code', 'Code.exe'),
  path.join(process.env.ProgramFiles ?? '', 'Microsoft VS Code', 'Code.exe'),
  '/Applications/Visual Studio Code.app/Contents/MacOS/Electron',
  '/usr/share/code/code',
].find((candidate) => candidate && fs.existsSync(candidate));
if (!code) fail('VS Code was not found. Set SIM_VSCODE to its executable.');

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'circuit-bench-e2e-'));
const project = path.join(base, 'project');
const report = path.join(base, 'report.json');
fs.mkdirSync(project);

const env = { ...process.env, SIM_TEST_FOLDER: project, SIM_TEST_OUTPUT: report };
delete env.ELECTRON_RUN_AS_NODE;
const window = spawn(code, [
  '--new-window', project,
  `--user-data-dir=${path.join(base, 'profile')}`,
  `--extensions-dir=${path.join(base, 'extensions')}`,
  '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes',
  `--extensionDevelopmentPath=${extension}`,
  `--extensionTestsPath=${path.join(extension, 'test', 'vscode', 'index.cjs')}`,
], { env, stdio: 'ignore' });

const exited = new Promise((resolve) => { window.once('exit', resolve); });
const started = Date.now();
while (!fs.existsSync(report) && Date.now() - started < TIMEOUT_MS) {
  await Promise.race([exited, new Promise((resolve) => { setTimeout(resolve, 500); })]);
  if (window.exitCode !== null) break;
}

// VS Code closes itself after a test, so this only matters if it stopped responding.
await Promise.race([exited, new Promise((resolve) => { setTimeout(resolve, 5000); })]);
if (window.exitCode === null) {
  if (process.platform === 'win32') execFileSync('taskkill', ['/pid', String(window.pid), '/t', '/f'], { stdio: 'ignore' });
  else window.kill();
  await exited;
}

const result = fs.existsSync(report) ? JSON.parse(fs.readFileSync(report, 'utf8')) : null;
fs.rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
if (!result) fail('VS Code finished without a test report.');
console.log(JSON.stringify(result.steps, null, 2));
if (!result.passed) fail(`FAILED: ${result.error}`);
console.log(`Passed in VS Code ${result.vscode}`);
process.exit(0);

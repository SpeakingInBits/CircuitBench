# Circuit Bench

A VS Code extension that lets students build circuits and test CircuitPython for the Adafruit
Metro M0 Express without a physical board. Arduino C++ support for the Metro 328 is planned.

| Folder | What it holds |
|---|---|
| [`extension/`](extension/README.md) | The VS Code extension: circuit builder, electrical simulator and part models |
| [`firmware/`](firmware/README.md) | Real CircuitPython compiled to WebAssembly, with its test harness |

## Build it

These steps are for Windows with Git Bash, Python 3.12 or later, and GNU make. Keep the repo in a
short path, because Emscripten's install fails in a deeply nested folder.

```bash
sh firmware/setup.sh
```

```bash
sh firmware/build.sh -j8
```

```bash
NODE="$PWD/$(ls -d firmware/.toolchain/emsdk/node/*_64bit)/node.exe"; cd extension && "$NODE" scripts/copy-assets.js && "$NODE" scripts/make-examples.js && "$NODE" --test test/*.test.js
```

Then open the `extension` folder in VS Code and press F5, or run it directly:

```bash
code --extensionDevelopmentPath="$PWD/extension"
```

## Test it

GitHub runs the first of these on every pull request, on Windows, macOS and Linux. The firmware is
not kept in Git, so the other two have to be run on a computer that has built it. Run them before
merging a change to the simulator, the panel or the firmware. `NODE` is set in the build steps.

| Command, from `extension` | What it covers | Needs |
|---|---|---|
| `"$NODE" --test test/circuit.test.js test/checks.test.js test/editing.test.js test/console.test.js test/layout3d.test.js test/diagram.test.js` | Electrical models, out-of-spec checks, editing, export, project packages, circuit files, console text, 3D layout, circuit diagrams | Node only |
| `"$NODE" --test test/*.test.js` | All of the above, plus real CircuitPython running real libraries | A built firmware |
| `"$NODE" scripts/run-e2e.js` | The whole extension, in a real VS Code window | A built firmware and VS Code |

The last one opens and closes its own VS Code window. Set `SIM_VSCODE` to the VS Code executable if
it is not found.

## Release it

The Release workflow builds the firmware, runs the tests and publishes a GitHub release with the
`.vsix`. Run it from the Actions tab on `main`, and choose what kind of change the release holds.
Pull requests that change the packaging build the `.vsix` without releasing it, and the file is
attached to the workflow run.

## Licence

MIT, as [LICENSE](LICENSE) says. The extension also includes third-party software, listed in
[THIRD_PARTY_NOTICES.md](extension/THIRD_PARTY_NOTICES.md).

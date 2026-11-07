#!/usr/bin/env bash
# Tests the extension against a built firmware and packages it as dist/circuit-bench-<version>.vsix.
#
#   VERSION=1.2.3 packaging/package.sh
#
# Build the firmware first. See the README.
set -euo pipefail

version=${VERSION:?set VERSION, e.g. VERSION=1.2.3}
root=$(cd "$(dirname "$0")/.." && pwd)
vsce=(npx --yes @vscode/vsce@4.1.0)

cd "$root/extension"
node scripts/copy-assets.js
node --test test/*.test.js

# The package needs its own copy of the licence. The compiled firmware is CircuitPython, so its licence travels with it.
cp ../LICENSE LICENSE
cp ../firmware/circuitpython/LICENSE firmware/LICENSE-circuitpython
cp ../firmware/circuitpython/LICENSE_MicroPython firmware/LICENSE-micropython

# Without these the package still builds, but the simulator can't run or its licences are missing.
files=$("${vsce[@]}" ls --no-dependencies)
for needed in LICENSE THIRD_PARTY_NOTICES.md images/icon.png firmware/firmware.wasm firmware/firmware.cjs libs/neopixel.mpy stubs/board-stubs/__init__.pyi webview/main.js; do
  if ! grep -qx "$needed" <<< "$files"; then
    echo "::error::The package is missing $needed." >&2
    exit 1
  fi
done

mkdir -p ../dist
# The extension is in a subfolder of the repository, so its README's relative links need this base on the Marketplace.
"${vsce[@]}" package "$version" --no-git-tag-version --no-update-package-json --no-dependencies \
  --baseContentUrl https://github.com/SpeakingInBits/CircuitBench/blob/HEAD/extension \
  --out "../dist/circuit-bench-$version.vsix"

# Installing the Vector PNG Editor

[日本語](INSTALL.ja.md)

## Install from a release

Download the `.vsix` from the GitHub Release and install it in VS Code:

```sh
code --install-extension vector-png-editor-<version>.vsix
```

(or use "Extensions: Install from VSIX..." in the Command Palette). That is the whole installation. There is no environment setup step, and the extension asks for no further downloads.

## Requirements

- VS Code 1.90 or later, on Windows, macOS or Linux.
- Nothing else. No Python, no native libraries (no Cairo, no GTK runtime), no fonts package and no network access are required at runtime.

## What the extension ships

Everything the editor needs is inside the VSIX. The Core - PNG container handling, safe-svg-v1 validation, svg-normalization-v1 and rendering - is the TypeScript Core in `packages/ts-core`, bundled into the extension host code. Rendering uses the resvg engine compiled to WebAssembly (`@resvg/resvg-wasm`, MPL-2.0; the binary ships under `media/resvg/` in the package and is listed in [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md)). Monaco is bundled the same way under `media/monaco/`. Opening, previewing, saving, exporting and normalizing all run in-process in the extension host.

## Fonts

Text rendering uses the host's system fonts, loaded once per activation as buffers and handed to the renderer: the usual sans-serif families plus a CJK family when present (on this interim strategy, see Issue #61). A machine without a font covering some text renders that text with a fallback or not at all; installing a suitable system font is the remedy. No font is downloaded or bundled at this stage.

## Build from source

```sh
cd packages/ts-core && npm install && npm test
cd ../extension && npm install && npm run check && npm test
npx --yes @vscode/vsce package
```

Run the ts-core install first: the extension's suites import the TypeScript Core in-process and need its `@resvg/resvg-wasm` dependency present. The `vscode:prepublish` script copies Monaco, the profile schemas and the resvg wasm into `media/` and bundles the host code before packaging.

## History: the retired Python environment

Earlier development builds ran a Python Core from a managed virtual environment, with "Set Up Python Environment" / "Python Environment Status" / "Roll Back Python Environment" commands, `vectorPng.corePythonPath` / `vectorPng.coreWheelPath` settings and a bundled wheel. The TypeScript migration (Issues #58-#61) ported every feature in-process, and Phase 3 removed the Python package, the CLI and the environment machinery entirely. Builds from before that change keep working as installed, but no current build contains or needs them; the historical record is in [CORE_PROGRESS.md](CORE_PROGRESS.md) and [EXTENSION_PROGRESS.md](EXTENSION_PROGRESS.md).

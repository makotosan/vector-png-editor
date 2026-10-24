# vector-png Editor Core (experimental)

Python Core and JSON CLI for passive vector-png inspection, byte-preserving extraction and safe-svg-v1 validation. This development build provides inspect, extract, validate, build, verify and rebuild. The VS Code editor is not implemented yet. Writing uses exact source bytes and local RGBA8 preview verification; overwrite requires explicit consent and a SHA-256 revision token, keeps an original snapshot and coordinates Core writers with a lock. Arbitrary external-writer races remain unsupported; see docs/WRITING.md in the repository before overwriting. It is not a stable release or complete format-conformance claim.

Install this package with pip. Python 3.11–3.13 are candidate versions; consult the repository's executed CI and real-machine acceptance record. Native Cairo is installed separately for rendering. On Windows configure VECTOR_PNG_CAIRO_DIR to its DLL directory; on macOS configure the loader path if required by the Cairo installation. inspect/extract and validate --syntax-only do not start CairoSVG rendering.

```text
vector-png-editor inspect input.png
vector-png-editor extract input.png original.svg
vector-png-editor validate original.svg --width 1024 --height 1024
vector-png-editor --request-id job1 validate original.svg --syntax-only
```

Operational results and errors are one protocol-1 JSON object on stdout. --request-json alone accepts one bounded UTF-8 request on stdin, with path or exact base64 source input and a required request ID; close stdin to dispatch. python -m vector_png_editor.environment performs a read-only direct-pin/Python/real-render health probe with a separate diagnostic envelope. See repository docs/BRIDGE.md for request schemas, limits, TypeScript transport, cancellation boundaries and incomplete environment management. Help and version output are human-readable. Extraction creates a new output with no overwrite and preserves original UTF-8 bytes, including BOM and CRLF. It does not establish safety or preview equality: validate is separate and normal validation also renders with bounded timeout. --syntax-only explicitly omits rendering/numeric renderer checks. Unsafe source may be extracted as inert bytes and must not be treated as approved for active use.

The reader checks a documented structural subset and returns container=passed-supported-checks, not a complete PNG conformance certificate. Unknown ancillary payloads, registry-level language validation and complete raster-subset coverage remain under audit. No script execution, external SVG resource fetching or normalization is performed. See the repository's docs/CLI.md, docs/CORE_PROGRESS.md and docs/SPEC_COMPATIBILITY.md for the full contract and known limits. Source provenance and dependency notices are in THIRD_PARTY_NOTICES.md and LICENSE.

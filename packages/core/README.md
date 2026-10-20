# vector-png Editor Core (experimental)

Python Core and JSON CLI for passive vector-png inspection, byte-preserving extraction and safe-svg-v1 validation. This development build provides inspect, extract and validate. build, verify, rebuild and the VS Code editor are not implemented yet. It is not a stable release or complete format-conformance claim.

Install this package with pip. Python 3.11–3.13 are candidate versions; consult the repository's executed CI and real-machine acceptance record. Native Cairo is installed separately for rendering. On Windows configure VECTOR_PNG_CAIRO_DIR to its DLL directory; on macOS configure the loader path if required by the Cairo installation. inspect/extract and validate --syntax-only do not start CairoSVG rendering.

```text
vector-png-editor inspect input.png
vector-png-editor extract input.png original.svg
vector-png-editor validate original.svg --width 1024 --height 1024
vector-png-editor --request-id job1 validate original.svg --syntax-only
```

Operational results and errors are one protocol-1 JSON object on stdout. Help and version output are human-readable. Extraction creates a new output with no overwrite and preserves original UTF-8 bytes, including BOM and CRLF. It does not establish safety or preview equality: validate is separate and normal validation also renders with bounded timeout. --syntax-only explicitly omits rendering/numeric renderer checks. Unsafe source may be extracted as inert bytes and must not be treated as approved for active use.

The reader checks a documented structural subset and returns container=passed-supported-checks, not a complete PNG conformance certificate. Unknown ancillary payloads, registry-level language validation and complete raster-subset coverage remain under audit. No script execution, external SVG resource fetching or normalization is performed. See the repository's docs/CLI.md, docs/CORE_PROGRESS.md and docs/SPEC_COMPATIBILITY.md for the full contract and known limits. Source provenance and dependency notices are in THIRD_PARTY_NOTICES.md and LICENSE.

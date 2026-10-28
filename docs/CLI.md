# Experimental Core CLI contract v1

[日本語](CLI.ja.md)

## Scope and installation

The development package vector-png-editor-core 0.1.0.dev3 exposes vector-png-editor and python -m vector_png_editor. It implements inspect, extract, validate, build, verify and rebuild, plus the explicit svg-normalization-v1 import commands normalize and convert (Issue #48). The full writer/verification contract, backup policy and concurrency limitations are in [WRITING.md](WRITING.md); the VS Code editor and integrated venv setup UI are not implemented. A separate managed-venv API is documented in [INSTALL.md](INSTALL.md). Python metadata admits 3.11–3.13 as candidates; executed support evidence is in [CORE_PROGRESS.md](CORE_PROGRESS.md). Native Cairo is separately required for rendering, with VECTOR_PNG_CAIRO_DIR on Windows and loader configuration appropriate to other platforms. No system Python is modified by the Core.

```text
python -m pip install ./packages/core
vector-png-editor inspect input.png
vector-png-editor extract input.png original.svg
vector-png-editor validate original.svg --width 1024 --height 1024
vector-png-editor --request-id job1 validate original.svg --syntax-only
```

## Commands and independent outcomes

| Command | Behavior |
| --- | --- |
| inspect PNG | Passive bounded PNG/UTF-8 XML discovery and raster decoding; no safe-profile validation or SVG rendering. Ordinary valid PNG returns kind=png; a detected malformed source produces an error rather than fallback. Returns dimensions, color type, depth, interlace, PNG/source SHA-256 and source byte count. |
| extract PNG OUTPUT | Same passive checks, then exact decompressed source bytes in a newly created output. BOM, XML declaration, whitespace and CRLF are retained. No overwrite option; existing files, symlinks or a concurrently created output cause failure. Publication uses same-directory temporary file, fsync and atomic no-clobber link; input is never written. |
| validate SVG | Checks UTF-8 XML and safe-svg-v1, then renders through the shared CairoSVG subprocess at the specified viewport (default 1024×1024). It returns renderer/version, viewport, font policy, color/alpha/text policy. A successful render does not compare any saved PNG; preview remains not-checked. |
| validate SVG --syntax-only | XML/profile allowlist only; render=not-checked. Does not establish numeric/path renderer acceptance, preview equality or safety for wider SVG. |
| build SVG OUTPUT | Render unchanged source at --width/--height (default 1024×1024), embed, validate and publish; see [WRITING.md](WRITING.md) for overwrite/backup/conflict policy. |
| verify PNG | Exact local RGBA8 comparison at IHDR viewport, with independent container/profile/renderer results; mismatch exits 12 with error.details. |
| rebuild PNG OUTPUT | Generate from embedded source bytes at existing IHDR viewport, validate and publish under the build policy. |
| normalize SVG OUTPUT --report REPORT | Explicit svg-normalization-v1 import: validate the restricted CSS-styled input, resolve cascade, restricted markers and accessibility metadata, gate on exact before/after decoded RGBA equality, then publish the safe-svg-v1 SVG and its JSON conversion report staged and no-clobber; the input is never modified. On failure no SVG is published; a failure report is written to REPORT when that path is still unused. Failure codes and corpus evidence are recorded in [SPEC_COMPATIBILITY.md](SPEC_COMPATIBILITY.md). |
| convert SVG OUTPUT --report REPORT | Run the normalize gate, then build a vector-png from the normalized source with the existing writer and container checks, and publish the PNG and the report as a pair. |

inspect/extract can accept container-supported but unsafe SVG and differing-preview fixtures without executing them. They report profile=not-checked and preview=not-checked. Extraction does not approve source for active use. The reader reports container=passed-supported-checks, because optional ancillary payload validity, registry-level BCP47 language validation and full PNG interoperability remain unaudited. It does not claim a complete container certificate. XML complexity limits also apply to passive discovery. Metadata text/ICC is not inflated for raster decoding: only raster-essential chunks are passed to Pillow. Full metadata validity remains an explicit audit item.

## JSON and exit codes

Operational success/error output is exactly one JSON object on stdout, using ASCII JSON escapes for portable console encoding. Help/version are human-readable exceptions. The CLI accepts one bounded stdin JSON request with --request-json alone; the schema, inline-source transport, TypeScript adapter and cancellation limits are documented in [BRIDGE.md](BRIDGE.md). P1-04 remains partial. Optional global --request-id (before the command) is at most 128 characters and is echoed on parsed requests; invalid arguments may have command/request_id=null. Error messages are at most 2000 code points. No logs are mixed into operational stdout. Native/render failures use structured errors.

```json
{"protocol":1,"command":"validate","request_id":"job1","ok":true,"result":{"xml":"valid","profile":"safe-svg-v1","profile_check":"passed","render":"not-checked","svg_bytes":42}}
```

This is a schema illustration, not evidence of a particular input. Success contains result; failure contains error with code/message and no result. See [cli-result-v1.schema.json](../schemas/cli-result-v1.schema.json). An existing failure is never relabeled a successful raster-only vector-png.

| Exit | Error code / meaning |
| --- | --- |
| 0 | Operational success; consult independent not-checked fields |
| 2 | invalid-arguments |
| 3 | invalid-container |
| 4 | invalid-svg: UTF-8/XML/root/DTD/entity/PI/encoding failure; normalize/convert also use invalid-xml and unsafe-input for their input failures |
| 5 | unsupported-profile: valid XML outside safe-svg-v1; normalize/convert also use unsupported-css and invalid-reference |
| 6 | resource-limit: declared byte/pixel/complexity bound |
| 7 | ordinary-png: extract, verify or rebuild requested from PNG without source |
| 8 | io-error |
| 9 | output-exists; normalize/convert also use output-alias when an output or report path aliases the input or each other |
| 10 | render-failed, including native Cairo setup failure; normalize/convert also use render-error for rendering-gate failures |
| 11 | render-timeout |
| 12 | render-mismatch; verification report in error.details |
| 13 | conflict |
| 14 | cancelled: handled KeyboardInterrupt |

inspect of an ordinary valid PNG succeeds with kind=png; extract of that PNG exits 7. A render failure is not container corruption. Writing/verification/conflict exits are the documented protocol-1 extension in [WRITING.md](WRITING.md). Optional error.details contains a structured comparison report.

## Limits and failure protection

Limits: 1,000,000 SVG bytes, 32,000,000 PNG bytes, 4096 pixels per side, 4,000,000 pixels, 10,000 PNG chunks, 5000 XML elements, root depth 0 through depth 32, 100,000 code points per attribute and 20 seconds per render subprocess. IDAT inflation is bounded by exact expected scanline sizes including Adam7 passes and filter bytes; a single complete image zlib stream is required. Pixel/raster support relies on Pillow; exact tested coverage, optional metadata gaps and native memory limitations are in [SPEC_COMPATIBILITY.md](SPEC_COMPATIBILITY.md). A subprocess timeout is not an OS sandbox or hard memory quota; process output is checked after capture. No render-worker cancellation or hard native-memory cap exists yet.

Extraction cleans its temporary file on handled publication failure and never replaces input or existing output. It is not a transactional editor save, hostile-directory sandbox or crash-durable two-file transaction. Rendering accepts source only after profile validation, denies external fetching and preserves source bytes; no automatic normalization or autoformatting is performed - normalization exists only as the explicit normalize/convert import commands above. build/rebuild provide staged validated publication, explicit overwrite with revision token, independent backup and cooperative locking; arbitrary external-writer concurrency remains P1-03/P2-06. See [WRITING.md](WRITING.md) for boundaries and recovery.


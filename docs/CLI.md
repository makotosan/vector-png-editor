# Experimental Core CLI contract v1

[日本語](CLI.ja.md)

## Scope and installation

The development package vector-png-editor-core 0.1.0.dev1 exposes vector-png-editor and python -m vector_png_editor. It currently implements inspect, extract and validate. build, verify and rebuild remain P1-03; the VS Code editor and venv manager are not implemented. Python metadata admits 3.11–3.13 as candidates; executed support evidence is in [CORE_PROGRESS.md](CORE_PROGRESS.md). Native Cairo is separately required for rendering, with VECTOR_PNG_CAIRO_DIR on Windows and loader configuration appropriate to other platforms. No system Python is modified by the Core.

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

inspect/extract can accept container-supported but unsafe SVG and differing-preview fixtures without executing them. They report profile=not-checked and preview=not-checked. Extraction does not approve source for active use. The reader reports container=passed-supported-checks, because optional ancillary payload validity, registry-level BCP47 language validation and full PNG interoperability remain unaudited. It does not claim a complete container certificate. XML complexity limits also apply to passive discovery. Metadata text/ICC is not inflated for raster decoding: only raster-essential chunks are passed to Pillow. Full metadata validity remains an explicit audit item.

## JSON and exit codes

Operational success/error output is exactly one JSON object on stdout, using ASCII JSON escapes for portable console encoding. Help/version are human-readable exceptions. The CLI does not consume JSON on stdin; the future TypeScript request transport/cancellation/schema work remains P1-04. Optional global --request-id (before the command) is at most 128 characters and is echoed on parsed requests; invalid arguments may have command/request_id=null. Error messages are at most 2000 code points. No logs are mixed into operational stdout. Native/render failures use structured errors.

```json
{"protocol":1,"command":"validate","request_id":"job1","ok":true,"result":{"xml":"valid","profile":"safe-svg-v1","profile_check":"passed","render":"not-checked","svg_bytes":42}}
```

This is a schema illustration, not evidence of a particular input. Success contains result; failure contains error with code/message and no result. See [cli-result-v1.schema.json](../schemas/cli-result-v1.schema.json). An existing failure is never relabeled a successful raster-only vector-png.

| Exit | Error code / meaning |
| --- | --- |
| 0 | Operational success; consult independent not-checked fields |
| 2 | invalid-arguments |
| 3 | invalid-container |
| 4 | invalid-svg: UTF-8/XML/root/DTD/entity/PI/encoding failure |
| 5 | unsupported-profile: valid XML outside safe-svg-v1 |
| 6 | resource-limit: declared byte/pixel/complexity bound |
| 7 | ordinary-png: extraction requested from PNG without source |
| 8 | io-error |
| 9 | output-exists |
| 10 | render-failed, including native Cairo setup failure |
| 11 | render-timeout |

inspect of an ordinary valid PNG succeeds with kind=png; extract of that PNG exits 7. A render failure is not container corruption. Future writing/verification/conflict exits will require an explicitly reviewed contract extension.

## Limits and failure protection

Limits: 1,000,000 SVG bytes, 32,000,000 PNG bytes, 4096 pixels per side, 4,000,000 pixels, 10,000 PNG chunks, 5000 XML elements, root depth 0 through depth 32, 100,000 code points per attribute and 20 seconds per render subprocess. IDAT inflation is bounded by exact expected scanline sizes including Adam7 passes and filter bytes; a single complete image zlib stream is required. Pixel/raster support relies on Pillow; exact tested coverage, optional metadata gaps and native memory limitations are in [SPEC_COMPATIBILITY.md](SPEC_COMPATIBILITY.md). A subprocess timeout is not an OS sandbox or hard memory quota; process output is checked after capture. No render-worker cancellation or hard native-memory cap exists yet.

Extraction cleans its temporary file on handled publication failure and never replaces input or existing output. It is not a transactional editor save, hostile-directory sandbox or crash-durable two-file transaction. Rendering accepts source only after profile validation, denies external fetching and preserves source bytes; no normalization or autoformatting is performed. Full overwrite/concurrency protection for build/rebuild remains P1-03/P2-06.


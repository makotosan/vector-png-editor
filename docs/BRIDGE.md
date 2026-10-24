# Experimental JSON bridge and environment diagnosis

[日本語](BRIDGE.ja.md)

## Delivered scope

Core 0.1.0.dev3 adds bounded stdin requests for the existing six commands, a standalone read-only environment probe, and a TypeScript subprocess adapter at packages/bridge. P1-04 is partial. A separate [managed-environment API](INSTALL.md) now builds, health-checks, activates and rolls back dedicated venvs with a Python application-dependency version lock. VS Code/Webview integration, complete native/artifact locking and release remain open. The storage format, specification pin and writer concurrency boundaries in [WRITING.md](WRITING.md) are unchanged. PR #24 was merged; its original CI results are historical evidence, not proof for this bridge.

## One request and one result

Run vector-png-editor --request-json alone, or python -m vector_png_editor --request-json. Send one UTF-8 JSON object and close stdin. This is not NDJSON, a persistent server or a cancellation-message stream. Reading waits for EOF; the adapter closes stdin and enforces a total deadline. Operational stdout is one existing protocol-1 result envelope; diagnostics are separate on stderr. Help/version remain human-readable exceptions for the argument CLI. Existing positional command syntax is preserved.

```json
{"protocol":1,"command":"validate","request_id":"document-7:revision-3","input":"source.svg","syntax_only":true}
```

[cli-request-v1.schema.json](../schemas/cli-request-v1.schema.json) defines command-specific fields and rejects unknown properties. protocol must be integer 1; request_id is required and contains 1–128 Unicode code points. input/output paths contain 1–32768 code points and no NUL. inspect/verify require input; extract/rebuild require input and output. validate/build accept exactly one input path or source_base64; build also requires output. source_base64 uses canonical padded standard base64 for exact source bytes, preserving UTF-8 BOM, XML declaration, Unicode and CRLF. It is not decoded/re-encoded as SVG text by the adapter. validate accepts syntax_only; validate/build accept width/height (default 1024×1024); build/rebuild accept overwrite and expected_sha256 under the existing paired-option policy.

Transport limits supplement JSON Schema: 2,000,000 raw request bytes, 1,333,336 base64 characters, 1,000,000 decoded source bytes, 4096 pixels per side and 4,000,000 total pixels. Duplicate object keys, non-finite numbers, trailing JSON documents, invalid UTF-8, lone surrogate characters and noncanonical base64 pad bits are rejected. JSON Schema alone cannot prove these byte/decoder/product requirements. Invalid requests return structured invalid-arguments or resource-limit errors with command/request_id=null before a valid request context is established. No file is changed during parsing. Schema copies included in the source-distribution test fixtures are checked against the canonical repository schemas.

Successful requests echo command/request_id, return ok=true and result, and exit 0. Core failures return ok=false and error, without a top-level result, with the existing stable exit code. Preview mismatch retains the renderer/comparison report in error.details and exits 12. The [result schema](../schemas/cli-result-v1.schema.json) remains protocol 1. These envelopes do not replace independent container/profile/render/preview/authenticity outcomes. See [CLI.md](CLI.md) and [WRITING.md](WRITING.md).

## TypeScript adapter and stale results

runCore takes a trusted Python executable path and structured Request; it launches a fixed argument list with shell=false and hidden Windows windows. It never builds shell commands from source, paths or request IDs. Paths/inline source are sent over stdin. The adapter enforces a 2,000,000-byte request cap, 262,144-byte stdout cap, 65,536-byte stderr cap and default 60,000ms total deadline (caller override 1–120,000ms). It rejects invalid UTF-8/JSON, wrong protocol/command/ID, contradictory success/error shapes and inconsistent exit codes. It returns bounded stderr as diagnostics, separate from the response. Result-specific payload fields remain unknown until the eventual editor validates/uses them; the adapter is not a full command-result semantic validator. Neither responses nor diagnostics may be inserted into active HTML as trusted content.

LatestValidation belongs to one document. Each new validate request advances a local generation and cancels its predecessor; stale success and failure are discarded even if the caller reused a request ID. dispose invalidates pending results. The caller supplies an ID representing document/revision. This lane refuses non-validate commands. AbortSignal is allowed only for read-only inspect/validate/verify; extract/build/rebuild reject it before launch so preview cancellation cannot terminate a save. Total deadlines/output caps still apply to all commands. A save interrupted by those limits can already have published a complete file or can leave temporary files/locks; this is not save rollback. Editor cancellation/commit-boundary coordination remains open.

Process termination is best effort: POSIX uses a dedicated process group; Windows uses hidden taskkill /T /F with a 5-second helper deadline and a parent-kill fallback. Abort and timeout return bridge errors, not fabricated successful Core responses. There is no OS sandbox or hard memory quota, and escape from a process group or failure of Windows tree termination can leave a descendant. The adapter's bounded protocol streams do not fix the existing render subprocess's capture-before-size-check limitation. Graceful native-worker cancellation and fully bounded renderer output remain P1-04. The TypeScript source is runtime-tested using Node 24 built-in type stripping, without an external npm dependency or type-check/build toolchain. It is not a packaged extension or proof of compatibility with the eventual VS Code extension-host Node version.

## Environment probe and evidence

```text
python -m vector_png_editor.environment
```

The probe writes one JSON object with protocol=1, kind=environment and report. It returns the Core/Python/platform versions, whether Python is in 3.11–3.13, expected/actual/match for Pillow 13.0.0, CairoSVG 2.9.1 and defusedxml 0.7.1, and a real 2×2 rendering result or bounded error. It exits 0 only when the Python range, direct pins and rendering pass, otherwise 1. Missing site packages and native rendering failures are reported without changing files or installing anything. Public API imports are lazy so this probe can start with missing optional runtime imports. This separate diagnostic envelope has no request ID and is not a seventh editing command or a runCore response. It explicitly reports native_lock and environment_manager as not-implemented within the standalone Core; the separate TypeScript manager is documented in [INSTALL.md](INSTALL.md). It does not prove full native/transitive reproducibility, font equivalence or installation rollback.

Tests exercise strict/oversized requests, duplicate keys, non-finite/deep JSON, invalid Unicode/base64, six-command JSON source roundtrip, result-schema validation, missing/mismatched dependency and native errors, malformed/excessive subprocess responses, mismatched IDs, cancellation/deadlines, stale validation and a real TypeScript-to-Python call. The clean-wheel smoke includes JSON requests and the environment probe outside the source tree. All nine Core OS/Python CI cells also run bridge tests on Node 24. See [CORE_PROGRESS.md](CORE_PROGRESS.md) for executed evidence. The unit/fault tests do not complete P1-04/P2 environment recovery or editor-host acceptance.

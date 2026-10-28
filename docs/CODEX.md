# Automating vector-png with the CLI (Codex workflow)

[日本語](CODEX.ja.md)

This guide is for automated callers - Codex or any script - that edit
vector-png files from the command line. There is no chat UI: every
operation is the `vector-png-editor` console script from the Python
Core, the same Core the VS Code extension uses through the bridge.
Rules first, then the workflow.

## Ground rules

1. **One JSON envelope per call.** Every invocation prints exactly one
   JSON object: `{protocol, command, request_id, ok, result}` on
   success or `{..., ok: false, error: {code, message}}` on failure.
   Parse the envelope; the process exit code carries the same outcome
   (table below). Pass `--request-id <id>` to correlate calls.
2. **Revisions are content hashes.** `inspect` reports `png_sha256` -
   the SHA-256 of the file's current bytes. An overwrite is accepted
   only with `--overwrite --expected-sha256 <that hash>`. Take the
   token from a fresh `inspect` immediately before the write; never
   reuse a token across other writes.
3. **A conflict is information, not a retry hint.** Exit 13
   (`conflict`) means the file changed after your token. Re-inspect,
   look at what the file contains now, and decide deliberately.
   Blindly retrying with the new token discards the other writer's
   version - including a user's unsaved-then-saved editor work.
4. **Errors preserve everything.** A failed `build` never modifies the
   destination (publication is atomic, with a backup snapshot of the
   previous file retained next to it), and your source file is only
   ever read. Check `ok` before assuming a write happened.
5. **Extract is byte-exact; rendering is the renderer's.** `extract`
   returns the embedded source bytes unchanged (BOM, CRLF, formatting
   included). `verify` compares the stored preview against *this*
   renderer's output, so a mismatch can mean "rendered elsewhere",
   not corruption.

## Setup

Use the Core from a managed or pinned environment (see
[INSTALL.md](INSTALL.md)); the caller and the editor must agree on
the Core and its revision discipline, not necessarily on the
interpreter path. Confirm availability once:

```console
$ vector-png-editor --version
0.1.0.dev3
```

## The roundtrip

Create, read, edit, write back, and prove the result:

```console
$ vector-png-editor build a.svg a.png --width 16 --height 16
{"protocol":1,"command":"build","request_id":null,"ok":true,"result":{...,"png_sha256":"2bcb…885f8","preview":"match","backup":null}}

$ vector-png-editor inspect a.png
{"protocol":1,"command":"inspect","request_id":null,"ok":true,"result":{"kind":"vector-png","wire":"v1",...,"png_sha256":"2bcb…885f8","svg_bytes":114,...}}

$ vector-png-editor extract a.png out.svg
$ $EDITOR out.svg

$ vector-png-editor validate out.svg --width 16 --height 16
{"protocol":1,...,"ok":true,"result":{...,"profile_check":"passed","render":"passed",...}}

$ vector-png-editor build out.svg a.png --width 16 --height 16 \
    --overwrite --expected-sha256 2bcb…885f8
{"protocol":1,...,"ok":true,"result":{...,"preview":"match","backup":"a.<uuid>.backup"}}

$ vector-png-editor verify a.png
{"protocol":1,...,"ok":true,"result":{...,"preview":"match"}}
```

Notes:

- In the transcript, `extract` writes a file byte-identical to the embedded source, and the overwrite token is the `png_sha256` from the `inspect` immediately above it.
- `validate --syntax-only` checks XML and the safe-svg-v1 profile
  without rendering; the result then reports the render as not
  checked. Use the full form before publishing.
- `rebuild a.png out.png` re-renders the *embedded* source of an
  existing file (ignoring any edited copy) - the "regenerate the
  preview" operation. It follows the same revision rules.
- For programmatic single-request calls, `--request-json` reads one
  protocol-1 request (the bridge protocol in
  [BRIDGE.md](BRIDGE.md)) on stdin instead of subcommand arguments:
  `{"protocol":1,"command":"inspect","request_id":"x","input":"a.png"}`.

## The open-editor conflict

Scenario: a user has the file open in the editor with unsaved edits
while an automated caller works on the same file.

- The caller's reads (`inspect`, `extract`) are always safe: they see
  the last *saved* state. Unsaved editor edits are not on disk and no
  CLI operation can see or destroy them.
- If the user saves first, the file's revision changes. The caller's
  pending overwrite with the old token fails:

```console
$ vector-png-editor build mine.svg a.png --width 16 --height 16 \
    --overwrite --expected-sha256 <stale token>
{"protocol":1,"command":"build","request_id":null,"ok":false,"error":{"code":"conflict","message":"Output changed since the supplied revision"}}
(exit code 13; a.png is byte-identical to before the call)
```

- Correct responses, in order of preference: write to a *different*
  output path and let a human merge; or re-inspect, extract the new
  saved source, re-apply the intended change to it, validate, and
  overwrite with the fresh token. Never loop-retry.
- The mirror image also holds: if the caller saves first, the editor
  detects the external change, preserves the user's dirty buffer, and
  asks the user how to resolve it (P2-06). Neither side can silently
  overwrite the other.

## Exit codes

| Code | Meaning | Code | Meaning |
| --- | --- | --- | --- |
| 0 | ok | 8 | io-error |
| 2 | invalid-arguments | 9 | output-exists (no `--overwrite`) |
| 3 | invalid-container | 10 | render-failed |
| 4 | invalid-svg | 11 | render-timeout |
| 5 | unsupported-profile | 12 | render-mismatch (`verify`) |
| 6 | resource-limit | 13 | conflict |
| 7 | ordinary-png | 14 | cancelled |

## Tested workflow

`tests/integration/test_codex_workflow.py` executes this exact
roundtrip, the conflict scenario, error preservation and the
`--request-json` mode against the installed CLI:

```console
$ VECTOR_PNG_EDITOR_CLI=/path/to/vector-png-editor \
    python -m pytest tests/integration/test_codex_workflow.py -q
```

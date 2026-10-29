"""Cross-check driver for the TS Core port (tests/parity.test.mjs).

Usage: parity_driver.py MANIFEST_JSON RESULTS_JSON

The manifest and results travel as files, not stdio: the sandbox
proxies stdio over sockets whose buffers stall on multi-megabyte
payloads (observed: a 4 MB manifest deadlock), while the driver
genuinely needs megabytes (a 1 MB source fixture, 100k-code-point
attribute fixtures, the whole catalog).

Manifest:
  {"svg": [{"id": ..., "source_base64": ...}],
   "png": [{"id": ..., "png_base64": ...}],
   "build": {"source_base64": ..., "width": W, "height": H} | null,
   "normalize": [{"id": ..., "source_base64": ...}]}

Results:
  {"svg": {id: {"validate": {...}, "profile": {...},
                "profile_strict": {...}}},
   "png": {id: {"read": {...}, "inspect": {...}, "extract": {...}}},
   "build": {"png_base64": ...} | {"error": ...} | null,
   "normalize": {id: {"structure": {...}, "gated": {...}}}}

Every outcome is {"ok": true, ...} or
{"ok": false, "code": ..., "message": ...} (CoreError), so the Node
side can diff verdicts, codes, messages and full diagnostics.
Normalize outcomes add the failure "stage" (structure) and the
section 7 "report" (gated failures carry it in the error details).

Run with the Core sources on PYTHONPATH (the Node test arranges
that): PYTHONPATH=packages/core/src /tmp/buildenv/bin/python \
    tests/parity_driver.py manifest.json results.json
"""
import base64
import hashlib
import json
import sys
import tempfile
from pathlib import Path

from vector_png_editor.document import (
    extract_source,
    inspect_document,
    read_document_bytes,
)
from vector_png_editor.errors import CoreError
from vector_png_editor.normalize import (
    NormalizeFailure,
    normalize_document,
    normalize_structure,
)
from vector_png_editor.profile_check import check_profile
from vector_png_editor.svg import validate_source


def outcome(fn):
    try:
        return {"ok": True, "value": fn()}
    except CoreError as exc:
        return {"ok": False, "code": exc.code, "message": str(exc)}
    except Exception as exc:  # surface bugs distinctly from verdicts
        return {"fatal": f"{type(exc).__name__}: {exc}"}


def svg_outcomes(source):
    return {
        "validate": outcome(lambda: validate_source(source)),
        "profile": outcome(lambda: check_profile(source)),
        "profile_strict": outcome(
            lambda: check_profile(source, strict_structure=True)
        ),
    }


def png_outcomes(data, workdir):
    path = workdir / "case.png"
    path.write_bytes(data)

    def read():
        doc = read_document_bytes(data)
        return {
            "source_base64": (
                base64.b64encode(doc.source).decode()
                if doc.source is not None
                else None
            ),
            "width": doc.width,
            "height": doc.height,
            "color_type": doc.color_type,
            "bit_depth": doc.bit_depth,
            "interlace": doc.interlace,
            "png_sha256": doc.png_sha256,
        }

    def extract():
        out = workdir / "out.svg"
        if out.exists():
            out.unlink()
        extract_source(path, out)
        return {"svg_base64": base64.b64encode(out.read_bytes()).decode()}

    return {
        "read": outcome(read),
        "inspect": outcome(lambda: inspect_document(path)),
        "extract": outcome(extract),
    }


def normalize_outcomes(source, workdir, index):
    def structure():
        output, report = normalize_structure(source)
        return {
            "output_base64": base64.b64encode(output).decode(),
            "report": report,
        }

    def structure_outcome():
        try:
            return {"ok": True, "value": structure()}
        except NormalizeFailure as exc:
            return {
                "ok": False,
                "code": exc.code,
                "stage": exc.stage,
                "message": str(exc),
            }
        except Exception as exc:
            return {"fatal": f"{type(exc).__name__}: {exc}"}

    def gated_outcome():
        case_dir = workdir / f"gated-{index}"
        case_dir.mkdir(exist_ok=True)
        src = case_dir / "in.svg"
        src.write_bytes(source)
        try:
            report = normalize_document(
                src, case_dir / "out.svg", case_dir / "report.json"
            )
            return {
                "ok": True,
                "output_base64": base64.b64encode(
                    (case_dir / "out.svg").read_bytes()
                ).decode(),
                "report": report,
            }
        except CoreError as exc:
            return {
                "ok": False,
                "code": exc.code,
                "message": str(exc),
                "report": (exc.details or {}).get("report"),
            }
        except Exception as exc:
            return {"fatal": f"{type(exc).__name__}: {exc}"}

    return {"structure": structure_outcome(), "gated": gated_outcome()}


def main():
    manifest = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
    results = {"svg": {}, "png": {}, "build": None, "normalize": {}}
    for case in manifest.get("svg", []):
        source = base64.b64decode(case["source_base64"])
        results["svg"][case["id"]] = svg_outcomes(source)
    with tempfile.TemporaryDirectory() as tmp:
        workdir = Path(tmp)
        for index, case in enumerate(manifest.get("normalize", [])):
            source = base64.b64decode(case["source_base64"])
            results["normalize"][case["id"]] = normalize_outcomes(
                source, workdir, index
            )
        for case in manifest.get("png", []):
            data = base64.b64decode(case["png_base64"])
            results["png"][case["id"]] = png_outcomes(data, workdir)
        build = manifest.get("build")
        if build:
            try:
                from vector_png_editor import build_document

                source = base64.b64decode(build["source_base64"])
                target = workdir / "built.png"
                build_document(
                    source, target, build["width"], build["height"]
                )
                results["build"] = {
                    "png_base64": base64.b64encode(
                        target.read_bytes()
                    ).decode(),
                    "source_sha256": hashlib.sha256(source).hexdigest(),
                }
            except Exception as exc:
                results["build"] = {"error": f"{type(exc).__name__}: {exc}"}
    Path(sys.argv[2]).write_text(json.dumps(results), encoding="utf-8")


if __name__ == "__main__":
    main()

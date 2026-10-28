"""P3-01 integration test: the documented Codex CLI workflow.

Drives the installed `vector-png-editor` console script exactly as
docs/CODEX.md prescribes: a scripted roundtrip (build -> inspect ->
extract -> edit -> validate -> overwrite build with the expected
revision -> verify) and the open-editor dirty conflict scenario (a
second writer changes the file, after which a build carrying the
stale revision must fail with exit 13 and leave the file untouched).

The CLI is located via the VECTOR_PNG_EDITOR_CLI environment variable
or PATH; the tests skip when no Core installation is available.
"""
import hashlib
import json
import os
import shutil
import subprocess
import sys

import pytest

CLI = os.environ.get("VECTOR_PNG_EDITOR_CLI") or shutil.which("vector-png-editor")
pytestmark = pytest.mark.skipif(CLI is None, reason="vector-png-editor CLI not installed")

BLUE = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16" fill="#3366cc"/></svg>'
RED = BLUE.replace("#3366cc", "#cc3333")
GREEN = BLUE.replace("#3366cc", "#33cc33")
BROKEN = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'


def run(*args, expect=0):
    proc = subprocess.run([CLI, *args], capture_output=True, text=True, timeout=120)
    envelope = json.loads(proc.stdout)
    assert envelope["protocol"] == 1
    assert proc.returncode == expect, f"{args}: exit {proc.returncode}, envelope {envelope}"
    assert envelope["ok"] is (expect == 0)
    return envelope


def sha256(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def test_scripted_roundtrip(tmp_path):
    source = tmp_path / "a.svg"
    source.write_text(BLUE, encoding="utf-8")
    png = tmp_path / "a.png"
    built = run("--request-id", "it-1", "build", str(source), str(png), "--width", "16", "--height", "16")
    assert built["request_id"] == "it-1"
    assert built["result"]["preview"] == "match"

    inspected = run("inspect", str(png))["result"]
    assert inspected["kind"] == "vector-png"
    revision = inspected["png_sha256"]
    assert revision == sha256(png), "inspect reports the revision token of the actual bytes"

    extracted = tmp_path / "out.svg"
    run("extract", str(png), str(extracted))
    assert extracted.read_bytes() == BLUE.encode(), "extract is byte-exact"

    extracted.write_text(RED, encoding="utf-8")
    validated = run("validate", str(extracted), "--width", "16", "--height", "16")["result"]
    assert validated["profile_check"] == "passed" and validated["render"] == "passed"

    rebuilt = run("build", str(extracted), str(png), "--width", "16", "--height", "16",
                  "--overwrite", "--expected-sha256", revision)
    assert rebuilt["result"]["preview"] == "match"
    verified = run("verify", str(png))["result"]
    assert verified["preview"] == "match"
    assert verified["svg_sha256"] == hashlib.sha256(RED.encode()).hexdigest()


def test_dirty_conflict_scenario(tmp_path):
    # A document is "open in the editor": the caller holds revision T1
    # and an unsaved edited buffer (GREEN).
    source = tmp_path / "a.svg"
    source.write_text(BLUE, encoding="utf-8")
    png = tmp_path / "a.png"
    run("build", str(source), str(png), "--width", "16", "--height", "16")
    revision_t1 = run("inspect", str(png))["result"]["png_sha256"]

    # Another writer (the user saving in the editor) publishes RED
    # under the same revision discipline.
    other = tmp_path / "other.svg"
    other.write_text(RED, encoding="utf-8")
    run("build", str(other), str(png), "--width", "16", "--height", "16",
        "--overwrite", "--expected-sha256", revision_t1)
    after_external = sha256(png)

    # The first caller's overwrite with the now-stale revision must
    # conflict (exit 13) and preserve the current file byte for byte.
    mine = tmp_path / "mine.svg"
    mine.write_text(GREEN, encoding="utf-8")
    conflict = run("build", str(mine), str(png), "--width", "16", "--height", "16",
                   "--overwrite", "--expected-sha256", revision_t1, expect=13)
    assert conflict["error"]["code"] == "conflict"
    assert sha256(png) == after_external

    # Recovery is a fresh inspect, then a deliberate decision: here the
    # caller re-bases onto the current revision and overwrites.
    revision_t2 = run("inspect", str(png))["result"]["png_sha256"]
    assert revision_t2 == after_external
    run("build", str(mine), str(png), "--width", "16", "--height", "16",
        "--overwrite", "--expected-sha256", revision_t2)
    assert run("verify", str(png))["result"]["preview"] == "match"


def test_error_preserves_source_and_destination(tmp_path):
    source = tmp_path / "a.svg"
    source.write_text(BLUE, encoding="utf-8")
    png = tmp_path / "a.png"
    run("build", str(source), str(png), "--width", "16", "--height", "16")
    before = sha256(png)

    bad = tmp_path / "bad.svg"
    bad.write_text(BROKEN, encoding="utf-8")
    rejected = run("build", str(bad), str(png), "--width", "16", "--height", "16",
                   "--overwrite", "--expected-sha256", before, expect=5)
    assert rejected["error"]["code"] == "unsupported-profile"
    assert sha256(png) == before, "a failed build never touches the destination"
    assert bad.read_text(encoding="utf-8") == BROKEN, "the caller's source is preserved on error"


def test_request_json_mode_matches_subcommands(tmp_path):
    source = tmp_path / "a.svg"
    source.write_text(BLUE, encoding="utf-8")
    png = tmp_path / "a.png"
    run("build", str(source), str(png), "--width", "16", "--height", "16")
    request = {"protocol": 1, "command": "inspect", "request_id": "it-json", "input": str(png)}
    proc = subprocess.run([CLI, "--request-json"], input=json.dumps(request),
                          capture_output=True, text=True, timeout=120)
    assert proc.returncode == 0
    envelope = json.loads(proc.stdout)
    assert envelope["ok"] is True and envelope["request_id"] == "it-json"
    assert envelope["result"]["kind"] == "vector-png"


if __name__ == "__main__":
    sys.exit(pytest.main([__file__, "-q"]))

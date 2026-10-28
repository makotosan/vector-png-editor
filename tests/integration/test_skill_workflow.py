"""SC-10 (Issue #22): the Codex Skill workflow end to end.

Follows skills/vector-png/SKILL.md exactly, driving the installed
`vector-png-editor` console script: generate SVG XML -> validate with
--profile safe-svg-v1 -> build -> verify. The negative leg proves the
acceptance rule that a non-conforming SVG never overwrites an
existing vector-png: a `class` attribute fails the profile gate with
structured diagnostics and the PNG keeps its previous bytes.
"""
import hashlib
import json
import os
import shutil
import subprocess

import pytest

CLI = os.environ.get("VECTOR_PNG_EDITOR_CLI") or shutil.which("vector-png-editor")
pytestmark = pytest.mark.skipif(CLI is None, reason="vector-png-editor CLI not installed")

ARTWORK = (
    '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24">'
    '<defs><linearGradient id="g"><stop offset="0" stop-color="#ff8800"/>'
    '<stop offset="1" stop-color="#0044cc"/></linearGradient>'
    '<clipPath id="c"><circle cx="12" cy="12" r="10"/></clipPath></defs>'
    '<g clip-path="url(#c)"><rect width="24" height="24" fill="url(#g)"/>'
    '<text x="4" y="15" font-size="7" fill="#ffffff">A<tspan dx="1">B</tspan></text></g></svg>'
)


def run(*args, expect=0):
    proc = subprocess.run([CLI, *args], capture_output=True, text=True, timeout=120)
    envelope = json.loads(proc.stdout)
    assert proc.returncode == expect, f"{args}: exit {proc.returncode}, envelope {envelope}"
    assert envelope["ok"] is (expect == 0)
    return envelope


def sha256(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def test_sc10_generate_validate_build_verify(tmp_path):
    svg = tmp_path / "artwork.svg"
    svg.write_text(ARTWORK, encoding="utf-8")
    run("validate", str(svg), "--profile", "safe-svg-v1")
    png = tmp_path / "artwork.png"
    run("build", str(svg), str(png), "--width", "24", "--height", "24")
    verified = run("verify", str(png))
    assert verified["result"]["profile_check"] == "passed"
    assert verified["result"]["preview"] == "match"

    # Skill revision flow: a conforming edit replaces the PNG only
    # with the inspected revision.
    edited = tmp_path / "artwork2.svg"
    edited.write_text(ARTWORK.replace("#ff8800", "#00aa55"), encoding="utf-8")
    run("validate", str(edited), "--profile", "safe-svg-v1")
    revision = run("inspect", str(png))["result"]["png_sha256"]
    run("build", str(edited), str(png), "--width", "24", "--height", "24",
        "--overwrite", "--expected-sha256", revision)
    run("verify", str(png))


def test_sc10_nonconforming_svg_never_overwrites(tmp_path):
    svg = tmp_path / "artwork.svg"
    svg.write_text(ARTWORK, encoding="utf-8")
    png = tmp_path / "artwork.png"
    run("build", str(svg), str(png), "--width", "24", "--height", "24")
    before = sha256(png)

    bad = tmp_path / "bad.svg"
    bad.write_text(ARTWORK.replace("<rect ", '<rect class="hero" '), encoding="utf-8")
    envelope = run("validate", str(bad), "--profile", "safe-svg-v1", expect=5)
    diagnostics = envelope["error"]["details"]["diagnostics"]
    assert any(d["attribute"] == "class" and d["code"] == "unsupported-attribute" for d in diagnostics)
    # The Skill stops here: no build is attempted, and the existing
    # PNG is byte-identical.
    assert sha256(png) == before

"""Issue #22 Phase 1 + Phase 3 (schema layer): policy parity,
generated-artifact drift, structured diagnostics, and the SC cases
that apply to the schema/validator layer (SC-01..SC-09, SC-11, SC-12).
"""
import base64
import json
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "tools"))
from generate_safe_svg_schemas import parse_policy, build_artifacts, manifest  # noqa: E402

from vector_png_editor import _backend  # noqa: E402
from vector_png_editor.profile_check import check_profile, CONTENT_MODELS  # noqa: E402
from vector_png_editor.svg import validate_source  # noqa: E402
from vector_png_editor.errors import CoreError  # noqa: E402

POLICY = parse_policy((ROOT / "schemas" / "safe-svg-v1.policy.yaml").read_text(encoding="utf-8"))

VALID = ('<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16">'
         '<defs><linearGradient id="g"><stop offset="0" stop-color="#f00"/>'
         '<stop offset="1" stop-color="#00f"/></linearGradient>'
         '<clipPath id="c"><rect width="8" height="16"/></clipPath></defs>'
         '<g clip-path="url(#c)"><rect width="16" height="16" fill="url(#g)"/>'
         '<text x="1" y="9" font-size="6">A<tspan dx="1">B</tspan></text></g></svg>')


def codes(source: str, **kwargs):
    return [d["code"] for d in check_profile(source.encode(), **kwargs)]


def test_policy_matches_core_allowlists_and_limits():
    assert set(POLICY["elements"]) == _backend.TAGS
    assert set(POLICY["attributes"]) == _backend.ATTRS
    assert POLICY["max_bytes"] == 1_000_000
    assert POLICY["max_elements"] == 5000 and POLICY["max_depth"] == 32
    assert set(POLICY["url_attributes"]) == {"fill", "stroke", "clip-path"}


def test_content_models_match_policy():
    for element, model in POLICY["content_models"].items():
        expected = set() if model == "none" else {n.strip() for n in model.split(",")}
        assert CONTENT_MODELS[element] == expected, element


def test_generated_artifacts_do_not_drift():
    artifacts = build_artifacts(POLICY)
    artifacts["safe-svg-v1.manifest.json"] = manifest(POLICY, artifacts)
    for name, text in artifacts.items():
        committed = (ROOT / "schemas" / name).read_text(encoding="utf-8")
        assert committed == text, f"schemas/{name} drifted; run tools/generate_safe_svg_schemas.py"


def test_sc01_allowed_only_passes_strict():
    assert check_profile(VALID.encode(), strict_structure=True) == []


def test_sc02_undefined_element_fails():
    bad = VALID.replace("<rect width=\"16\"", "<image width=\"16\"")
    assert "unsupported-element" in codes(bad, strict_structure=True)


def test_sc03_undefined_attribute_class_fails_with_suggestion():
    bad = VALID.replace('<g clip-path', '<g class="hero" clip-path')
    diags = check_profile(bad.encode(), strict_structure=True)
    hit = [d for d in diags if d["code"] == "unsupported-attribute" and d["attribute"] == "class"]
    assert hit and "presentation attributes" in hit[0]["suggestion"]
    assert hit[0]["line"] == 1 and hit[0]["severity"] == "error"


def test_sc04_invalid_attribute_value_fails():
    bad = VALID.replace('fill="url(#g)"', 'fill="red;behavior:url(x)"')
    assert "forbidden-value" in codes(bad, strict_structure=True)


def test_sc05_unsupported_parent_child_fails_strict_but_not_compat():
    bad = ('<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8">'
           '<g><stop offset="0"/></g></svg>')
    assert "structure" in codes(bad, strict_structure=True)
    assert check_profile(bad.encode()) == [], "Core acceptance has no parent-child rules (compat preserved)"


def test_sc06_external_reference_fails():
    bad = VALID.replace('fill="url(#g)"', 'fill="url(https://example.com/x.svg#g)"')
    assert "invalid-url" in codes(bad, strict_structure=True)
    bad2 = VALID.replace('fill="url(#g)"', 'fill="url(#missing)"')
    assert "unresolved-reference" in codes(bad2, strict_structure=True)


def test_sc07_script_and_event_attributes_fail():
    bad = VALID.replace("</svg>", "<script>alert(1)</script></svg>")
    assert "unsupported-element" in codes(bad, strict_structure=True)
    bad2 = VALID.replace("<rect width=\"8\"", "<rect onclick=\"x()\" width=\"8\"")
    diags = check_profile(bad2.encode(), strict_structure=True)
    assert any(d["code"] == "unsupported-attribute" and d["attribute"] == "onclick" for d in diags)


def test_sc08_complex_supported_artwork_passes():
    assert check_profile(VALID.encode(), strict_structure=True) == []
    validate_source(VALID.encode())  # and the Core acceptance path agrees


def test_sc09_rng_and_validator_agree_on_the_shared_surface():
    rng = (ROOT / "schemas" / "safe-svg-v1.rng").read_text(encoding="utf-8")
    for element in POLICY["elements"]:
        assert f'<define name="el.{element}">' in rng
        assert f'<element name="{element}">' in rng
    for attribute in POLICY["attributes"]:
        assert f'<attribute name="{attribute}">' in rng
    monaco = json.loads((ROOT / "schemas" / "safe-svg-v1.monaco.json").read_text(encoding="utf-8"))
    assert {e["name"] for e in monaco["elements"]} == set(POLICY["elements"]) == _backend.TAGS
    assert set(monaco["attributes"]) == set(POLICY["attributes"]) == _backend.ATTRS


def test_sc11_extracted_source_revalidates(tmp_path):
    from vector_png_editor.writing import build_document
    from vector_png_editor.document import read_document_bytes
    out = tmp_path / "a.png"
    build_document(VALID.encode(), out, 16, 16)
    document = read_document_bytes(out.read_bytes())
    assert check_profile(document.source, strict_structure=True) == []


def test_sc12_existing_fixture_sources_still_validate():
    vectors = json.loads((ROOT / "packages" / "core" / "tests" / "fixtures" / "vectors.json").read_text())
    checked = 0
    for fixture in vectors["fixtures"]:
        if "source_base64" not in fixture:
            continue
        raw = base64.b64decode(fixture["source_base64"])
        try:
            validate_source(raw)
        except CoreError:
            continue  # intentionally invalid fixtures are not valid files
        checked += 1
        assert check_profile(raw) == [], fixture["name"]
    assert checked >= 5


def test_cli_profile_gate_reports_diagnostics(tmp_path):
    bad = tmp_path / "bad.svg"
    bad.write_text(VALID.replace('<g clip-path', '<g class="x" clip-path'), encoding="utf-8")
    proc = subprocess.run(
        [sys.executable, "-m", "vector_png_editor", "validate", str(bad),
         "--profile", "safe-svg-v1", "--syntax-only"],
        capture_output=True, text=True, timeout=60,
        env={"PATH": __import__("os").environ["PATH"], "PYTHONPATH": str(ROOT / "packages" / "core" / "src")})
    assert proc.returncode == 5
    envelope = json.loads(proc.stdout)
    diags = envelope["error"]["details"]["diagnostics"]
    assert diags[0]["code"] == "unsupported-attribute" and diags[0]["attribute"] == "class"
    good = tmp_path / "good.svg"
    good.write_text(VALID, encoding="utf-8")
    proc2 = subprocess.run(
        [sys.executable, "-m", "vector_png_editor", "validate", str(good),
         "--profile", "safe-svg-v1", "--syntax-only"],
        capture_output=True, text=True, timeout=60,
        env={"PATH": __import__("os").environ["PATH"], "PYTHONPATH": str(ROOT / "packages" / "core" / "src")})
    assert proc2.returncode == 0 and json.loads(proc2.stdout)["ok"] is True

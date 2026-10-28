"""svg-normalization-v1 normalizer tests (Issue #48).

Fixtures under tests/fixtures/normalization are vendored verbatim from
makotosan/vector-png-spec at the pinned revision (see PROVENANCE.md in
that directory). Structural expectations mirror the spec repository's
own fixture tests; the production entry points additionally exercise
the rendering gate and the section 6 publication rules.
"""
import hashlib
import json
from pathlib import Path
import xml.etree.ElementTree as ET

import pytest

from vector_png_editor.cli import main
from vector_png_editor.errors import CoreError
from vector_png_editor.normalize import (NormalizeFailure, convert_document,
                                         normalize_document, normalize_structure)
from vector_png_editor.profile_check import check_profile
from vector_png_editor.writing import verify_document

FIXTURES = Path(__file__).parent / "fixtures" / "normalization"
NS = "{http://www.w3.org/2000/svg}"
CASES = json.loads((FIXTURES / "cases.json").read_text(encoding="utf-8"))


def case(name):
    return next(c for c in CASES if c["id"] == name)


def code_of(source: bytes) -> str:
    with pytest.raises(NormalizeFailure) as caught:
        normalize_structure(source)
    return caught.value.code


# ---------------------------------------------------------------- spec fixtures

# Pinned-catalog expectations reversed by a spec amendment this branch
# anticipates (makotosan/vector-png-spec#3): G2 admits absolute C
# marker hosts, so "unsupported-marker-host" - a curved host the
# pre-amendment section 3.1 rejected - now normalizes successfully.
# The fixture data itself stays verbatim (see PROVENANCE.md); the
# override lives here and in docs/SPEC_COMPATIBILITY.md until the pin
# bump replaces the catalog with the amended one.
AMENDMENT_SUPERSEDED = {"unsupported-marker-host": "accept"}


@pytest.mark.parametrize("fixture", CASES, ids=[c["id"] for c in CASES])
def test_fixture_cases(fixture):
    if AMENDMENT_SUPERSEDED.get(fixture["id"], fixture["expect"]) == "accept":
        output, report = normalize_structure(fixture["input"].encode())
        ET.fromstring(output)  # well-formed
        assert report["checks"]["input"] == "pass"
        assert report["checks"]["safe_svg"] == "pass"
        assert report["checks"]["render"] == "not-checked"  # analysis only
        assert report["checks"]["authenticity"] == "not-verified"
    else:
        assert code_of(fixture["input"].encode()) == fixture["expect"]


def test_nameplate_golden_output_and_report():
    source = (FIXTURES / "nameplate.input.svg").read_bytes()
    output, report = normalize_structure(source)
    assert output == (FIXTURES / "nameplate.expected.svg").read_bytes()
    expected = json.loads((FIXTURES / "nameplate.expected-report.json").read_text(encoding="utf-8"))
    for field in ("profile", "changes", "accessibility", "checks", "warnings", "errors"):
        assert report[field] == expected[field], field
    assert report["input_sha256"] == expected["input_sha256"]
    assert report["changes"]["class_attributes"] == 26
    assert report["changes"]["style_elements"] == 1
    before = ET.fromstring(source).find(f".//{NS}path[@id='qr']")
    after = ET.fromstring(output).find(f".//{NS}path[@id='qr']")
    assert before.get("d") == after.get("d")


# ---------------------------------------------------------------- cascade (profile section 4)

def test_cascade_specificity_inheritance_and_group_opacity():
    output, _ = normalize_structure(case("cascade")["input"].encode())
    root = ET.fromstring(output)
    group = list(root)[0]
    assert group.get("opacity") == "0.5"  # group opacity is not flattened
    first, second, circle = list(group)
    assert first.get("fill") == "green"   # #id beats .class and element rules
    assert second.get("fill") == "navy"   # inline style, later duplicate wins
    assert circle.get("fill") is None     # inherits g fill=purple, not materialized
    assert all(node.get("opacity") is None for node in group)
    assert b"class=" not in output and b"style=" not in output


def test_source_order_and_selector_lists():
    output, _ = normalize_structure(case("source-order")["input"].encode())
    assert ET.fromstring(output)[0].get("fill") == "red"  # later rule wins ties
    output, _ = normalize_structure(case("selector-list")["input"].encode())
    root = ET.fromstring(output)
    assert root[0].get("fill") == "blue" and root[1].get("fill") == "blue"


# ---------------------------------------------------------------- CSS parser rejections

@pytest.mark.parametrize("css", [
    ".a .b {fill: red}",              # descendant combinator
    ".a.b {fill: red}",               # compound selector
    "* {fill: red}",                  # universal selector
    "rect[fill] {fill: red}",         # attribute selector
    "@media screen {.a {fill: red}}",  # at-rule
    ".a {--brand: red}",              # custom property
    ".a {margin: 0}",                 # shorthand/unknown property
    ".a {fill: var(--x)}",            # var()
    ".a {fill: currentColor}",        # keyword outside the table
    ".a {fill: 10%}",                 # percentage
    ".a {stroke-width: 1e3}",         # exponent
    ".a {letter-spacing: normal}",    # G1 grammar: the keyword is not accepted
    ".a {letter-spacing: 1em}",       # G1 grammar: px is the only unit
    ".a {fill: red !important}",      # !important in a rule
    ".a {fill: }",                    # empty value
    ".a {fill red}",                  # missing colon
    ".a fill: red}",                  # missing block
])
def test_css_rejections(css):
    svg = f'<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><style>{css}</style><rect width="5" height="5"/></svg>'
    assert code_of(svg.encode()) == "unsupported-css"


def test_inline_important_and_bad_inline_value_rejected():
    svg = ('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10">'
           '<rect width="5" height="5" style="fill: red !important"/></svg>')
    assert code_of(svg.encode()) == "unsupported-css"
    svg = ('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10">'
           '<rect width="5" height="5" style="font-size: 2em"/></svg>')
    assert code_of(svg.encode()) == "unsupported-css"


def test_leading_hyphen_font_family_accepted():
    # Profile text: "unquoted words" - a leading-hyphen CSS identifier
    # such as -apple-system is accepted (spec gap G3 clarification).
    svg = ('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10">'
           "<style>text{font-family:-apple-system,BlinkMacSystemFont,\"Yu Gothic\",sans-serif}</style>"
           '<text x="1" y="9">A</text></svg>')
    output, _ = normalize_structure(svg.encode())
    assert ET.fromstring(output).find(f"{NS}text").get("font-family").startswith("-apple-system")


# ---------------------------------------------------------------- markers (profile section 3.1)

def test_marker_expansion_geometry():
    output, report = normalize_structure(case("rounded-diagram-arrows")["input"].encode())
    assert report["changes"]["expanded_markers"] == 2
    root = ET.fromstring(output)
    groups = [n for n in root.iter(f"{NS}g") if n.get("transform", "").startswith("translate(")]
    assert len(groups) == 2
    # Horizontal host M70 30 H130, stroke-width 2 (strokeWidth units):
    assert groups[0].get("transform") == "translate(130 30) rotate(0) scale(2) translate(-10 -6)"
    assert groups[0].get("fill") == "#363636" and groups[0].get("stroke") == "none"
    # Returning host ends at (40,70) heading up: tangent angle -90.
    assert groups[1].get("transform") == "translate(40 70) rotate(-90) scale(2) translate(-10 -6)"
    assert b"marker" not in output


def test_marker_user_space_units_do_not_scale():
    svg = ('<svg xmlns="http://www.w3.org/2000/svg" width="60" height="40"><defs>'
           '<marker id="a" markerWidth="12" markerHeight="12" refX="10" refY="6" orient="auto" markerUnits="userSpaceOnUse">'
           '<path d="M0,0 L12,6 L0,12 Z" fill="black"/></marker></defs>'
           '<path d="M5 20 H50" fill="none" stroke="black" stroke-width="4" marker-end="url(#a)"/></svg>')
    output, report = normalize_structure(svg.encode())
    assert report["changes"]["expanded_markers"] == 1
    group = next(n for n in ET.fromstring(output).iter(f"{NS}g"))
    assert "scale(1)" in group.get("transform")


def test_unused_marker_definitions_are_validated():
    prefix = '<svg xmlns="http://www.w3.org/2000/svg"><defs>'
    suffix = "</defs></svg>"
    triangle = '<path d="M0,0 L12,6 L0,12 Z" fill="black"/>'
    valid = f'<marker id="m" markerWidth="12" markerHeight="12" orient="auto">{triangle}</marker>'
    normalize_structure((prefix + valid + suffix).encode())
    for definition in (
        '<marker id="m" viewBox="0 0 12 12"/>',
        valid.replace('orient="auto"', 'orient="auto-start-reverse"'),
        valid.replace('markerWidth="12"', 'markerWidth="0"'),
        valid.replace(triangle, '<circle r="5"/>'),
    ):
        assert code_of((prefix + definition + suffix).encode()) == "unsupported-css"
    # Lowercase closepath is the same triangle (corpus files use z).
    normalize_structure((prefix + valid.replace("Z", "z") + suffix).encode())


def test_curved_marker_host_expands_with_cubic_end_tangent():
    # Amendment G2: a final C segment's tangent is endpoint minus
    # second control point - here (50,20)-(25,20), pointing +x.
    svg = ('<svg xmlns="http://www.w3.org/2000/svg" width="60" height="40"><defs>'
           '<marker id="a" markerWidth="12" markerHeight="12" refX="10" refY="6" orient="auto">'
           '<path d="M0,0 L12,6 L0,12 Z" fill="black"/></marker></defs>'
           '<path d="M5 20 C15 20 25 20 50 20" fill="none" marker-end="url(#a)"/></svg>')
    output, report = normalize_structure(svg.encode())
    assert report["changes"]["expanded_markers"] == 1
    group = next(n for n in ET.fromstring(output).iter(f"{NS}g"))
    assert group.get("transform") == "translate(50 20) rotate(0) scale(1) translate(-10 -6)"


def test_curved_marker_host_tangent_fallbacks():
    head = ('<svg xmlns="http://www.w3.org/2000/svg" width="60" height="40"><defs>'
            '<marker id="a" markerWidth="12" markerHeight="12" refX="10" refY="6" orient="auto">'
            '<path d="M0,0 L12,6 L0,12 Z" fill="black"/></marker></defs>')
    # Endpoint equals the second control point: fall back to endpoint
    # minus first control point, here (30,10)-(20,10), still +x.
    svg = head + '<path d="M10 10 C20 10 30 10 30 10" fill="none" marker-end="url(#a)"/></svg>'
    output, _ = normalize_structure(svg.encode())
    group = next(n for n in ET.fromstring(output).iter(f"{NS}g"))
    assert "rotate(0)" in group.get("transform")
    # Both control points coincide with the endpoint: degenerate.
    svg = head + '<path d="M10 10 C10 10 10 10 10 10" fill="none" marker-end="url(#a)"/></svg>'
    assert code_of(svg.encode()) == "unsupported-css"
    # S/Q/T segments remain rejected under G2.
    for d in ("M5 20 S25 20 50 20", "M5 20 Q25 20 50 20", "M5 20 T50 20"):
        svg = head + f'<path d="{d}" fill="none" marker-end="url(#a)"/></svg>'
        assert code_of(svg.encode()) == "unsupported-css", d


# ------------------------------------------------- spec amendments G1/G2/G3
# Synthetic cases mirroring the fixtures being added to
# makotosan/vector-png-spec under spec#3 (same ids, same inputs).

AMENDMENT_CASES = {
    "letter-spacing":
        '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="80">'
        "<style>.brand {font-family: sans-serif; font-size: 20px; letter-spacing: 2px; fill: #222}</style>"
        '<text class="brand" x="10" y="40">ACME</text></svg>',
    "curved-marker-host":
        '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="120" role="img" aria-labelledby="t">'
        '<title id="t">Curved arrow</title><defs>'
        '<marker id="arrow" markerWidth="12" markerHeight="12" refX="10" refY="6" orient="auto">'
        '<path d="M0,0 L12,6 L0,12 Z" fill="#363636"/></marker>'
        "<style>.arrow {fill: none; stroke: black; stroke-width: 2; marker-end: url(#arrow)}</style></defs>"
        '<path class="arrow" d="M20 90 C60 90 80 30 130 30"/></svg>',
    "font-family-system-names":
        '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="80">'
        '<style>text {font-family: -apple-system,BlinkMacSystemFont,"Yu Gothic",sans-serif; font-size: 16px}</style>'
        '<text x="10" y="40">Text</text></svg>',
}


@pytest.mark.parametrize("case_id", sorted(AMENDMENT_CASES))
def test_amendment_cases_accept(case_id):
    output, report = normalize_structure(AMENDMENT_CASES[case_id].encode())
    ET.fromstring(output)  # well-formed, and revalidated inside the transform
    assert report["checks"]["input"] == "pass"
    assert report["checks"]["safe_svg"] == "pass"


def test_amendment_letter_spacing_materializes():
    output, _ = normalize_structure(AMENDMENT_CASES["letter-spacing"].encode())
    text = ET.fromstring(output).find(f"{NS}text")
    assert text.get("letter-spacing") == "2px"
    assert b"class=" not in output


def test_amendment_letter_spacing_presentation_attribute_and_sign():
    # The presentation attribute is accepted with the same grammar,
    # including a negative (signed) value, and survives to the output.
    svg = ('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10">'
           '<text x="1" y="9" letter-spacing="-0.5px">A</text></svg>')
    output, _ = normalize_structure(svg.encode())
    assert ET.fromstring(output).find(f"{NS}text").get("letter-spacing") == "-0.5px"


def test_amendment_curved_marker_host_geometry():
    output, report = normalize_structure(AMENDMENT_CASES["curved-marker-host"].encode())
    assert report["changes"]["expanded_markers"] == 1
    group = next(n for n in ET.fromstring(output).iter(f"{NS}g"))
    # Endpoint (130,30); tangent (130,30)-(80,30) is +x, so rotate(0).
    assert group.get("transform") == "translate(130 30) rotate(0) scale(2) translate(-10 -6)"
    assert b"marker" not in output


def test_amendment_font_family_system_names_materialize():
    output, _ = normalize_structure(AMENDMENT_CASES["font-family-system-names"].encode())
    family = ET.fromstring(output).find(f"{NS}text").get("font-family")
    assert family.startswith("-apple-system") and '"Yu Gothic"' in family


def test_letter_spacing_profile_gate():
    # validate --profile safe-svg-v1: letter-spacing is now accepted,
    # class/style remain rejected (Issue #22 gate + G1).
    assert check_profile(
        b'<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10">'
        b'<text x="1" y="9" letter-spacing="1px">A</text></svg>',
        strict_structure=True) == []
    bad = ('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10">'
           '<text class="a" x="1" y="9">A</text></svg>')
    assert "unsupported-attribute" in [d["code"] for d in check_profile(bad.encode(), strict_structure=True)]


# ---------------------------------------------------------------- accessibility (profile section 5)

def test_accessibility_migration_records():
    output, report = normalize_structure(case("accessibility")["input"].encode())
    root = ET.fromstring(output)
    assert root.find(f"{NS}title").text == "Example"
    records = {r["attribute"]: r for r in report["accessibility"]}
    assert records["aria-labelledby"]["target"] == "title"
    assert records["aria-describedby"]["target"] == "desc"
    assert records["aria-label"]["loss"] == "lower-priority-label"
    assert records["role"]["loss"] == "unsupported-semantics"
    assert records["aria-live"]["loss"] == "unsupported-semantics"
    assert b"aria-" not in output and b"role=" not in output
    assert any(w["code"] == "accessibility-loss" for w in report["warnings"])


def test_accessibility_replaced_text_is_recorded_as_loss():
    _, report = normalize_structure(case("rounded-diagram-arrows")["input"].encode())
    replaced = [r for r in report["accessibility"] if r.get("loss") == "replaced-text"]
    assert replaced and replaced[0]["attribute"] == "title" and replaced[0]["value"] == "Public diagram"


# ---------------------------------------------------------------- resource limits

@pytest.mark.parametrize("data", [
    b" " * 1_000_001,
    ('<svg xmlns="http://www.w3.org/2000/svg">' + "<g>" * 33 + "</g>" * 33 + "</svg>").encode(),
    ('<svg xmlns="http://www.w3.org/2000/svg">' + "<rect/>" * 5000 + "</svg>").encode(),
    ('<svg xmlns="http://www.w3.org/2000/svg"><style>' + " " * 100001 + "</style></svg>").encode(),
    ('<svg xmlns="http://www.w3.org/2000/svg"><style>' + ",".join(".c" + str(i) for i in range(1001)) + "{fill:red}</style></svg>").encode(),
])
def test_resource_limits(data):
    assert code_of(data) == "resource-limit"


# ---------------------------------------------------------------- gated entry points (sections 6-7)

def _write(tmp_path, name, data: bytes) -> Path:
    path = tmp_path / name
    path.write_bytes(data)
    return path


def test_normalize_document_success_and_input_preservation(tmp_path):
    source = _write(tmp_path, "in.svg", case("cascade")["input"].encode())
    before = source.read_bytes()
    report = normalize_document(source, tmp_path / "out.svg", tmp_path / "report.json")
    assert report["status"] == "success"
    assert report["checks"] == {"input": "pass", "safe_svg": "pass", "render": "pass",
                                 "container": "not-applicable", "authenticity": "not-verified"}
    out_bytes = (tmp_path / "out.svg").read_bytes()
    assert report["output_sha256"] == hashlib.sha256(out_bytes).hexdigest()
    assert json.loads((tmp_path / "report.json").read_text(encoding="utf-8")) == report
    assert source.read_bytes() == before


def test_normalize_document_failure_writes_report_only(tmp_path):
    svg = ('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10">'
           "<style>.a{margin:0}</style>"
           '<rect class="a" width="5" height="5"/></svg>').encode()
    source = _write(tmp_path, "in.svg", svg)
    with pytest.raises(CoreError) as caught:
        normalize_document(source, tmp_path / "out.svg", tmp_path / "report.json")
    assert caught.value.code == "unsupported-css"
    assert not (tmp_path / "out.svg").exists()
    report = json.loads((tmp_path / "report.json").read_text(encoding="utf-8"))
    assert report["status"] == "failure" and report["output_sha256"] is None
    assert report["errors"][0]["code"] == "unsupported-css"
    assert report["checks"]["render"] == "not-checked"
    assert source.read_bytes() == svg


def test_publication_no_clobber_and_alias(tmp_path):
    source = _write(tmp_path, "in.svg", case("cascade")["input"].encode())
    _write(tmp_path, "out.svg", b"keep me")
    with pytest.raises(CoreError) as caught:
        normalize_document(source, tmp_path / "out.svg", tmp_path / "report.json")
    assert caught.value.code == "output-exists"
    assert (tmp_path / "out.svg").read_bytes() == b"keep me"
    assert not (tmp_path / "report.json").exists()
    with pytest.raises(CoreError) as caught:
        normalize_document(source, source, tmp_path / "report.json")
    assert caught.value.code == "output-alias"
    with pytest.raises(CoreError) as caught:
        normalize_document(source, tmp_path / "pair.svg", tmp_path / "pair.svg")
    assert caught.value.code == "output-alias"


def test_render_gate_mismatch_fails_and_publishes_no_output(tmp_path, monkeypatch):
    # The gate's comparison/failure path, exercised by making the
    # after-render legitimately differ (shifted viewport) through the
    # module's render seam. Real-renderer equality is covered by the
    # success tests and the corpus checks.
    import vector_png_editor.normalize as normalize_module

    real_render = normalize_module.render_source

    def shifted(source, width=1024, height=1024):
        return real_render(source, width + 1, height)

    monkeypatch.setattr(normalize_module, "render_source", shifted)
    source = _write(tmp_path, "in.svg", case("cascade")["input"].encode())
    with pytest.raises(CoreError) as caught:
        normalize_document(source, tmp_path / "out.svg", tmp_path / "report.json")
    assert caught.value.code == "render-mismatch"
    assert not (tmp_path / "out.svg").exists()
    report = json.loads((tmp_path / "report.json").read_text(encoding="utf-8"))
    assert report["checks"]["render"] == "mismatch"
    assert report["errors"][0]["code"] == "render-mismatch"


def test_convert_document_produces_verified_vector_png(tmp_path):
    source = _write(tmp_path, "in.svg", (FIXTURES / "nameplate.input.svg").read_bytes())
    report = convert_document(source, tmp_path / "out.png", tmp_path / "report.json")
    assert report["status"] == "success"
    assert report["checks"]["container"] == "pass"
    assert report["checks"]["render"] == "pass"
    png = tmp_path / "out.png"
    assert report["output_sha256"] == hashlib.sha256(png.read_bytes()).hexdigest()
    verified = verify_document(png)
    assert verified["preview"] == "match"
    from vector_png_editor.document import read_document_bytes
    embedded = read_document_bytes(png.read_bytes()).source
    assert embedded == (FIXTURES / "nameplate.expected.svg").read_bytes()


def test_cli_normalize_and_convert_envelopes(tmp_path, capsys):
    source = _write(tmp_path, "in.svg", case("rounded-diagram-arrows")["input"].encode())
    status = main(["normalize", str(source), str(tmp_path / "o.svg"), "--report", str(tmp_path / "r.json")])
    envelope = json.loads(capsys.readouterr().out)
    assert status == 0 and envelope["ok"] and envelope["result"]["status"] == "success"
    assert envelope["result"]["changes"]["expanded_markers"] == 2
    bad = _write(tmp_path, "bad.svg", b'<svg xmlns="http://www.w3.org/2000/svg"><style>.a{margin:0}</style></svg>')
    status = main(["normalize", str(bad), str(tmp_path / "o2.svg"), "--report", str(tmp_path / "r2.json")])
    envelope = json.loads(capsys.readouterr().out)
    assert status == 5 and not envelope["ok"] and envelope["error"]["code"] == "unsupported-css"
    assert not (tmp_path / "o2.svg").exists()

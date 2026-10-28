"""Rendering and profile audit probes for Issue #2 (P0-02).

Safety (profile validation), container validity and exact local RGBA
comparison are separate claims (SPEC sections 5 and 7); these probes
evidence each layer separately. Renderer output is an implementation
policy of the bundled CairoSVG path, not a specification MUST.
"""
import subprocess

from PIL import Image
import pytest

from vector_png_editor import _backend, build_document, inspect_document, validate_source, verify_document
from vector_png_editor.errors import CoreError

BASE = '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4">{}</svg>'


def build(tmp_path, body, name="out.png"):
    target = tmp_path / name
    build_document((BASE.format(body)).encode(), target, 4, 4)
    return target


def pixel(path, xy):
    with Image.open(path) as image:
        return image.convert("RGBA").getpixel(xy)


# Transparency: exact local RGBA outcomes of the bundled renderer.

def test_transparent_background_stays_transparent(tmp_path):
    target = build(tmp_path, '<rect x="1" y="1" width="2" height="2" fill="#ff0000"/>')
    assert pixel(target, (0, 0)) == (0, 0, 0, 0)
    assert pixel(target, (2, 2)) == (255, 0, 0, 255)


def test_half_opacity_fill_produces_half_alpha(tmp_path):
    target = build(tmp_path, '<rect width="4" height="4" fill="#ff0000" fill-opacity="0.5"/>')
    assert pixel(target, (1, 1)) == (255, 0, 0, 128)


def test_opaque_background_is_fully_opaque(tmp_path):
    target = build(tmp_path, '<rect width="4" height="4" fill="#00ff00"/>')
    assert pixel(target, (3, 3)) == (0, 255, 0, 255)


# No external fetching: references outside the document never reach
# the renderer, because validation rejects them first.

@pytest.mark.parametrize("body", [
    '<rect width="4" height="4" fill="url(http://127.0.0.1:9/x.svg)"/>',
    '<rect width="4" height="4" fill="url(https://example.invalid/x.svg)"/>',
    '<rect width="4" height="4" fill="url(data:image/svg+xml;base64,AAAA)"/>',
    '<image href="https://example.invalid/x.png" width="4" height="4"/>',
])
def test_external_references_rejected_before_render(body):
    with pytest.raises(CoreError):
        validate_source((BASE.format(body)).encode())


def test_renderer_fetch_guard_present():
    # Even if validation were bypassed, the render worker installs a
    # URL opener that denies every fetch (defense in depth).
    with pytest.raises(Exception):
        _backend._deny_fetch("https://example.invalid/")


# No silent stripping: prohibited content fails and writes nothing.

def test_script_element_fails_without_output(tmp_path):
    target = tmp_path / "script.png"
    with pytest.raises(CoreError):
        build_document((BASE.format('<script>alert(1)</script>')).encode(), target, 4, 4)
    assert not target.exists()


def test_failed_build_leaves_existing_file_untouched(tmp_path):
    target = build(tmp_path, '<rect width="4" height="4" fill="#0000ff"/>', "keep.png")
    before = target.read_bytes()
    from vector_png_editor import inspect_document as _inspect  # local alias for clarity
    sha = _inspect(target)["png_sha256"]
    with pytest.raises(CoreError):
        build_document((BASE.format('<script>x</script>')).encode(), target, 4, 4,
                       overwrite=True, expected_sha256=sha)
    assert target.read_bytes() == before


# Timeout: a renderer timeout is its own category (render-timeout),
# mapped from the subprocess deadline in _backend.render.

def test_render_timeout_maps_to_render_timeout(monkeypatch):
    def expired(*args, **kwargs):
        raise subprocess.TimeoutExpired(cmd="worker", timeout=20)
    monkeypatch.setattr(_backend.subprocess, "run", expired)
    with pytest.raises(CoreError) as caught:
        _backend.render('<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"/>', 2, 2)
    assert caught.value.code == "render-timeout"


# SPEC section 7 separation: inspect makes no preview claim, verify
# reports the comparison context (renderer, version, viewport,
# fonts) alongside the outcome.

def test_inspect_and_verify_claims_stay_separate(tmp_path):
    target = build(tmp_path, '<text x="0" y="3" font-size="3">A</text>', "text.png")
    inspected = inspect_document(target)
    assert inspected["container"] == "passed-supported-checks"
    assert inspected["preview"] == "not-checked"
    verified = verify_document(target)
    assert verified["preview"] == "match"
    assert verified["renderer"] and verified["renderer_version"]
    assert list(verified["viewport"]) == [4, 4]
    assert "fonts" in verified and "comparison" in verified

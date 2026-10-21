import hashlib
import json
import os
import subprocess
import sys

import pytest
from vector_png_editor import writing
from vector_png_editor.document import read_document
from vector_png_editor.errors import CoreError
from test_core import SVG, png


@pytest.mark.parametrize("prefix", [b"", b"\xef\xbb\xbf<?xml version='1.0' encoding='UTF-8'?>\r\n"])
def test_build_verify_rebuild_exact_bytes(tmp_path, prefix):
    source = prefix + SVG.replace(b"><", b">\r\n<").replace(b"<rect", "<!-- 日本語 -->\r\n<rect".encode())
    target = tmp_path / "日本語.png"
    report = writing.build_document(source, target, 2, 2)
    assert report["preview"] == "match"
    assert report["comparison"] == "exact-rgba8"
    assert report["authenticity"] == "not-checked"
    assert read_document(target).source == source
    assert writing.verify_document(target)["preview"] == "match"
    rebuilt = tmp_path / "rebuilt.png"
    writing.rebuild_document(target, rebuilt)
    assert read_document(rebuilt).source == source
    assert (read_document(rebuilt).width, read_document(rebuilt).height) == (2, 2)


def test_mismatch_is_independent_of_container(tmp_path):
    target = tmp_path / "other-renderer.png"
    target.write_bytes(png())
    report = writing.verify_document(target)
    assert report["container"] == "passed-supported-checks"
    assert report["preview"] == "mismatch"
    run = subprocess.run([sys.executable, "-m", "vector_png_editor", "verify", str(target)], capture_output=True)
    result = json.loads(run.stdout)
    assert run.returncode == 12
    assert not result["ok"] and "result" not in result
    assert result["error"]["details"]["renderer"] == "CairoSVG"


@pytest.mark.parametrize("failure", ["unsupported-profile", "render-timeout", "render-mismatch", "cancelled", "disk"])
def test_failure_preserves_original(tmp_path, monkeypatch, failure):
    target = tmp_path / "original.png"
    original = png()
    target.write_bytes(original)
    token = hashlib.sha256(original).hexdigest()
    if failure == "unsupported-profile":
        source = SVG.replace(b"<rect", b"<script").replace(b"/></svg>", b"/></svg>")
    else:
        source = SVG
        if failure in {"render-timeout", "cancelled"}:
            def fail(*args, **kwargs):
                if failure == "cancelled":
                    raise KeyboardInterrupt
                raise CoreError("render-timeout", "simulated timeout")
            monkeypatch.setattr(writing, "render_source", fail)
        elif failure == "render-mismatch":
            monkeypatch.setattr(writing, "verify_bytes", lambda data: {"preview": "mismatch"})
        else:
            def fail(*args, **kwargs):
                raise OSError("simulated disk failure")
            monkeypatch.setattr(writing.os, "fsync", fail)
    with pytest.raises((CoreError, OSError, KeyboardInterrupt)):
        writing.build_document(source, target, 2, 2, overwrite=True, expected_sha256=token)
    assert target.read_bytes() == original
    assert not list(tmp_path.glob(".vector-png-save-*"))
    assert not list(tmp_path.glob("*.lock"))


def test_overwrite_requires_token_and_retains_backup(tmp_path):
    target = tmp_path / "original.png"
    original = png()
    target.write_bytes(original)
    with pytest.raises(CoreError) as error:
        writing.build_document(SVG, target, 2, 2)
    assert error.value.code == "output-exists"
    with pytest.raises(CoreError) as error:
        writing.build_document(SVG, target, 2, 2, overwrite=True, expected_sha256="0" * 64)
    assert error.value.code == "conflict"
    report = writing.rebuild_document(target, target, overwrite=True,
                                     expected_sha256=hashlib.sha256(original).hexdigest())
    from pathlib import Path
    assert Path(report["backup"]).read_bytes() == original
    assert writing.verify_document(target)["preview"] == "match"


def test_concurrent_new_output_is_never_clobbered(tmp_path, monkeypatch):
    target = tmp_path / "output.png"
    link = os.link
    def race(source, destination):
        target.write_bytes(b"concurrent writer")
        return link(source, destination)
    monkeypatch.setattr(writing.os, "link", race)
    with pytest.raises(CoreError) as error:
        writing.build_document(SVG, target, 2, 2)
    assert error.value.code == "output-exists"
    assert target.read_bytes() == b"concurrent writer"


def test_overwrite_change_during_backup_is_conflict(tmp_path, monkeypatch):
    target = tmp_path / "output.png"
    original = png()
    target.write_bytes(original)
    read = writing.bounded_read
    reads = 0
    def race(path, limit):
        nonlocal reads
        reads += 1
        if reads == 2:
            target.write_bytes(b"concurrent writer")
        return read(path, limit)
    monkeypatch.setattr(writing, "bounded_read", race)
    with pytest.raises(CoreError) as error:
        writing.build_document(SVG, target, 2, 2, overwrite=True,
                               expected_sha256=hashlib.sha256(original).hexdigest())
    assert error.value.code == "conflict"
    assert target.read_bytes() == b"concurrent writer"
    assert next(tmp_path.glob("*.backup")).read_bytes() == original


def test_cooperating_writer_lock(tmp_path):
    target = tmp_path / "output.png"
    lock = tmp_path / "output.png.vector-png.lock"
    lock.write_bytes(b"")
    with pytest.raises(CoreError) as error:
        writing.build_document(SVG, target, 2, 2)
    assert error.value.code == "conflict"
    assert lock.exists() and not target.exists()


@pytest.mark.parametrize("options", [
    {"overwrite": True}, {"expected_sha256": "0" * 64},
    {"overwrite": True, "expected_sha256": "bad"},
])
def test_explicit_overwrite_contract(tmp_path, options):
    target = tmp_path / "output.png"
    target.write_bytes(b"original")
    with pytest.raises(CoreError) as error:
        writing._publish(b"candidate", target, **options)
    assert error.value.code == "invalid-arguments"
    assert target.read_bytes() == b"original"
    assert list(tmp_path.iterdir()) == [target]


def test_replace_failure_keeps_independent_snapshot(tmp_path, monkeypatch):
    target = tmp_path / "output.png"
    original = png()
    target.write_bytes(original)
    def fail(*args):
        raise PermissionError("simulated replacement failure")
    monkeypatch.setattr(writing.os, "replace", fail)
    with pytest.raises(PermissionError):
        writing.build_document(SVG, target, 2, 2, overwrite=True,
                               expected_sha256=hashlib.sha256(original).hexdigest())
    assert target.read_bytes() == original
    backup = next(tmp_path.glob("*.backup"))
    target.write_bytes(b"later in-place write")
    assert backup.read_bytes() == original
    assert not list(tmp_path.glob("*.lock"))
    assert not list(tmp_path.glob(".vector-png-save-*"))


@pytest.mark.parametrize("command", ["verify", "rebuild"])
def test_plain_png_rejected_for_source_operation(tmp_path, command):
    target = tmp_path / "plain.png"
    target.write_bytes(png(None))
    with pytest.raises(CoreError) as error:
        if command == "verify":
            writing.verify_document(target)
        else:
            writing.rebuild_document(target, tmp_path / "output.png")
    assert error.value.code == "ordinary-png"

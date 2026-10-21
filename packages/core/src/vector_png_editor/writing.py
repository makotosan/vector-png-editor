"""Source-preserving generation and exact local-renderer verification."""
import hashlib
import io
import os
from pathlib import Path
import struct
import tempfile
import uuid
import zlib

from PIL import Image
from .document import (KEY, MAX_PNG, SIGNATURE, bounded_read, chunks,
                       raster_stream, read_document_bytes)
from .errors import CoreError
from .rendering import render_source


def _chunk(kind, payload):
    return (struct.pack(">I", len(payload)) + kind + payload
            + struct.pack(">I", zlib.crc32(kind + payload) & 0xffffffff))


def _pixels(data, doc):
    raster = raster_stream(list(chunks(data)), doc.width, doc.height,
                           doc.bit_depth, doc.color_type, doc.interlace)
    with Image.open(io.BytesIO(raster)) as image:
        return image.convert("RGBA").tobytes()


def verify_bytes(data):
    doc = read_document_bytes(data)
    if doc.source is None:
        raise CoreError("ordinary-png", "PNG contains no vector-png.svg source")
    rendered = render_source(doc.source, doc.width, doc.height)
    fresh = read_document_bytes(rendered)
    if (fresh.width, fresh.height) != (doc.width, doc.height):
        raise CoreError("render-failed", "Renderer returned a different viewport")
    # Metadata comes from the same renderer policy without an extra render.
    from importlib.metadata import version
    report = {"container": "passed-supported-checks", "profile": "safe-svg-v1",
              "profile_check": "passed", "renderer": "CairoSVG",
              "renderer_version": version("CairoSVG"), "viewport": [doc.width, doc.height],
              "fonts": "host-selected", "color_alpha": "CairoSVG default; transparent background",
              "text_policy": "grayscale antialias; hint style/metrics disabled",
              "comparison": "exact-rgba8", "authenticity": "not-checked",
              "png_sha256": doc.png_sha256,
              "svg_sha256": hashlib.sha256(doc.source).hexdigest(), "svg_bytes": len(doc.source)}
    report["preview"] = "match" if _pixels(data, doc) == _pixels(rendered, fresh) else "mismatch"
    return report


def verify_document(path):
    return verify_bytes(bounded_read(path, MAX_PNG))


def _candidate(source, width, height):
    rendered = render_source(source, width, height)
    raster = read_document_bytes(rendered)
    if (raster.width, raster.height) != (width, height):
        raise CoreError("render-failed", "Renderer returned a different viewport")
    # Rebuilt files intentionally contain only raster-essential chunks and source.
    output = bytearray(SIGNATURE)
    for kind, payload in chunks(rendered):
        if kind not in {b"IHDR", b"PLTE", b"tRNS", b"IDAT", b"IEND"}:
            continue
        output.extend(_chunk(kind, payload))
        if kind == b"IHDR":
            output.extend(_chunk(b"iTXt", KEY + b"\0\x01\0\0\0" + zlib.compress(source)))
    data = bytes(output)
    report = verify_bytes(data)
    if read_document_bytes(data).source != source or report["preview"] != "match":
        raise CoreError("render-mismatch", "Generated PNG failed source/preview verification")
    return data, report


def _publish(data, output, overwrite=False, expected_sha256=None):
    target = Path(output)
    if overwrite != (expected_sha256 is not None):
        raise CoreError("invalid-arguments", "Overwrite requires an expected PNG SHA-256 token")
    if expected_sha256 is not None and (len(expected_sha256) != 64
            or any(c not in "0123456789abcdef" for c in expected_sha256)):
        raise CoreError("invalid-arguments", "Expected SHA-256 must be 64 lowercase hexadecimal characters")
    lock = target.with_name(target.name + ".vector-png.lock")
    try:
        lock_fd = os.open(lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    except FileExistsError as exc:
        raise CoreError("conflict", "Another save owns the output lock") from exc
    temp = None
    backup = None
    try:
        os.close(lock_fd)
        if target.is_symlink():
            raise CoreError("conflict", "Saving through a symlink is forbidden")
        if overwrite:
            original = bounded_read(target, MAX_PNG)
            if hashlib.sha256(original).hexdigest() != expected_sha256:
                raise CoreError("conflict", "Output changed since the supplied revision")
        elif target.exists():
            raise CoreError("output-exists", "Output already exists")
        fd, temp = tempfile.mkstemp(prefix=".vector-png-save-", dir=target.parent)
        with os.fdopen(fd, "wb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        if overwrite:
            backup = target.with_name(target.name + "." + uuid.uuid4().hex + ".backup")
            # A separate snapshot also survives in-place writes through other handles.
            with open(backup, "xb") as stream:
                stream.write(original)
                stream.flush()
                os.fsync(stream.fileno())
            if target.is_symlink() or bounded_read(target, MAX_PNG) != original:
                raise CoreError("conflict", "Output changed during save; backup retained")
            os.replace(temp, target)
        else:
            try:
                os.link(temp, target)
            except FileExistsError as exc:
                raise CoreError("output-exists", "Output appeared during save") from exc
    finally:
        if temp is not None and os.path.exists(temp):
            os.unlink(temp)
        os.unlink(lock)
    return {"backup": str(backup) if backup is not None else None}


def build_document(source, output, width=1024, height=1024, *, overwrite=False, expected_sha256=None):
    data, report = _candidate(source, width, height)
    report.update(_publish(data, output, overwrite, expected_sha256))
    return report


def rebuild_document(path, output, *, overwrite=False, expected_sha256=None):
    data = bounded_read(path, MAX_PNG)
    doc = read_document_bytes(data)
    if doc.source is None:
        raise CoreError("ordinary-png", "PNG contains no vector-png.svg source")
    return build_document(doc.source, output, doc.width, doc.height,
                          overwrite=overwrite, expected_sha256=expected_sha256)

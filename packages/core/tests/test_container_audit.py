"""Requirement-level container audit probes for Issue #1 (P0-01).

Each test names the pinned SPEC section it evidences. Behavior that is
a known leniency is pinned as current behavior and recorded as an
explicit open audit item in docs/PHASE0.md; it is not silently
treated as conformance. Finite probes never prove full conformance.
"""
import io
import struct
import zlib

from PIL import Image
import pytest

from vector_png_editor import build_document, inspect_document, rebuild_document
from vector_png_editor.document import SIGNATURE, chunks, read_document_bytes
from vector_png_editor.errors import CoreError

SVG = b'<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"><rect width="2" height="2" fill="#336699"/></svg>'
KEY = b"vector-png.svg"


def chunk(kind, payload):
    return struct.pack(">I", len(payload)) + kind + payload + struct.pack(">I", zlib.crc32(kind + payload) & 0xFFFFFFFF)


def itxt(source=SVG, language=b"", translated=b"", compressed=None):
    body = KEY + b"\0\x01\x00" + language + b"\0" + translated + b"\0"
    return body + (zlib.compress(source) if compressed is None else compressed)


def base_parts():
    buffer = io.BytesIO()
    Image.new("RGBA", (2, 2), (51, 102, 153, 255)).save(buffer, format="PNG")
    return list(chunks(buffer.getvalue()))


def assemble(parts):
    return SIGNATURE + b"".join(chunk(kind, payload) for kind, payload in parts)


def with_source(source_chunk=None, raster=None):
    parts = list(raster if raster is not None else base_parts())
    parts.insert(1, (b"iTXt", source_chunk if source_chunk is not None else itxt()))
    return assemble(parts)


def error_code(data):
    with pytest.raises(CoreError) as caught:
        read_document_bytes(data)
    return caught.value.code


# SPEC section 2: datastream structure.

def test_trailing_bytes_after_iend_rejected():
    assert error_code(with_source() + b"\x00") == "invalid-container"


def test_missing_iend_rejected():
    parts = base_parts()
    assert error_code(assemble(parts[:-1])) == "invalid-container"


def test_duplicate_ihdr_rejected():
    parts = base_parts()
    parts.insert(1, parts[0])
    assert error_code(assemble(parts)) == "invalid-container"


def test_chunk_size_beyond_file_rejected():
    data = bytearray(with_source())
    data[8:12] = struct.pack(">I", 0x00FFFFFF)
    assert error_code(bytes(data)) == "invalid-container"


@pytest.mark.parametrize("kind", [b"acTL", b"fcTL", b"fdAT"])
def test_apng_markers_rejected_beyond_the_fixture(kind):
    parts = base_parts()
    parts.insert(2, (kind, b"\0" * 8))
    parts.insert(1, (b"iTXt", itxt()))
    assert error_code(assemble(parts)) == "invalid-container"


def test_unknown_critical_chunk_rejected():
    parts = base_parts()
    parts.insert(1, (b"ABCD", b"opaque"))
    parts.insert(2, (b"iTXt", itxt()))
    assert error_code(assemble(parts)) == "invalid-container"


def test_unknown_ancillary_chunk_accepted_and_ignored():
    parts = base_parts()
    parts.insert(1, (b"abCD", b"opaque"))
    parts.insert(2, (b"iTXt", itxt()))
    doc = read_document_bytes(assemble(parts))
    assert doc.source == SVG


def test_crc_corruption_in_any_chunk_rejected():
    data = bytearray(with_source())
    data[-5] ^= 0xFF  # last byte of the final chunk CRC region
    assert error_code(bytes(data)) == "invalid-container"


# SPEC section 2/3: the source chunk and its keyword.

def test_duplicate_source_itxt_rejected():
    parts = base_parts()
    parts.insert(1, (b"iTXt", itxt()))
    parts.insert(2, (b"iTXt", itxt()))
    assert error_code(assemble(parts)) == "invalid-container"


@pytest.mark.parametrize("kind", [b"tEXt", b"zTXt"])
def test_keyword_in_text_or_ztxt_rejected(kind):
    payload = KEY + b"\0" + (zlib.compress(SVG) if kind == b"zTXt" else SVG)
    parts = base_parts()
    parts.insert(1, (kind, payload))
    assert error_code(assemble(parts)) == "invalid-container"


def test_keyword_in_itxt_and_text_rejected_not_first_or_last():
    parts = base_parts()
    parts.insert(1, (b"iTXt", itxt()))
    parts.insert(2, (b"tEXt", KEY + b"\0" + SVG))
    assert error_code(assemble(parts)) == "invalid-container"


def test_keyword_is_case_sensitive():
    parts = base_parts()
    body = b"Vector-png.svg\0\x01\x00\0\0" + zlib.compress(SVG)
    parts.insert(1, (b"iTXt", body))
    assert read_document_bytes(assemble(parts)).source is None


def test_source_itxt_after_idat_accepted():
    parts = base_parts()
    parts.append((b"iTXt", itxt()))
    iend = parts.pop(-2)
    parts.append(iend)
    doc = read_document_bytes(assemble(parts))
    assert doc.source == SVG


# SPEC section 3: iTXt payload fields and the single zlib stream.

@pytest.mark.parametrize("language", [b"en", b"ja", b"en-US", b"zh-Hant-TW", b"x-custom"])
def test_png_valid_language_tags_accepted(language):
    doc = read_document_bytes(with_source(itxt(language=language)))
    assert doc.source == SVG


@pytest.mark.parametrize("language", [b"en_US", b"en--US", b"-en", b"en-", b"abcdefghi"])
def test_registry_invalid_language_tags_currently_accepted_open_audit(language):
    # SPEC section 3 requires accepting PNG-valid tags; it does not
    # require rejecting registry-invalid ones explicitly, but PNG
    # validity incorporates the tag grammar. The reader checks only
    # ASCII today (see document.source_payload); BCP 47 registry
    # validation is an explicit open audit item in docs/PHASE0.md.
    doc = read_document_bytes(with_source(itxt(language=language)))
    assert doc.source == SVG


def test_non_ascii_language_tag_rejected():
    assert error_code(with_source(itxt(language=b"e\x80"))) == "invalid-container"


def test_translated_keyword_utf8_accepted_and_invalid_rejected():
    doc = read_document_bytes(with_source(itxt(translated="ベクター".encode("utf-8"))))
    assert doc.source == SVG
    assert error_code(with_source(itxt(translated=b"\xff\xfe"))) == "invalid-container"


def test_concatenated_zlib_streams_rejected():
    doubled = zlib.compress(SVG) + zlib.compress(b"extra")
    assert error_code(with_source(itxt(compressed=doubled))) == "invalid-container"


def test_trailing_bytes_after_zlib_stream_rejected():
    trailed = zlib.compress(SVG) + b"garbage"
    assert error_code(with_source(itxt(compressed=trailed))) == "invalid-container"


def test_truncated_zlib_stream_rejected():
    cut = zlib.compress(SVG)[:5]
    assert error_code(with_source(itxt(compressed=cut))) == "invalid-container"


def test_uncompressed_itxt_rejected():
    body = KEY + b"\0\x00\x00\0\0" + SVG
    assert error_code(with_source(body)) == "invalid-container"


# SPEC section 4: limits are reported as resource-limit, not malformed.

def test_oversize_side_is_resource_limit_not_invalid_container():
    ihdr = struct.pack(">IIBBBBB", 4097, 1, 8, 6, 0, 0, 0)
    parts = [(b"IHDR", ihdr), (b"IDAT", zlib.compress(b"\x00" * 8)), (b"IEND", b"")]
    assert error_code(assemble(parts)) == "resource-limit"


def test_oversize_decompressed_svg_is_resource_limit():
    big = b"<svg xmlns='http://www.w3.org/2000/svg'>" + b" " * 1_000_001 + b"</svg>"
    assert error_code(with_source(itxt(source=big))) == "resource-limit"


# SPEC sections 2/6: raster subset breadth and metadata retention.

def _raster_with_itxt(image, **save_kwargs):
    buffer = io.BytesIO()
    image.save(buffer, format="PNG", **save_kwargs)
    parts = list(chunks(buffer.getvalue()))
    parts.insert(1, (b"iTXt", itxt()))
    return assemble(parts)


def adam7_rgba(width=8, height=8, pixel=(9, 9, 9, 255)):
    # Pillow 13 does not write Adam7 files, so encode the seven
    # passes directly: filter byte 0 and solid rows per pass.
    raw = bytearray()
    for x0, y0, dx, dy in [(0, 0, 8, 8), (4, 0, 8, 8), (0, 4, 4, 8), (2, 0, 4, 4),
                           (0, 2, 2, 4), (1, 0, 2, 2), (0, 1, 1, 2)]:
        w = max(0, (width - x0 + dx - 1) // dx)
        h = max(0, (height - y0 + dy - 1) // dy)
        row = b"\x00" + bytes(pixel) * w
        raw.extend(row * h)
    ihdr = struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 1)
    parts = [(b"IHDR", ihdr), (b"iTXt", itxt()), (b"IDAT", zlib.compress(bytes(raw))), (b"IEND", b"")]
    return assemble(parts)


def test_interlaced_raster_container_accepted():
    doc = read_document_bytes(adam7_rgba())
    assert doc.interlace == 1 and doc.source == SVG


def test_palette_and_grayscale_rasters_container_accepted():
    palette = _raster_with_itxt(Image.new("P", (2, 2)))
    gray = _raster_with_itxt(Image.new("L", (2, 2)))
    assert read_document_bytes(palette).color_type == 3
    assert read_document_bytes(gray).color_type == 0


def test_interlaced_copy_of_render_verifies(tmp_path):
    # The same 2x2 solid render encoded as Adam7 must still verify:
    # verification decodes pixels, it does not compare PNG bytes.
    wide = b'<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="#090909"/></svg>'
    target = tmp_path / "interlaced-vector.png"
    target.write_bytes(adam7_rgba())
    parts = list(chunks(target.read_bytes()))
    parts[1] = (b"iTXt", itxt(source=wide))
    target.write_bytes(assemble(parts))
    from vector_png_editor import verify_document
    assert verify_document(target)["preview"] == "match"


def test_rebuild_does_not_retain_unknown_ancillary_chunks(tmp_path):
    # SPEC section 6: other metadata MAY be retained; retention is
    # not required. The writer emits a fresh raster+source file, so
    # unrelated chunks are not carried over (documented behavior).
    built = tmp_path / "built.png"
    build_document(SVG, built, 2, 2)
    parts = list(chunks(built.read_bytes()))
    parts.insert(2, (b"prVt", b"private"))
    decorated = tmp_path / "decorated.png"
    decorated.write_bytes(assemble(parts))
    assert inspect_document(decorated)["kind"] == "vector-png"
    out = tmp_path / "rebuilt.png"
    rebuild_document(decorated, out)
    kinds = [kind for kind, _ in chunks(out.read_bytes())]
    assert b"prVt" not in kinds

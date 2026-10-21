"""Passive PNG discovery and exact source extraction, without SVG rendering."""
from dataclasses import dataclass
import hashlib
import io
import os
from pathlib import Path
import re
import struct
import tempfile
import zlib

from PIL import Image
from .errors import CoreError
from .svg import MAX_SVG, parse_source

SIGNATURE = b"\x89PNG\r\n\x1a\n"
KEY = b"vector-png.svg"
MAX_PNG = 32_000_000
MAX_SIDE = 4096
MAX_PIXELS = 4_000_000
MAX_CHUNKS = 10_000
PRE_PALETTE = {b"cHRM", b"cICP", b"gAMA", b"iCCP", b"mDCV", b"cLLI", b"sBIT", b"sRGB"}
PRE_IDAT = PRE_PALETTE | {b"bKGD", b"hIST", b"tRNS", b"pHYs", b"sPLT", b"eXIf"}
SINGLETON = PRE_IDAT - {b"sPLT"} | {b"IHDR", b"PLTE", b"IEND", b"tIME", b"eXIf"}


def bounded_read(path, limit):
    with open(path, "rb") as stream:
        data = stream.read(limit + 1)
    if len(data) > limit:
        raise CoreError("resource-limit", f"Input exceeds {limit} bytes")
    return data


def chunks(data):
    if not data.startswith(SIGNATURE):
        raise CoreError("invalid-container", "Not a PNG")
    pos = 8
    count = 0
    while pos + 12 <= len(data):
        count += 1
        if count > MAX_CHUNKS:
            raise CoreError("resource-limit", "PNG exceeds 10,000 chunks")
        size = struct.unpack_from(">I", data, pos)[0]
        kind = data[pos + 4:pos + 8]
        end = pos + 8 + size
        if size > 0x7fffffff or end + 4 > len(data):
            raise CoreError("invalid-container", "Truncated or oversized PNG chunk")
        if not re.fullmatch(b"[A-Za-z]{4}", kind) or kind[2] & 32:
            raise CoreError("invalid-container", "Invalid PNG chunk type")
        payload = data[pos + 8:end]
        crc = struct.unpack_from(">I", data, end)[0]
        if zlib.crc32(kind + payload) & 0xffffffff != crc:
            raise CoreError("invalid-container", "Invalid PNG CRC")
        yield kind, payload
        pos = end + 4
        if kind == b"IEND":
            if size or pos != len(data):
                raise CoreError("invalid-container", "Invalid PNG ending")
            return
    raise CoreError("invalid-container", "Missing PNG IEND")


def source_payload(payload):
    try:
        rest = payload[len(KEY) + 1:]
        if rest[:2] != b"\x01\x00":
            raise ValueError("SVG requires compressed iTXt with method 0")
        language, translated, compressed = rest[2:].split(b"\0", 2)
        # Registry-level BCP47 validation remains an explicit audit item.
        language.decode("ascii", errors="strict")
        translated.decode("utf-8", errors="strict")
        dec = zlib.decompressobj()
        raw = dec.decompress(compressed, MAX_SVG + 1)
        if len(raw) > MAX_SVG or dec.unconsumed_tail:
            raise CoreError("resource-limit", "SVG exceeds decompression limit")
        if not dec.eof or dec.unused_data:
            raise ValueError("SVG must contain exactly one complete zlib stream")
    except (ValueError, zlib.error, UnicodeError) as exc:
        if isinstance(exc, CoreError):
            raise
        raise CoreError("invalid-container", f"Invalid SVG iTXt: {exc}") from exc
    parse_source(raw)
    return raw


def raster_stream(stream, width, height, depth, color, interlace):
    channels = {0: 1, 2: 3, 3: 1, 4: 2, 6: 4}[color]
    passes = [(0, 0, 1, 1)] if interlace == 0 else [
        (0, 0, 8, 8), (4, 0, 8, 8), (0, 4, 4, 8), (2, 0, 4, 4),
        (0, 2, 2, 4), (1, 0, 2, 2), (0, 1, 1, 2)]
    rows = []
    for x, y, dx, dy in passes:
        w = max(0, (width - x + dx - 1) // dx)
        h = max(0, (height - y + dy - 1) // dy)
        if w and h:
            rows.extend([1 + (w * channels * depth + 7) // 8] * h)
    expected = sum(rows)
    compressed = b"".join(payload for kind, payload in stream if kind == b"IDAT")
    try:
        decoder = zlib.decompressobj()
        raw = decoder.decompress(compressed, expected + 1)
        if len(raw) != expected or not decoder.eof or decoder.unused_data or decoder.unconsumed_tail:
            raise ValueError("Invalid PNG image zlib stream or scanline size")
        pos = 0
        for size in rows:
            if raw[pos] > 4:
                raise ValueError("Invalid PNG filter type")
            pos += size
    except (ValueError, zlib.error) as exc:
        raise CoreError("invalid-container", str(exc)) from exc
    # Decode only raster chunks. Text/ICC metadata must not inflate during passive discovery.
    data = bytearray(SIGNATURE)
    for kind, payload in stream:
        if kind in {b"IHDR", b"PLTE", b"tRNS", b"IDAT", b"IEND"}:
            data.extend(struct.pack(">I", len(payload)) + kind + payload
                        + struct.pack(">I", zlib.crc32(kind + payload) & 0xffffffff))
    return bytes(data)


@dataclass(frozen=True)
class Document:
    source: bytes | None
    width: int
    height: int
    png_sha256: str
    color_type: int
    bit_depth: int
    interlace: int


def read_document(path):
    return read_document_bytes(bounded_read(path, MAX_PNG))


def read_document_bytes(data):
    if len(data) > MAX_PNG:
        raise CoreError("resource-limit", "PNG exceeds byte limit")
    stream = list(chunks(data))
    if not stream or stream[0][0] != b"IHDR" or len(stream[0][1]) != 13:
        raise CoreError("invalid-container", "Missing PNG IHDR")
    width, height, depth, color, compression, filtering, interlace = struct.unpack(">IIBBBBB", stream[0][1])
    if width == 0 or height == 0:
        raise CoreError("invalid-container", "Zero PNG dimension")
    if max(width, height) > MAX_SIDE or width * height > MAX_PIXELS:
        raise CoreError("resource-limit", "PNG exceeds side/pixel limits")
    depths = {0: {1, 2, 4, 8, 16}, 2: {8, 16}, 3: {1, 2, 4, 8}, 4: {8, 16}, 6: {8, 16}}
    if depth not in depths.get(color, set()) or compression or filtering or interlace not in {0, 1}:
        raise CoreError("invalid-container", "Invalid PNG IHDR fields")
    seen = set()
    idat_started = False
    idat_ended = False
    palette_entries = None
    source = None
    source_count = 0
    for kind, payload in stream:
        if kind in {b"acTL", b"fcTL", b"fdAT"}:
            raise CoreError("invalid-container", "APNG markers are forbidden")
        if not kind[0] & 32 and kind not in {b"IHDR", b"PLTE", b"IDAT", b"IEND"}:
            raise CoreError("invalid-container", "Unknown critical PNG chunk")
        if kind in SINGLETON and kind in seen:
            raise CoreError("invalid-container", "Duplicate PNG singleton chunk")
        if (kind in PRE_PALETTE and b"PLTE" in seen) or (kind in PRE_IDAT and idat_started):
            raise CoreError("invalid-container", "Invalid ancillary PNG chunk ordering")
        if kind == b"PLTE":
            if idat_started or color in {0, 4} or not payload or len(payload) % 3 or len(payload) > 768:
                raise CoreError("invalid-container", "Invalid PLTE")
            palette_entries = len(payload) // 3
            if color == 3 and palette_entries > 2 ** depth:
                raise CoreError("invalid-container", "Palette exceeds bit depth")
            if b"bKGD" in seen or b"tRNS" in seen:
                raise CoreError("invalid-container", "PLTE must precede bKGD/tRNS")
        if kind == b"hIST" and (palette_entries is None or len(payload) != 2 * palette_entries):
            raise CoreError("invalid-container", "Invalid hIST")
        if kind == b"tRNS":
            if (color in {4, 6} or color == 0 and len(payload) != 2
                    or color == 2 and len(payload) != 6
                    or color == 3 and (palette_entries is None or not 1 <= len(payload) <= palette_entries)):
                raise CoreError("invalid-container", "Invalid tRNS")
        if kind == b"IDAT":
            if idat_ended or color == 3 and palette_entries is None:
                raise CoreError("invalid-container", "Nonconsecutive IDAT or missing PLTE")
            idat_started = True
        elif idat_started:
            idat_ended = True
        if kind in {b"iTXt", b"tEXt", b"zTXt"} and payload.split(b"\0", 1)[0] == KEY:
            source_count += 1
            if kind != b"iTXt" or source_count > 1:
                raise CoreError("invalid-container", "SVG must use exactly one iTXt source chunk")
            source = source_payload(payload)
        seen.add(kind)
    if not idat_started:
        raise CoreError("invalid-container", "Missing PNG IDAT")
    raster = raster_stream(stream, width, height, depth, color, interlace)
    try:
        with Image.open(io.BytesIO(raster)) as image:
            image.verify()
        with Image.open(io.BytesIO(raster)) as image:
            if image.format != "PNG" or getattr(image, "n_frames", 1) != 1:
                raise ValueError("Not a static PNG")
            image.load()
    except Exception as exc:
        raise CoreError("invalid-container", "Invalid or unsupported PNG raster/metadata") from exc
    return Document(source, width, height, hashlib.sha256(data).hexdigest(), color, depth, interlace)


def inspect_document(path):
    doc = read_document(path)
    return {"kind": "vector-png" if doc.source is not None else "png", "wire": "v1" if doc.source is not None else None,
            "container": "passed-supported-checks", "profile": "not-checked", "preview": "not-checked",
            "width": doc.width, "height": doc.height, "color_type": doc.color_type, "bit_depth": doc.bit_depth,
            "interlace": doc.interlace, "png_sha256": doc.png_sha256,
            "svg_bytes": len(doc.source) if doc.source is not None else 0,
            "svg_sha256": hashlib.sha256(doc.source).hexdigest() if doc.source is not None else None}


def extract_source(path, output):
    doc = read_document(path)
    if doc.source is None:
        raise CoreError("ordinary-png", "PNG contains no vector-png.svg source")
    target = Path(output)
    if target.exists() or target.is_symlink():
        raise CoreError("output-exists", "Extraction never overwrites existing output")
    fd, temp = tempfile.mkstemp(prefix=".vector-png-extract-", dir=target.parent)
    try:
        with os.fdopen(fd, "wb") as file:
            file.write(doc.source)
            file.flush()
            os.fsync(file.fileno())
        try:
            os.link(temp, target)
        except FileExistsError as exc:
            raise CoreError("output-exists", "Output appeared during extraction") from exc
    finally:
        os.unlink(temp)
    return {"svg_bytes": len(doc.source), "svg_sha256": hashlib.sha256(doc.source).hexdigest(),
            "profile": "not-checked", "preview": "not-checked"}

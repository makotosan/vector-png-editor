"""Bounded UTF-8 XML parsing independent of rendering/profile acceptance."""
from xml.parsers import expat
from defusedxml import ElementTree

from .errors import CoreError

MAX_SVG = 1_000_000
SVG_NS = "http://www.w3.org/2000/svg"


def parse_source(source: bytes):
    if len(source) > MAX_SVG:
        raise CoreError("resource-limit", "SVG exceeds 1,000,000 bytes")
    try:
        text = source.decode("utf-8", errors="strict")
    except UnicodeError as exc:
        raise CoreError("invalid-svg", "SVG is not UTF-8") from exc
    if "\x00" in text:
        raise CoreError("invalid-svg", "NUL is forbidden in SVG")
    parser = expat.ParserCreate()
    count = 0
    depth = -1

    def prohibited(*args):
        raise CoreError("invalid-svg", "DTD, entities and processing instructions are forbidden")

    def declaration(version, encoding, standalone):
        if encoding is not None and encoding.lower() != "utf-8":
            raise CoreError("invalid-svg", "XML declaration must use UTF-8")

    def start(name, attrs):
        nonlocal count, depth
        count += 1
        depth += 1
        if count > 5000 or depth > 32:
            raise CoreError("resource-limit", "XML exceeds 5000 elements or depth 32")
        if any(len(value) > 100_000 for value in attrs.values()):
            raise CoreError("resource-limit", "XML attribute exceeds 100,000 code points")

    def end(name):
        nonlocal depth
        depth -= 1

    parser.XmlDeclHandler = declaration
    parser.ProcessingInstructionHandler = prohibited
    parser.StartDoctypeDeclHandler = prohibited
    parser.EntityDeclHandler = prohibited
    parser.ExternalEntityRefHandler = prohibited
    parser.StartElementHandler = start
    parser.EndElementHandler = end
    try:
        parser.Parse(source, True)
        root = ElementTree.fromstring(source, forbid_dtd=True, forbid_entities=True, forbid_external=True)
    except CoreError:
        raise
    except Exception as exc:
        raise CoreError("invalid-svg", "Malformed XML") from exc
    if root.tag != f"{{{SVG_NS}}}svg":
        raise CoreError("invalid-svg", "Root must be SVG in the SVG namespace")
    return text, root


def validate_source(source: bytes):
    """Check XML and safe-svg-v1 allowlist; no rendering or numeric validation."""
    text, _ = parse_source(source)
    from . import _backend
    try:
        _backend.validate_svg(text)
    except _backend.VectorPNGError as exc:
        raise CoreError("unsupported-profile", str(exc)) from exc
    return {"xml": "valid", "profile": "safe-svg-v1", "profile_check": "passed",
            "render": "not-checked", "svg_bytes": len(source)}

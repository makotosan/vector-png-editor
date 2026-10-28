"""svg-normalization-v1 normalizer (Issue #48).

Implements the experimental input-processing profile
``profiles/svg-normalization-v1.md`` (makotosan/vector-png-spec, pinned
revision in spec-reference.json): an explicit import operation that
transforms a restricted CSS-styled SVG into a safe-svg-v1-conforming
SVG. The output profile is never relaxed; the input file is never
modified; publication is staged and no-clobber (profile sections 1, 6).

Structure mirrors the profile: input validation (section 2), a real
CSS tokenizer/parser for the closed subset (section 3), restricted
arrow-marker expansion (section 3.1), cascade/inheritance resolution
materializing winning declarations as presentation attributes
(section 4), accessibility migration (section 5), a before/after
rendering gate with exact decoded RGBA equality in the existing
bounded CairoSVG renderer (section 6), and the section 7 JSON
conversion report with its failure codes.

Transformation semantics (cascade ranks, value canonicalization,
change counting, accessibility record ordering) follow the spec
repository's executable fixture tool (tools/normalization_fixture.py,
MIT, same author) wherever the profile text leaves a choice; the CSS
tokenizer here is an independent implementation because tinycss2 is
not a Core dependency. Two deliberate deviations from the fixture
tool: ``url(...)`` paint values must use the exact lowercase ``url(``
form the profile's grammar states, and failure reports are written
(no-clobber) so callers can inspect section 7 failure codes.
"""
from __future__ import annotations

import copy
import hashlib
import io
import json
import math
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
from xml.parsers import expat

from defusedxml import ElementTree as DET
from defusedxml.common import DefusedXmlException
import xml.etree.ElementTree as ET

from . import _backend
from .errors import CoreError
from .rendering import render_source
from .svg import SVG_NS, validate_source

ET.register_namespace("", SVG_NS)

PROFILE = "svg-normalization-v1"
MAX_BYTES = 1_000_000
MAX_ELEMENTS = 5000
MAX_DEPTH = 32
MAX_ATTR = 100_000
MAX_CSS_BYTES = 100_000
MAX_SELECTORS = 1000
MAX_DECLARATIONS = 10_000
MAX_SIDE = 4096
MAX_PIXELS = 4_000_000

TAGS = _backend.TAGS
ATTRS = _backend.ATTRS
ENUMS = {
    "fill-rule": "nonzero evenodd",
    "stroke-linecap": "butt round square",
    "stroke-linejoin": "miter round bevel",
    "font-weight": "normal bold 100 200 300 400 500 600 700 800 900",
    "font-style": "normal italic oblique",
    "text-anchor": "start middle end",
    "dominant-baseline": "auto alphabetic middle central hanging text-before-edge text-after-edge",
}
PROPS = set(ENUMS) | set(
    "fill stroke stop-color opacity fill-opacity stroke-opacity stop-opacity "
    "stroke-width font-size stroke-miterlimit stroke-dashoffset stroke-dasharray "
    "font-family clip-path rx ry marker-end letter-spacing".split()
)
INHERITED = PROPS - {"opacity", "clip-path", "stop-color", "stop-opacity", "rx", "ry"}
NUMBER = r"[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)"
IDENT = r"[A-Za-z_][A-Za-z0-9_-]*"
SVG_ID = r"[A-Za-z_][A-Za-z0-9_.-]*"
COLORS = set("black silver gray white maroon red purple fuchsia green lime olive yellow navy blue teal aqua".split())
FRAGMENT = re.compile(r"url\(#[A-Za-z_][A-Za-z0-9_.-]*\)")


class NormalizeFailure(Exception):
    """A profile failure: section 7 code, pipeline stage, explanation."""

    def __init__(self, code, stage, message):
        self.code, self.stage = code, stage
        super().__init__(message)


def _fail(code, stage, message):
    raise NormalizeFailure(code, stage, message)


# ---------------------------------------------------------------- input (section 2)

def _preflight(source: bytes) -> None:
    """Strict XML pre-pass: encodings, hazards and baseline size limits."""
    if len(source) > MAX_BYTES:
        _fail("resource-limit", "input", "Input exceeds 1,000,000 bytes")
    try:
        source.decode("utf-8", errors="strict")
    except UnicodeError:
        _fail("invalid-xml", "input", "Input is not strict UTF-8")
    if b"\x00" in source:
        _fail("invalid-xml", "input", "NUL is forbidden")
    parser = expat.ParserCreate()
    count = 0
    depth = -1

    def hazard(*args):
        _fail("unsafe-input", "input", "DTD, entity declarations and processing instructions are forbidden")

    def declaration(version, encoding, standalone):
        if encoding is not None and encoding.lower() != "utf-8":
            _fail("invalid-xml", "input", "XML declaration must use UTF-8")

    def start(name, attrs):
        nonlocal count, depth
        count += 1
        depth += 1
        if count > MAX_ELEMENTS or depth > MAX_DEPTH:
            _fail("resource-limit", "input", "Input exceeds 5000 elements or depth 32")
        if any(len(value) > MAX_ATTR for value in attrs.values()):
            _fail("resource-limit", "input", "Attribute exceeds 100,000 code points")

    def end(name):
        nonlocal depth
        depth -= 1

    parser.XmlDeclHandler = declaration
    parser.ProcessingInstructionHandler = hazard
    parser.StartDoctypeDeclHandler = hazard
    parser.EntityDeclHandler = hazard
    parser.ExternalEntityRefHandler = hazard
    parser.StartElementHandler = start
    parser.EndElementHandler = end
    try:
        parser.Parse(source, True)
    except NormalizeFailure:
        raise
    except Exception as exc:
        _fail("invalid-xml", "input", f"Malformed XML: {exc}")


def _parse_tree(source: bytes):
    try:
        root = DET.fromstring(source, forbid_dtd=True, forbid_entities=True, forbid_external=True)
    except DefusedXmlException:
        _fail("unsafe-input", "input", "DTD and entity declarations are forbidden")
    except ET.ParseError as exc:
        _fail("invalid-xml", "input", f"Malformed XML: {exc}")
    if root.tag != f"{{{SVG_NS}}}svg":
        _fail("unsafe-input", "input", "Root must be SVG in the SVG namespace")
    return root


def _local(node) -> str:
    return node.tag.removeprefix("{" + SVG_NS + "}")


# ---------------------------------------------------------------- CSS values (section 3)

def _scalar(value, minimum=None, maximum=None, px=False):
    pattern = NUMBER + ("(?:px)?" if px else "")
    if not re.fullmatch(pattern, value) or len(value) > 128:
        _fail("unsupported-css", "css", f"Unsupported numeric syntax: {value!r}")
    number = float(value.removesuffix("px"))
    if not math.isfinite(number) or (minimum is not None and number < minimum) or (maximum is not None and number > maximum):
        _fail("unsupported-css", "css", f"Numeric value out of range: {value!r}")
    return number


def _css_value(prop, raw):
    """Validate one declaration/presentation value; return its canonical form."""
    val = raw.strip()
    low = val.lower()
    if prop not in PROPS or any(c in val for c in "\\@{};<>\x00"):
        _fail("unsupported-css", "css", f"Unsupported property or value: {prop}")
    if prop in {"fill", "stroke", "stop-color"}:
        if low in COLORS or re.fullmatch(r"#[0-9a-fA-F]{3}(?:[0-9a-fA-F]{3})?", val):
            return low
        if prop != "stop-color" and (low == "none" or FRAGMENT.fullmatch(val)):
            return val if val.startswith("url(") else low
        _fail("unsupported-css", "css", f"Unsupported paint value for {prop}: {val!r}")
    elif prop in {"clip-path", "marker-end"}:
        if low == "none" or FRAGMENT.fullmatch(val):
            return val if val.startswith("url(") else low
        _fail("unsupported-css", "css", f"Only none or a local url(#id) is supported for {prop}")
    elif prop in ENUMS:
        if low not in ENUMS[prop].split():
            _fail("unsupported-css", "css", f"Unsupported {prop} value: {val!r}")
        return low
    elif prop.endswith("opacity"):
        _scalar(low, 0, 1)
    elif prop in {"stroke-width", "font-size", "rx", "ry"}:
        _scalar(low, 0, px=True)
    elif prop == "letter-spacing":
        # Amendment G1 (makotosan/vector-png-spec#3): a signed decimal,
        # optionally px. The keyword `normal` is not accepted, matching
        # the amended section 3 table; materialization targets the new
        # safe-svg-v1 presentation attribute of the same name.
        _scalar(low, px=True)
    elif prop == "stroke-miterlimit":
        _scalar(low, 1)
    elif prop == "stroke-dashoffset":
        _scalar(low, px=True)
    elif prop == "stroke-dasharray":
        if low != "none":
            num = NUMBER + "(?:px)?"
            if not re.fullmatch(num + r"(?:(?:\s*,\s*|\s+)" + num + ")*", low):
                _fail("unsupported-css", "css", f"Unsupported stroke-dasharray value: {val!r}")
            if not any(_scalar(t, 0, px=True) for t in re.split(r"[\s,]+", low)):
                _fail("unsupported-css", "css", "stroke-dasharray must not be all zero")
    elif prop == "font-family":
        # The profile text accepts "unquoted words" and "quoted names"
        # without the fixture tool's narrower first-character limits:
        # real corpus files use the unquoted leading-hyphen name
        # -apple-system (a valid CSS identifier). Quoted content is
        # printable ASCII without the delimiting quote or a backslash
        # (escapes are rejected).
        name = (r"(?:-?[A-Za-z_][A-Za-z0-9_-]*(?: +-?[A-Za-z_][A-Za-z0-9_-]*)*"
                r"|\"[\x20-\x21\x23-\x5b\x5d-\x7e]+\""
                r"|'[\x20-\x26\x28-\x5b\x5d-\x7e]+')")
        if not re.fullmatch(name + r"(?:\s*,\s*" + name + ")*", val):
            _fail("unsupported-css", "css", f"Unsupported font-family value: {val!r}")
        return val
    return low


# ---------------------------------------------------------------- CSS tokenizer/parser (section 3)

_WORD = {"ident", "number", "hash", "string", "url"}


class _Tok:
    __slots__ = ("type", "value")

    def __init__(self, type, value):
        self.type, self.value = type, value

    def __repr__(self):  # pragma: no cover - debugging aid
        return f"<{self.type} {self.value!r}>"


def _checked_css(text: str) -> str:
    """Reject escapes, unclosed blocks/strings/comments before tokenizing."""
    stack, quote, index = [], None, 0
    while index < len(text):
        char = text[index]
        if char == "\\":
            _fail("unsupported-css", "css", "CSS escapes are not supported")
        if quote:
            if char == quote:
                quote = None
        elif text[index:index + 2] == "/*":
            end = text.find("*/", index + 2)
            if end < 0:
                _fail("unsupported-css", "css", "Unclosed CSS comment")
            index = end + 1
        elif char in "'\"":
            quote = char
        elif char in "{([":
            stack.append(char)
        elif char in "})]":
            if not stack or stack.pop() != {"}": "{", ")": "(", "]": "["}[char]:
                _fail("unsupported-css", "css", "Unbalanced CSS")
        index += 1
    if stack or quote:
        _fail("unsupported-css", "css", "Unclosed CSS block or string")
    return text


def _tokenize_css(text: str) -> list[_Tok]:
    tokens: list[_Tok] = []
    i, n = 0, len(text)
    while i < n:
        char = text[i]
        if char.isspace():
            i += 1
            continue
        if text[i:i + 2] == "/*":
            end = text.find("*/", i + 2)
            if end < 0:
                _fail("unsupported-css", "css", "Unclosed CSS comment")
            i = end + 2
            continue
        if char in "'\"":
            end = text.find(char, i + 1)
            if end < 0 or "\n" in text[i + 1:end]:
                _fail("unsupported-css", "css", "Unclosed CSS string")
            tokens.append(_Tok("string", text[i:end + 1]))
            i = end + 1
            continue
        if char == "#":
            match = re.match(r"[A-Za-z0-9_-]+", text[i + 1:])
            if not match:
                _fail("unsupported-css", "css", "Malformed hash token")
            tokens.append(_Tok("hash", "#" + match.group(0)))
            i += 1 + len(match.group(0))
            continue
        if char == "@":
            match = re.match(r"[A-Za-z0-9_-]+", text[i + 1:])
            tokens.append(_Tok("at", "@" + (match.group(0) if match else "")))
            i += 1 + (len(match.group(0)) if match else 0)
            continue
        if char.isdigit() or (char in "+-." and i + 1 < n and (text[i + 1].isdigit() or text[i + 1] == ".")):
            match = re.match(NUMBER + r"(?:[A-Za-z%]+)?", text[i:])
            if not match:
                _fail("unsupported-css", "css", "Malformed number token")
            tokens.append(_Tok("number", match.group(0)))
            i += len(match.group(0))
            continue
        if char.isalpha() or char in "_-" or ord(char) > 127:
            match = re.match(r"-?[A-Za-z_][A-Za-z0-9_-]*", text[i:])
            if not match:
                _fail("unsupported-css", "css", "Malformed identifier token")
            name = match.group(0)
            j = i + len(name)
            if j < n and text[j] == "(":
                if name.lower() == "url":
                    k = j + 1
                    while k < n and text[k].isspace():
                        k += 1
                    if k < n and text[k] in "'\"":
                        end = text.find(text[k], k + 1)
                        if end < 0:
                            _fail("unsupported-css", "css", "Unclosed url string")
                        inner = text[k:end + 1]
                        k = end + 1
                    else:
                        end = text.find(")", k)
                        if end < 0:
                            _fail("unsupported-css", "css", "Unclosed url()")
                        inner = text[k:end].strip()
                        k = end
                    while k < n and text[k].isspace():
                        k += 1
                    if k >= n or text[k] != ")":
                        _fail("unsupported-css", "css", "Malformed url()")
                    tokens.append(_Tok("url", f"url({inner})"))
                    i = k + 1
                    continue
                tokens.append(_Tok("function", name + "("))
                i = j + 1
                continue
            tokens.append(_Tok("ident", name))
            i = j
            continue
        tokens.append(_Tok("punct", char))
        i += 1
    return tokens


def _serialize_value(tokens: list[_Tok]) -> str:
    out = ""
    prev_word = False
    for tok in tokens:
        word = tok.type in _WORD
        if out and word and prev_word:
            out += " "
        out += tok.value
        prev_word = word
    return out


class _Budget:
    def __init__(self):
        self.selectors = 0
        self.declarations = 0

    def add_declaration(self):
        self.declarations += 1
        if self.declarations > MAX_DECLARATIONS:
            _fail("resource-limit", "css", "More than 10,000 CSS declarations")

    def add_selectors(self, count):
        self.selectors += count
        if self.selectors > MAX_SELECTORS:
            _fail("resource-limit", "css", "More than 1,000 CSS selectors")


def _parse_declarations(tokens: list[_Tok], budget: _Budget):
    """Parse a declaration list (rule block or inline style attribute)."""
    result = []
    i, n = 0, len(tokens)
    while i < n:
        if tokens[i].type == "punct" and tokens[i].value == ";":
            i += 1
            continue
        if tokens[i].type != "ident":
            _fail("unsupported-css", "css", "Declaration must start with a property name")
        prop = tokens[i].value.lower()
        i += 1
        if i >= n or tokens[i].type != "punct" or tokens[i].value != ":":
            _fail("unsupported-css", "css", f"Declaration for {prop!r} is missing ':'")
        i += 1
        value_tokens: list[_Tok] = []
        depth = 0
        while i < n:
            tok = tokens[i]
            if tok.type == "punct" and tok.value == ";" and depth == 0:
                break
            if tok.type == "function" or (tok.type == "punct" and tok.value == "("):
                depth += 1
            elif tok.type == "punct" and tok.value == ")":
                depth -= 1
                if depth < 0:
                    _fail("unsupported-css", "css", "Unbalanced parenthesis in value")
            value_tokens.append(tok)
            i += 1
        if i < n:
            i += 1  # consume ';'
        if depth != 0:
            _fail("unsupported-css", "css", "Unbalanced parenthesis in value")
        for j, tok in enumerate(value_tokens):
            if tok.type == "punct" and tok.value == "!" and j + 1 < len(value_tokens) \
                    and value_tokens[j + 1].type == "ident" and value_tokens[j + 1].value.lower() == "important":
                _fail("unsupported-css", "css", "!important is not supported")
        budget.add_declaration()
        result.append((prop, _css_value(prop, _serialize_value(value_tokens))))
    return result


def _parse_stylesheet(text: str, budget: _Budget):
    """Parse a style element's text into (selectors, declarations) rules."""
    tokens = _tokenize_css(_checked_css(text))
    rules = []
    i, n = 0, len(tokens)
    while i < n:
        if tokens[i].type == "at":
            _fail("unsupported-css", "css", "At-rules are not supported")
        prelude: list[_Tok] = []
        while i < n and not (tokens[i].type == "punct" and tokens[i].value == "{"):
            if tokens[i].type == "punct" and tokens[i].value in "};":
                _fail("unsupported-css", "css", "Malformed rule prelude")
            prelude.append(tokens[i])
            i += 1
        if i >= n:
            _fail("unsupported-css", "css", "Rule is missing its block")
        i += 1  # consume '{'
        groups: list[list[_Tok]] = [[]]
        for tok in prelude:
            if tok.type == "punct" and tok.value == ",":
                groups.append([])
            else:
                groups[-1].append(tok)
        selectors = []
        for group in groups:
            if len(group) == 1 and group[0].type == "ident":
                selector = group[0].value
                if selector not in TAGS | {"marker"}:
                    _fail("unsupported-css", "css", f"Unsupported element selector: {selector}")
            elif len(group) == 2 and group[0].type == "punct" and group[0].value == "." \
                    and group[1].type == "ident" and re.fullmatch(IDENT, group[1].value):
                selector = "." + group[1].value
            elif len(group) == 1 and group[0].type == "hash" and re.fullmatch(IDENT, group[0].value[1:]):
                selector = group[0].value
            else:
                _fail("unsupported-css", "css", "Unsupported selector (only element, .class and #id are allowed)")
            selectors.append(selector)
        budget.add_selectors(len(selectors))
        block: list[_Tok] = []
        depth = 1
        while i < n and depth:
            tok = tokens[i]
            if tok.type == "punct" and tok.value == "{":
                depth += 1
            elif tok.type == "punct" and tok.value == "}":
                depth -= 1
                if depth == 0:
                    i += 1
                    break
            block.append(tok)
            i += 1
        if depth:
            _fail("unsupported-css", "css", "Unclosed rule block")
        rules.append((selectors, _parse_declarations(block, budget)))
    return rules


def _matches(selector: str, node) -> bool:
    if selector.startswith("."):
        return selector[1:] in node.get("class", "").split()
    if selector.startswith("#"):
        return node.get("id") == selector[1:]
    return _local(node) == selector


def _specificity(selector: str):
    return (int(selector.startswith("#")), int(selector.startswith(".")), int(selector[0] not in ".#"))


# ---------------------------------------------------------------- input inspection (section 2)

def _inspect(root, input_mode=True):
    """Validate the input vocabulary; collect ids, element paths, parents."""
    ids, locations, parent = {}, {}, {}
    css_bytes = 0

    def visit(node, path):
        nonlocal css_bytes
        locations[node] = path
        tag = _local(node)
        if not node.tag.startswith("{" + SVG_NS + "}") or tag not in TAGS | ({"style", "marker"} if input_mode else set()):
            _fail("unsafe-input", "input", f"Unsupported element: {tag}")
        if tag == "svg" and node is not root:
            _fail("unsafe-input", "input", "Nested SVG roots are unsupported")
        if tag == "style":
            owner = parent.get(node)
            if not (owner is root or (owner is not None and _local(owner) == "defs" and parent.get(owner) is root)) or len(node):
                _fail("unsupported-css", "css", "Style element must be a direct child of the root or of a root-level defs and contain only CSS text")
            if set(node.attrib) - {"type"} or node.get("type", "text/css") != "text/css":
                _fail("unsupported-css", "css", "Style element attributes are unsupported")
            css_bytes += len((node.text or "").encode("utf-8"))
        else:
            extra = {"class", "style", "role", "marker-end"} if input_mode else set()
            if input_mode and tag == "marker":
                extra |= {"markerWidth", "markerHeight", "refX", "refY", "orient", "markerUnits"}
            for key, val in node.attrib.items():
                if key not in ATTRS | extra and not (input_mode and re.fullmatch(r"aria-[a-z][a-z-]*", key)):
                    _fail("unsafe-input", "input", f"Unsupported attribute: {key}")
                if key == "style":
                    css_bytes += len(val.encode("utf-8"))
                elif key == "class":
                    if not val.split() or any(not re.fullmatch(IDENT, t) for t in val.split()):
                        _fail("unsupported-css", "css", f"Invalid class token in {val!r}")
                elif key != "role" and not key.startswith("aria-"):
                    if any(c in val for c in "\\@{};<>\x00") or any(ord(c) < 32 and c not in "\t\n\r" for c in val):
                        _fail("unsafe-input", "input", f"Unsupported attribute syntax in {key}")
                    if key in PROPS:
                        _css_value(key, val)
                    elif "url" in val.lower():
                        _fail("unsafe-input", "input", f"Unsupported resource syntax in {key}")
                if key == "id":
                    if not re.fullmatch(SVG_ID, val) or val in ids:
                        _fail("invalid-reference", "input", f"Invalid or duplicate id: {val}")
                    ids[val] = node
        counts: dict[str, int] = {}
        for child in node:
            name = _local(child)
            counts[name] = counts.get(name, 0) + 1
            parent[child] = node
            visit(child, f"{path}/{name}[{counts[name]}]")
    visit(root, "/svg[1]")
    if css_bytes > MAX_CSS_BYTES:
        _fail("resource-limit", "input", "CSS exceeds 100,000 bytes across style elements and attributes")
    return ids, locations, parent


def _check_ref(prop, val, ids, node, parent):
    if not val.startswith("url("):
        return
    kinds = {"marker-end": {"marker"}, "clip-path": {"clipPath"}}.get(prop, {"linearGradient", "radialGradient"})
    if val[5:-1] not in ids or _local(ids[val[5:-1]]) not in kinds:
        _fail("invalid-reference", "references", f"Reference from {prop} does not resolve to a supported target: {val}")
    cur = node
    while cur is not None:
        if _local(cur) in {"linearGradient", "radialGradient", "clipPath", "marker"}:
            _fail("invalid-reference", "references", f"Reference inside a resource definition: {val}")
        cur = parent.get(cur)


def _check_ref_target(prop, val, ids):
    if not val.startswith("url("):
        return
    kinds = {"marker-end": {"marker"}, "clip-path": {"clipPath"}}.get(prop, {"linearGradient", "radialGradient"})
    if val[5:-1] not in ids or _local(ids[val[5:-1]]) not in kinds:
        _fail("invalid-reference", "references", f"Reference from {prop} does not resolve to a supported target: {val}")


# ---------------------------------------------------------------- markers (section 3.1)

def _path_points(d):
    """Parse a marker host path; return (points, final tangent vector).

    Amendment G2 (makotosan/vector-png-spec#3): absolute C segments are
    admitted alongside M/L/H/V (S/Q/T and every other command remain
    rejected). The final tangent of a cubic segment is endpoint minus
    second control point, falling back to endpoint minus first control
    point when the former is zero; if both are zero the host is
    degenerate and rejected, as is a zero-length straight final segment.
    """
    tokens = re.findall(r"[MLHVC]|" + NUMBER, d)
    if re.sub(r"[\s,]", "", "".join(tokens)) != re.sub(r"[\s,]", "", d):
        _fail("unsupported-css", "markers", "Marker host path may use only absolute M/L/H/V/C segments")
    points, index, command, tangent = [], 0, None, None
    while index < len(tokens):
        if tokens[index] in {"M", "L", "H", "V", "C"}:
            command = tokens[index]
            index += 1
        count = 6 if command == "C" else 2 if command in {"M", "L"} else 1
        if command is None or index + count > len(tokens) or any(t in {"M", "L", "H", "V", "C"} for t in tokens[index:index + count]):
            _fail("unsupported-css", "markers", "Malformed marker host path")
        coords = [_scalar(t) for t in tokens[index:index + count]]
        index += count
        if command == "C":
            if not points:
                _fail("unsupported-css", "markers", "Marker host path must start with a point")
            end = (coords[4], coords[5])
            tangent = (end[0] - coords[2], end[1] - coords[3])
            if tangent == (0, 0):
                tangent = (end[0] - coords[0], end[1] - coords[1])
            points.append(end)
            continue
        if command in {"H", "V"}:
            if not points:
                _fail("unsupported-css", "markers", "Marker host path must start with a point")
            coords = [coords[0], points[-1][1]] if command == "H" else [points[-1][0], coords[0]]
        elif command == "M" and points:
            _fail("unsupported-css", "markers", "Marker host path must be a single subpath")
        point = tuple(coords)
        if points:
            tangent = (point[0] - points[-1][0], point[1] - points[-1][1])
        points.append(point)
        if command == "M":
            command = "L"
    if len(points) < 2 or tangent is None or tangent == (0, 0):
        _fail("unsupported-css", "markers", "Marker host path has a degenerate last segment")
    return points, tangent


def _marker_definition(src, parent, computed):
    """Validate one marker definition (called for every definition, used or not)."""
    owner = parent.get(src)
    if owner is None or _local(owner) != "defs" or parent.get(owner) is None or _local(parent[owner]) != "svg" \
            or parent.get(parent[owner]) is not None:
        _fail("unsupported-css", "markers", "Markers must be direct children of a root-level defs")
    allowed = {"id", "markerWidth", "markerHeight", "refX", "refY", "orient", "markerUnits"}
    if set(src.attrib) - allowed or src.get("orient") != "auto" or len(src) != 1 or _local(src[0]) != "path":
        _fail("unsupported-css", "markers", "Marker definition is outside the restricted subset")
    w = _scalar(src.get("markerWidth", ""), 0)
    h = _scalar(src.get("markerHeight", ""), 0)
    if w <= 0 or h <= 0:
        _fail("unsupported-css", "markers", "Marker width/height must be positive")
    ref_x = _scalar(src.get("refX", "0"), 0, w)
    ref_y = _scalar(src.get("refY", "0"), 0, h)
    child = src[0]
    # The closepath command is case-insensitive in SVG (z == Z, with no
    # relative/absolute distinction); corpus files use lowercase z.
    # The triangle geometry itself remains exact.
    triangle = (r"M\s*0\s*,?\s*0\s+L\s*" + re.escape(f"{w:g}") + r"\s*,?\s*" + re.escape(f"{h / 2:g}")
                + r"\s+L\s*0\s*,?\s*" + re.escape(f"{h:g}") + r"\s*[Zz]")
    if set(child.attrib) - {"d", "fill"} or not re.fullmatch(triangle, child.get("d", "")):
        _fail("unsupported-css", "markers", "Only the viewport-contained triangle marker geometry is supported")
    paint = computed.get(child, {}).get("fill", "black")
    if paint.startswith("url(") or paint == "none":
        _fail("unsupported-css", "markers", "Marker paint must be a solid color")
    unit = src.get("markerUnits", "strokeWidth")
    if unit not in {"strokeWidth", "userSpaceOnUse"}:
        _fail("unsupported-css", "markers", f"Unsupported markerUnits: {unit}")
    return ref_x, ref_y, child, paint, unit


# ---------------------------------------------------------------- transform (sections 3-5)

def normalize_structure(source: bytes):
    """Transform input bytes; return (output_bytes, analysis_report).

    The analysis report has render ``not-checked`` and status
    ``failure`` by construction (mirroring the spec fixture tool): only
    the gated public entry points below may report success.
    """
    _preflight(source)
    root = _parse_tree(source)
    ids, locations, parent = _inspect(root)
    original_text = {node: " ".join("".join(node.itertext()).split()) for node in root.iter()}
    original_aria = {node for node in root.iter() if any(k.startswith("aria-") for k in node.attrib)}
    budget = _Budget()
    rules = []
    changes = {"style_elements": 0, "class_attributes": 0, "inline_styles": 0,
               "applied_declarations": 0, "expanded_markers": 0}
    for node in root.iter():
        if _local(node) != "style":
            continue
        rules.extend(_parse_stylesheet(node.text or "", budget))
    # Every stylesheet declaration is reference-checked even when it
    # never wins or matches (profile section 2).
    for _, decls in rules:
        for prop, val in decls:
            _check_ref_target(prop, val, ids)
    computed: dict = {}
    for node in list(root.iter()):
        if _local(node) == "style":
            continue
        chosen = {k: ((0, 0, 0, -1), _css_value(k, v)) for k, v in node.attrib.items() if k in PROPS}
        for selectors, decls in rules:
            specs = [_specificity(s) for s in selectors if _matches(s, node)]
            if specs:
                for prop, val in decls:
                    _check_ref(prop, val, ids, node, parent)
                    rank = (0,) + max(specs)
                    if prop not in chosen or rank >= chosen[prop][0]:
                        chosen[prop] = (rank, val)
        if "style" in node.attrib:
            inline = _checked_css(node.attrib["style"])
            for prop, val in _parse_declarations(_tokenize_css(inline), budget):
                _check_ref(prop, val, ids, node, parent)
                chosen[prop] = ((1, 0, 0, 0), val)
            changes["inline_styles"] += 1
        for prop, (_, val) in chosen.items():
            _check_ref(prop, val, ids, node, parent)
            if prop in {"rx", "ry"} and _local(node) != "rect":
                _fail("unsupported-css", "css", "CSS rx/ry apply only to rect")
            node.set(prop, val)
        changes["applied_declarations"] += len(chosen)
        values = {k: v for k, v in computed.get(parent.get(node), {}).items() if k in INHERITED}
        values.update({k: v[1] for k, v in chosen.items()})
        computed[node] = values
        if "class" in node.attrib:
            changes["class_attributes"] += 1
            del node.attrib["class"]
        node.attrib.pop("style", None)
    markers = {node: _marker_definition(node, parent, computed)
               for node in root.iter() if _local(node) == "marker"}
    accessibility = _migrate_accessibility(root, ids, locations, original_text, original_aria)
    for node in list(root.iter()):
        marker = computed.get(node, {}).get("marker-end", "none")
        node.attrib.pop("marker-end", None)
        if marker == "none":
            continue
        if _local(node) != "path" or computed[node].get("fill", "black") != "none":
            _fail("unsupported-css", "markers", "marker-end hosts must be paths with fill none")
        src = ids[marker[5:-1]]
        ref_x, ref_y, child, paint, unit = markers[src]
        scale = _scalar(computed[node].get("stroke-width", "1"), 0, px=True) if unit == "strokeWidth" else 1
        points, (dx, dy) = _path_points(node.get("d", ""))
        x, y = points[-1]
        if any(k in computed[node] for k in {"opacity", "clip-path"}) or "transform" in node.attrib:
            _fail("unsupported-css", "markers", "Marker host transform, opacity or clip-path is unsupported")
        angle = math.degrees(math.atan2(dy, dx))
        group = ET.Element("{" + SVG_NS + "}g", {
            "transform": f"translate({x:g} {y:g}) rotate({angle:g}) scale({scale:g}) translate({-ref_x:g} {-ref_y:g})",
            "fill": paint, "stroke": "none"})
        clone = copy.deepcopy(child)
        clone.attrib.pop("id", None)
        clone.set("fill", paint)
        group.append(clone)
        container = parent[node]
        container.insert(list(container).index(node) + 1, group)
        changes["expanded_markers"] += 1
    for node in list(root.iter()):
        for child in list(node):
            if _local(child) in {"style", "marker"}:
                changes["style_elements"] += int(_local(child) == "style")
                node.remove(child)
    output = ET.tostring(root, encoding="utf-8")
    if len(output) > MAX_BYTES:
        _fail("resource-limit", "output", "Normalized output exceeds 1,000,000 bytes")
    try:
        validate_source(output)
    except CoreError as exc:
        _fail("unsupported-css", "output", f"Normalized output does not satisfy safe-svg-v1: {exc}")
    report = {
        "profile": PROFILE, "status": "failure",
        "input_sha256": hashlib.sha256(source).hexdigest(), "output_sha256": None,
        "changes": changes, "accessibility": accessibility,
        "checks": {"input": "pass", "safe_svg": "pass", "render": "not-checked",
                   "container": "not-applicable", "authenticity": "not-verified"},
        "render": None, "errors": [],
        "warnings": [{"code": "accessibility-loss", "stage": "accessibility",
                      "explanation": "Review recorded semantic losses"}]
        if any("loss" in record for record in accessibility) else [],
    }
    return output, report


def _migrate_accessibility(root, ids, locations, original_text, original_aria):
    records = []
    for node in list(root.iter()):
        if _local(node) == "style":
            continue
        attrs = {k: v for k, v in node.attrib.items() if k == "role" or k.startswith("aria-")}
        if not attrs:
            continue

        def resolve(text):
            refs = text.split()
            if not refs or len(refs) != len(set(refs)):
                _fail("invalid-reference", "accessibility", "Accessibility ID lists must be nonempty and unique")
            values = []
            for ref in refs:
                target = ids.get(ref)
                if target is None or target is node or any(
                        _local(t) not in {"title", "desc", "text", "tspan"} or t in original_aria
                        for t in target.iter()):
                    _fail("invalid-reference", "accessibility", f"Accessibility target is missing or not text-only: {ref}")
                values.append(original_text[target])
            return " ".join(values)

        name = resolve(attrs["aria-labelledby"]) if "aria-labelledby" in attrs else \
            " ".join(attrs["aria-label"].split()) if "aria-label" in attrs else None
        description = resolve(attrs["aria-describedby"]) if "aria-describedby" in attrs else None
        for tag, new_text in [("title", name), ("desc", description)]:
            existing = [n for n in node if _local(n) == tag]
            if len(existing) > 1:
                _fail("invalid-reference", "accessibility", f"Multiple direct {tag} children are unsupported")
            if new_text is not None:
                if existing:
                    old_text = "".join(existing[0].itertext())
                    if old_text != new_text:
                        records.append({"element": locations[node], "attribute": tag,
                                        "value": old_text, "loss": "replaced-text"})
                    for child in list(existing[0]):
                        existing[0].remove(child)
                    existing[0].text = new_text
                else:
                    fresh = ET.Element("{" + SVG_NS + "}" + tag)
                    fresh.text = new_text
                    node.insert(0 if tag == "title" else 1, fresh)
        for key, val in sorted(attrs.items()):
            target = "title" if key == "aria-labelledby" or (key == "aria-label" and "aria-labelledby" not in attrs) \
                else "desc" if key == "aria-describedby" else None
            record = {"element": locations[node], "attribute": key, "value": val}
            if target:
                record["target"] = target
            else:
                record["loss"] = "lower-priority-label" if key == "aria-label" else "unsupported-semantics"
            records.append(record)
            del node.attrib[key]
    return records


# ---------------------------------------------------------------- rendering gate (section 6)

_RENDER_SNIPPET = (
    "import json,sys\n"
    "from vector_png_editor import _backend\n"
    "svg,width,height=json.loads(sys.stdin.buffer.read())\n"
    "sys.stdout.buffer.write(_backend._render_worker(svg,width,height))\n"
)


def _render_unchecked(text: str, width: int, height: int) -> bytes:
    """Render CSS-styled input in the same worker/renderer as the Core.

    _backend.render() validates safe-svg-v1 first, which CSS-styled
    input by definition fails; the worker entry point used here is the
    identical CairoSVG configuration with fetching denied.
    """
    try:
        result = subprocess.run(
            [sys.executable, "-c", _RENDER_SNIPPET],
            input=json.dumps([text, width, height]).encode("utf-8"),
            capture_output=True, timeout=20,
            creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
        )
    except subprocess.TimeoutExpired:
        _fail("render-error", "render", "Before-render timed out")
    if result.returncode:
        _fail("render-error", "render",
              "Before-render failed: " + result.stderr.decode("utf-8", errors="replace")[:500])
    if len(result.stdout) > _backend.MAX_PNG or not result.stdout.startswith(_backend.SIGNATURE):
        _fail("render-error", "render", "Renderer returned invalid or excessive PNG")
    return result.stdout


def _rgba(png: bytes):
    from PIL import Image
    with Image.open(io.BytesIO(png)) as image:
        rgba = image.convert("RGBA")
        return rgba.size, rgba.tobytes()


def _viewport(root):
    def decimal(raw):
        if raw is None:
            return None
        match = re.fullmatch("(" + NUMBER + ")(?:px)?", raw.strip())
        return float(match.group(1)) if match else None

    width, height = decimal(root.get("width")), decimal(root.get("height"))
    if width is None or height is None:
        view_box = (root.get("viewBox") or "").replace(",", " ").split()
        if len(view_box) == 4:
            try:
                width, height = float(view_box[2]), float(view_box[3])
            except ValueError:
                width = height = None
    if width is None or height is None or width < 1 or height < 1:
        width, height = 1024.0, 1024.0
    if width > MAX_SIDE or height > MAX_SIDE or width * height > MAX_PIXELS:
        _fail("resource-limit", "input", "Viewport exceeds 4096 pixels per side or 4,000,000 pixels")
    return int(round(width)), int(round(height))


def _render_gate(source: bytes, output: bytes, report: dict) -> None:
    root = _parse_tree(output)
    width, height = _viewport(root)
    try:
        text = source.decode("utf-8-sig", errors="strict")
    except UnicodeError:
        _fail("invalid-xml", "input", "Input is not strict UTF-8")
    before = _render_unchecked(text, width, height)
    try:
        after = render_source(output, width, height)
    except CoreError as exc:
        _fail("render-error", "render", f"After-render failed: {exc}")
    from importlib.metadata import version
    report["render"] = {
        "renderer": "CairoSVG", "renderer_version": version("CairoSVG"),
        "fonts": "host-selected", "viewport": [width, height],
        "background": "transparent", "color_alpha": "CairoSVG default; transparent background",
        "resource_policy": "fetch denied", "comparison": "exact",
        "tolerances": None,
        "text_policy": "grayscale antialias; hint style/metrics disabled",
    }
    if _rgba(before) != _rgba(after):
        report["checks"]["render"] = "mismatch"
        _fail("render-mismatch", "render", "Before/after renders differ under exact decoded RGBA equality")
    report["checks"]["render"] = "pass"


# ---------------------------------------------------------------- publication (section 6)

def _check_paths(input_path: Path, output_path: Path, report_path: Path) -> None:
    paths = [input_path, output_path, report_path]
    for i, path in enumerate(paths):
        for other in paths[:i]:
            if path.resolve() == other.resolve() or (path.exists() and other.exists() and os.path.samefile(path, other)):
                raise CoreError("output-alias", "Output and report paths must be distinct from each other and from the input")
    if output_path.exists() or report_path.exists():
        raise CoreError("output-exists", "Output or report already exists")


def _publish_pair(pairs) -> None:
    """Stage all payloads, then publish each with no-clobber hard links."""
    staged, published = [], []
    try:
        for path, payload in pairs:
            fd, name = tempfile.mkstemp(prefix=".normalization-", dir=path.parent)
            staged.append(name)
            with os.fdopen(fd, "wb") as stream:
                stream.write(payload)
                stream.flush()
                os.fsync(stream.fileno())
        for (path, _), name in zip(pairs, staged):
            try:
                os.link(name, path)
            except FileExistsError as exc:
                raise CoreError("output-exists", "Output appeared during publication") from exc
            published.append((path, name))
    except BaseException:
        for path, name in reversed(published):
            if path.exists() and os.path.samefile(path, name):
                path.unlink()
        raise
    finally:
        for name in staged:
            if os.path.exists(name):
                os.unlink(name)


def _write_failure_report(report_path: Path, report: dict) -> None:
    payload = (json.dumps(report, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
    _publish_pair([(report_path, payload)])


def _failure_report(source: bytes, exc: NormalizeFailure, skeleton: dict) -> dict:
    report = skeleton
    report["status"] = "failure"
    report["output_sha256"] = None
    report["errors"] = [{"code": exc.code, "stage": exc.stage, "explanation": str(exc)[:2000]}]
    if exc.stage == "input":
        report["checks"]["input"] = "fail"
        report["checks"]["safe_svg"] = "not-checked"
    elif exc.stage == "output":
        report["checks"]["safe_svg"] = "fail"
    elif exc.stage in {"render"}:
        if exc.code != "render-mismatch":
            report["checks"]["render"] = "error"
    return report


def _skeleton(source: bytes) -> dict:
    return {
        "profile": PROFILE, "status": "failure",
        "input_sha256": hashlib.sha256(source).hexdigest(), "output_sha256": None,
        "changes": {"style_elements": 0, "class_attributes": 0, "inline_styles": 0,
                    "applied_declarations": 0, "expanded_markers": 0},
        "accessibility": [],
        "checks": {"input": "pass", "safe_svg": "not-checked", "render": "not-checked",
                   "container": "not-applicable", "authenticity": "not-verified"},
        "render": None, "errors": [], "warnings": [],
    }


def _read_input(path: Path) -> bytes:
    try:
        with path.open("rb") as stream:
            data = stream.read(MAX_BYTES + 1)
    except OSError as exc:
        raise CoreError("io-error", str(exc)) from exc
    if len(data) > MAX_BYTES:
        _fail("resource-limit", "input", "Input exceeds 1,000,000 bytes")
    return data


# ---------------------------------------------------------------- public entry points

def normalize_document(input_path, output_path, report_path) -> dict:
    """Normalize an SVG file to a safe-svg-v1 SVG file plus JSON report."""
    input_path, output_path, report_path = Path(input_path), Path(output_path), Path(report_path)
    _check_paths(input_path, output_path, report_path)
    source = _read_input(input_path)
    skeleton = _skeleton(source)
    report = None
    try:
        output, report = normalize_structure(source)
        _render_gate(source, output, report)
    except NormalizeFailure as exc:
        failure = _failure_report(source, exc, report if report is not None else skeleton)
        _write_failure_report(report_path, failure)
        raise CoreError(exc.code, str(exc), {"report": failure}) from exc
    report["status"] = "success"
    report["output_sha256"] = hashlib.sha256(output).hexdigest()
    payload = (json.dumps(report, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
    _publish_pair([(output_path, output), (report_path, payload)])
    return report


def convert_document(input_path, output_path, report_path) -> dict:
    """Normalize an SVG file and embed it as a vector-png PNG plus report."""
    input_path, output_path, report_path = Path(input_path), Path(output_path), Path(report_path)
    _check_paths(input_path, output_path, report_path)
    source = _read_input(input_path)
    skeleton = _skeleton(source)
    analysis = None
    try:
        output, analysis = normalize_structure(source)
        _render_gate(source, output, analysis)
    except NormalizeFailure as exc:
        failure = _failure_report(source, exc, {**skeleton, **{
            "changes": analysis["changes"], "accessibility": analysis["accessibility"],
            "checks": analysis["checks"], "render": analysis["render"],
            "warnings": analysis["warnings"]}} if analysis is not None else skeleton)
        _write_failure_report(report_path, failure)
        raise CoreError(exc.code, str(exc), {"report": failure}) from exc
    root = _parse_tree(output)
    width, height = _viewport(root)
    from .writing import _candidate
    try:
        png_data, container = _candidate(output, width, height)
    except CoreError as exc:
        analysis["checks"]["container"] = "fail"
        code = exc.code if exc.code in {"render-mismatch", "resource-limit"} else "render-error"
        failure = _failure_report(source, NormalizeFailure(code, "container", str(exc)), analysis)
        _write_failure_report(report_path, failure)
        raise CoreError(code, str(exc), {"report": failure}) from exc
    analysis["checks"]["container"] = "pass"
    analysis["status"] = "success"
    analysis["output_sha256"] = hashlib.sha256(png_data).hexdigest()
    analysis["normalized_svg_sha256"] = hashlib.sha256(output).hexdigest()
    analysis["container_detail"] = {"preview": container["preview"], "renderer": container["renderer"],
                                    "renderer_version": container["renderer_version"]}
    payload = (json.dumps(analysis, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
    _publish_pair([(output_path, png_data), (report_path, payload)])
    return analysis

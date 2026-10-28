"""Structured safe-svg-v1 diagnostics (Issue #22, Phase 1).

`validate_svg` in _backend.py answers pass/fail with the first error.
This module answers *where and why*, collecting every violation as a
diagnostic with severity/code/element/attribute/line/column/message/
suggestion, for the `validate --profile safe-svg-v1` generation gate.

Verdicts mirror the Core exactly (same allowlists, value rules,
reference typing and limits - the sets are shared, not copied).
With `strict_structure=True` the generated schema's content models
are enforced as well; that layer constrains *authoring* (AI
generation) and is deliberately not part of Core acceptance, so
existing valid files keep building (docs/SAFE_SVG_V1.md).
"""
import re
from xml.parsers import expat

from . import _backend
from .errors import CoreError
from .svg import SVG_NS, parse_source

MAX_DIAGNOSTICS = 50
_DEFINITION_ELEMENTS = {"clipPath", "linearGradient", "radialGradient"}

# Content models of the generated schema layer: element -> allowed
# child elements ("any" = every allowed element). Generated artifacts
# and this table are both checked against schemas/safe-svg-v1.policy.yaml.
_CONTAINERS = set(_backend.TAGS) - {"stop"}  # stop belongs only inside gradients
CONTENT_MODELS = {
    "svg": _CONTAINERS, "g": _CONTAINERS, "defs": _CONTAINERS, "clipPath": _CONTAINERS,
    "linearGradient": {"stop", "title", "desc"},
    "radialGradient": {"stop", "title", "desc"},
    "text": {"tspan"}, "tspan": {"tspan"},
    "title": set(), "desc": set(), "stop": set(), "path": set(),
    "rect": set(), "circle": set(), "ellipse": set(), "line": set(),
    "polyline": set(), "polygon": set(),
}

_SUGGESTIONS = {
    "class": "class is not supported; set presentation attributes (fill, stroke, opacity, ...) directly on the element",
    "style": "style is not supported; set presentation attributes directly on the element",
    "href": "hyperlinks and external references are not supported",
    "xlink:href": "hyperlinks and external references are not supported",
    "script": "scripting is not supported; remove the element",
}


def _suggestion_for(name: str) -> str | None:
    if name in _SUGGESTIONS:
        return _SUGGESTIONS[name]
    if name.startswith("on"):
        return "event-handler attributes are not supported"
    return None


class _Node:
    __slots__ = ("tag", "attrs", "line", "column", "parent", "children")

    def __init__(self, tag, attrs, line, column, parent):
        self.tag, self.attrs, self.line, self.column, self.parent = tag, attrs, line, column, parent
        self.children = []


def _record(source: bytes) -> _Node:
    parser = expat.ParserCreate(namespace_separator="}")
    stack: list[_Node] = []
    root: _Node | None = None

    def start(name, attrs):
        nonlocal root
        node = _Node(name, attrs, parser.CurrentLineNumber, parser.CurrentColumnNumber,
                     stack[-1] if stack else None)
        if stack:
            stack[-1].children.append(node)
        else:
            root = node
        stack.append(node)

    def end(name):
        stack.pop()

    parser.StartElementHandler = start
    parser.EndElementHandler = end
    parser.Parse(source, True)
    assert root is not None
    return root


def check_profile(source: bytes, *, strict_structure: bool = False) -> list[dict]:
    """Return the diagnostics for a source (empty list = conforming).

    XML-level failures (malformed, DTD, limits) raise CoreError from
    parse_source exactly as the rest of the Core reports them; only
    profile-level violations become diagnostics.
    """
    parse_source(source)
    root = _record(source)
    diagnostics: list[dict] = []

    def add(code, node, message, attribute=None, suggestion=None):
        if len(diagnostics) >= MAX_DIAGNOSTICS:
            return
        tag = node.tag.split("}")[-1] if node else None
        diagnostics.append({
            "severity": "error", "code": code,
            "element": tag, "attribute": attribute,
            "line": node.line if node else None, "column": node.column if node else None,
            "message": message,
            "suggestion": suggestion or _suggestion_for(attribute or tag or ""),
        })

    ids: dict[str, _Node] = {}
    refs: list[tuple[_Node, str, str]] = []
    order: list[_Node] = []
    stack = [root]
    while stack:
        node = stack.pop()
        order.append(node)
        stack.extend(reversed(node.children))
    for node in order:
        raw_tag = node.tag
        tag = raw_tag.split("}")[-1]
        if not raw_tag.startswith(f"{SVG_NS}}}") or tag not in _backend.TAGS:
            add("unsupported-element", node, f"Unsupported SVG element: {raw_tag}",
                suggestion=_suggestion_for(tag))
            continue
        if strict_structure and node.parent is not None:
            parent_tag = node.parent.tag.split("}")[-1]
            model = CONTENT_MODELS.get(parent_tag)
            if model is not None and tag not in model:
                add("structure", node,
                    f"<{tag}> is not allowed inside <{parent_tag}> by the safe-svg-v1 content model",
                    suggestion=f"move <{tag}> out of <{parent_tag}>, or remove it")
        in_definition = False
        ancestor = node
        while ancestor is not None:
            if ancestor.tag.split("}")[-1] in _DEFINITION_ELEMENTS:
                in_definition = True
                break
            ancestor = ancestor.parent
        for name, value in node.attrs.items():
            if name not in _backend.ATTRS:
                add("unsupported-attribute", node, f"Unsupported SVG attribute: {name}", attribute=name)
                continue
            if any(c in value for c in "\\@{};<>") or any(ord(c) < 32 and c not in "\t\n\r" for c in value):
                add("forbidden-value", node, f"Unsupported attribute syntax in {name}", attribute=name,
                    suggestion="remove backslash, @, braces, semicolons, angle brackets and control characters")
            if "url" in value.lower():
                if name not in {"fill", "stroke", "clip-path"} or not _backend.FRAGMENT.fullmatch(value):
                    add("invalid-url", node, "Only local paint/clip URLs are supported", attribute=name,
                        suggestion="use url(#id) pointing at a local gradient or clipPath")
                else:
                    if in_definition:
                        add("reference-in-definition", node,
                            "References inside resource definitions are unsupported", attribute=name)
                    refs.append((node, name, value[5:-1]))
            if name == "id":
                if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_.-]*", value):
                    add("invalid-id", node, f"Invalid SVG id: {value}", attribute=name,
                        suggestion="ids must match [A-Za-z_][A-Za-z0-9_.-]*")
                elif value in ids:
                    add("duplicate-id", node, f"Duplicate SVG id: {value}", attribute=name)
                else:
                    ids[value] = node
    for node, name, ref in refs:
        expected = {"clipPath"} if name == "clip-path" else {"linearGradient", "radialGradient"}
        target = ids.get(ref)
        if target is None:
            add("unresolved-reference", node, f"Reference to missing id: {ref}", attribute=name,
                suggestion="define the referenced element with this id, or remove the reference")
        elif target.tag.split("}")[-1] not in expected:
            add("wrong-reference-type", node,
                f"{name} must reference {' or '.join(sorted(expected))}, not <{target.tag.split('}')[-1]}>",
                attribute=name)
    return diagnostics

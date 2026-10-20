"""Adapted validation/rendering from makotosan/vector-png (MIT).
Copyright (c) 2026 makotosan and vector-png contributors.
Pinned d00dd8800cdf6978ebf1d5c6ae61042c7fbadbc2, vector_png.py.
Changes: parser-aware XML checks, package worker invocation. See THIRD_PARTY_NOTICES.md.
"""
from __future__ import annotations
import json
import os
from pathlib import Path
import re
import subprocess
import sys
from .errors import CoreError

KEY = "vector-png.svg"
SIGNATURE = b"\x89PNG\r\n\x1a\n"
SVG_NS = "http://www.w3.org/2000/svg"
MAX_SVG = 1_000_000
MAX_PNG = 32_000_000
MAX_PIXELS = 4_000_000
MAX_SIDE = 4096
TAGS = set("svg g defs title desc path rect circle ellipse line polyline polygon text tspan linearGradient radialGradient stop clipPath".split())
ATTRS = set("id x y x1 y1 x2 y2 cx cy r rx ry width height viewBox preserveAspectRatio d points transform fill fill-opacity fill-rule stroke stroke-width stroke-opacity stroke-linecap stroke-linejoin stroke-miterlimit stroke-dasharray stroke-dashoffset opacity font-family font-size font-weight font-style text-anchor dominant-baseline dx dy rotate offset stop-color stop-opacity gradientUnits gradientTransform spreadMethod fx fy fr clip-path clipPathUnits".split())
FRAGMENT = re.compile(r"url\(#[A-Za-z_][A-Za-z0-9_.-]*\)")


class VectorPNGError(ValueError):
    """Invalid, unsupported or excessive input."""


def validate_svg(svg: str):
    from .svg import parse_source
    _, root = parse_source(svg.encode("utf-8"))
    ids = {}
    refs = []
    stack = [(root, 0)]
    count = 0
    while stack:
        node, depth = stack.pop()
        count += 1
        if count > 5000 or depth > 32:
            raise VectorPNGError("SVG complexity limit exceeded")
        if not node.tag.startswith(f"{{{SVG_NS}}}") or node.tag.split("}")[-1] not in TAGS:
            raise VectorPNGError(f"Unsupported SVG element: {node.tag}")
        tag = node.tag.split("}")[-1]
        for name, value in node.attrib.items():
            if name not in ATTRS or len(value) > 100_000:
                raise VectorPNGError(f"Unsupported SVG attribute: {name}")
            # CSS escapes, declarations and non-ASCII controls cannot hide resource URLs.
            if any(c in value for c in "\\@{};<>\x00") or any(ord(c) < 32 and c not in "\t\n\r" for c in value):
                raise VectorPNGError("Unsupported attribute syntax")
            if "url" in value.lower():
                if name not in {"fill", "stroke", "clip-path"} or not FRAGMENT.fullmatch(value):
                    raise VectorPNGError("Only local paint/clip URLs are supported")
                refs.append((name, value[5:-1]))
            if name == "id":
                if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_.-]*", value) or value in ids:
                    raise VectorPNGError("Invalid or duplicate SVG id")
                ids[value] = tag
        stack.extend((child, depth + 1) for child in node)
    for name, ref in refs:
        expected = {"clipPath"} if name == "clip-path" else {"linearGradient", "radialGradient"}
        if ids.get(ref) not in expected:
            raise VectorPNGError("Invalid local resource reference")
    # Disallow references from definitions, preventing recursive clips/paint servers.
    for node in root.iter():
        if node.tag.split("}")[-1] in {"clipPath", "linearGradient", "radialGradient"}:
            if any("url" in v.lower() for child in node.iter() for v in child.attrib.values()):
                raise VectorPNGError("References inside resource definitions are unsupported")
    return root


def _deny_fetch(*args, **kwargs):
    raise VectorPNGError("External SVG resources are disabled")


def _render_worker(svg, width, height):
    try:
        # Windows Cairo DLL directory can be supplied without modifying global PATH.
        dll_dir = os.environ.get("VECTOR_PNG_CAIRO_DIR")
        config = Path(__file__).resolve().parent.parent / 'cairo-path.txt'
        if not dll_dir and os.name == 'nt' and config.is_file():
            dll_dir = config.read_text(encoding='utf-8-sig').strip()
        handle = os.add_dll_directory(dll_dir) if os.name == "nt" and dll_dir else None
        if os.name == "nt" and dll_dir:
            # ctypes.find_library and CFFI's legacy loader also need PATH.
            # This changes only the disposable worker's environment.
            os.environ["PATH"] = dll_dir + os.pathsep + os.environ.get("PATH", "")
        from cairosvg import surface as cairo_surface
        from cairosvg.surface import PNGSurface
        # PNG pixels must not depend on a display's LCD subpixel configuration.
        # This worker owns these module dictionaries; no caller process is changed.
        cairo_surface.TEXT_ANTIALIAS[None] = cairo_surface.cairo.ANTIALIAS_GRAY
        cairo_surface.TEXT_HINT_STYLE[None] = cairo_surface.cairo.HINT_STYLE_NONE
        cairo_surface.TEXT_HINT_METRICS[None] = cairo_surface.cairo.HINT_METRICS_OFF
        png = PNGSurface.convert(bytestring=svg.encode("utf-8"), unsafe=False,
                                 output_width=width, output_height=height,
                                 url_fetcher=_deny_fetch)
        if handle:
            handle.close()
        return png
    except Exception as exc:
        raise VectorPNGError(f"SVG renderer failed: {type(exc).__name__}: {exc}") from exc


def render(svg, width, height, timeout=20):
    validate_svg(svg)
    if (not isinstance(width, int) or not isinstance(height, int)
            or min(width, height) < 1 or max(width, height) > MAX_SIDE
            or width * height > MAX_PIXELS):
        raise VectorPNGError("Invalid dimensions (max side 4096; max 4 million pixels)")
    try:
        result = subprocess.run(
            [sys.executable, "-m", "vector_png_editor._worker"],
            input=json.dumps([svg, width, height]).encode('utf-8'),
            capture_output=True, timeout=timeout,
            creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0,
        )
    except subprocess.TimeoutExpired as exc:
        raise CoreError("render-timeout", "SVG rendering timed out") from exc
    if result.returncode:
        raise VectorPNGError(result.stderr.decode('utf-8', errors='replace')[:2000])
    if len(result.stdout) > MAX_PNG or not result.stdout.startswith(SIGNATURE):
        raise VectorPNGError("SVG renderer returned invalid or excessive PNG")
    return result.stdout



"""Shared bounded rendering adapter; no source reserialization."""
from importlib.metadata import version
from .errors import CoreError
from .svg import validate_source


def render_source(source, width=1024, height=1024):
    validate_source(source)
    if (type(width) is not int or type(height) is not int
            or min(width, height) < 1 or max(width, height) > 4096 or width * height > 4_000_000):
        raise CoreError("resource-limit", "Viewport exceeds declared dimensions/pixel limits")
    from . import _backend
    try:
        return _backend.render(source.decode("utf-8"), width, height)
    except _backend.VectorPNGError as exc:
        raise CoreError("render-failed", str(exc)) from exc


def validate_render(source, width=1024, height=1024):
    report = validate_source(source)
    render_source(source, width, height)
    report.update(render="passed", renderer="CairoSVG", renderer_version=version("CairoSVG"),
                  viewport=[width, height], fonts="host-selected", color_alpha="CairoSVG default; transparent background",
                  text_policy="grayscale antialias; hint style/metrics disabled", preview="not-checked")
    return report

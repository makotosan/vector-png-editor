"""Read-only environment health probe, independent of editor/venv setup."""
from importlib import metadata
import json
import platform
import sys

from . import __version__
from .errors import CoreError

PINS = {"Pillow": "13.0.0", "CairoSVG": "2.9.1", "defusedxml": "0.7.1"}


def validate_render(*args):
    from .rendering import validate_render as validate
    return validate(*args)


def diagnose():
    packages = {}
    for name, expected in PINS.items():
        try:
            actual = metadata.version(name)
        except metadata.PackageNotFoundError:
            actual = None
        packages[name] = {"expected": expected, "actual": actual, "match": actual == expected}
    report = {"core_version": __version__, "python_version": platform.python_version(),
              "python_supported": (3, 11) <= sys.version_info[:2] < (3, 14),
              "platform": platform.system(), "packages": packages,
              "native_lock": "not-implemented", "environment_manager": "not-implemented"}
    try:
        report["render"] = validate_render(b'<svg xmlns="http://www.w3.org/2000/svg"/>', 2, 2)
    except (CoreError, OSError, ImportError) as exc:
        report["render"] = {"error": {"code": getattr(exc, "code", "missing-dependency" if isinstance(exc, ImportError) else "io-error"), "message": str(exc)[:2000]}}
    report["healthy"] = (report["python_supported"] and all(x["match"] for x in packages.values())
                         and report["render"].get("render") == "passed")
    return report


def main():
    report = diagnose()
    print(json.dumps({"protocol": 1, "kind": "environment", "report": report}, ensure_ascii=True))
    return 0 if report["healthy"] else 1


if __name__ == "__main__":
    raise SystemExit(main())

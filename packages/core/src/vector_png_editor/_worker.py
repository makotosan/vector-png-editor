"""Internal binary renderer worker; public CLI uses JSON."""
import json
import sys
from . import _backend


def main():
    try:
        payload = sys.stdin.buffer.read(_backend.MAX_SVG * 12 + 1001)
        if len(payload) > _backend.MAX_SVG * 12 + 1000:
            raise ValueError("Render request exceeds limit")
        svg, width, height = json.loads(payload)
        _backend.validate_svg(svg)
        if (type(width) is not int or type(height) is not int or min(width, height) < 1
                or max(width, height) > _backend.MAX_SIDE or width * height > _backend.MAX_PIXELS):
            raise ValueError("Viewport exceeds limits")
        sys.stdout.buffer.write(_backend._render_worker(svg, width, height))
        return 0
    except Exception as exc:
        sys.stderr.buffer.write(str(exc).encode("utf-8", errors="replace")[:2000])
        return 1


if __name__ == "__main__":
    raise SystemExit(main())

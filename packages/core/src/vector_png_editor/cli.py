"""Versioned JSON CLI for passive inspect/extract and safe validation."""
import argparse
import json
from pathlib import Path

from . import __version__
from .document import bounded_read, extract_source, inspect_document
from .errors import CoreError, EXIT_CODES
from .rendering import validate_render
from .svg import MAX_SVG, validate_source


class Parser(argparse.ArgumentParser):
    def error(self, message):
        raise CoreError("invalid-arguments", message)


def main(argv=None):
    parser = Parser(description=__doc__)
    parser.add_argument("--version", action="version", version=__version__)
    parser.add_argument("--request-id", help="Opaque caller ID, echoed in the JSON result")
    commands = parser.add_subparsers(dest="command", required=True, parser_class=Parser)
    inspect = commands.add_parser("inspect")
    inspect.add_argument("png", type=Path)
    extract = commands.add_parser("extract")
    extract.add_argument("png", type=Path)
    extract.add_argument("output", type=Path)
    validate = commands.add_parser("validate")
    validate.add_argument("svg", type=Path)
    validate.add_argument("--width", type=int, default=1024)
    validate.add_argument("--height", type=int, default=1024)
    validate.add_argument("--syntax-only", action="store_true", help="Skip rendering; explicitly report render not checked")
    envelope = {"protocol": 1, "command": None, "request_id": None, "ok": False}
    status = 0
    try:
        args = parser.parse_args(argv)
        envelope.update(command=args.command)
        if args.request_id is not None and len(args.request_id) > 128:
            raise CoreError("invalid-arguments", "request-id exceeds 128 characters")
        envelope["request_id"] = args.request_id
        if args.command == "inspect":
            result = inspect_document(args.png)
        elif args.command == "extract":
            result = extract_source(args.png, args.output)
        else:
            source = bounded_read(args.svg, MAX_SVG)
            result = validate_source(source) if args.syntax_only else validate_render(source, args.width, args.height)
        envelope.update(ok=True, result=result)
    except CoreError as exc:
        status = EXIT_CODES[exc.code]
        envelope["error"] = {"code": exc.code, "message": str(exc)[:2000]}
    except OSError as exc:
        status = EXIT_CODES["io-error"]
        envelope["error"] = {"code": "io-error", "message": str(exc)[:2000]}
    print(json.dumps(envelope, ensure_ascii=True, separators=(",", ":")))
    return status

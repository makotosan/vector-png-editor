"""Versioned JSON CLI for passive inspect/extract and safe validation."""
import argparse
import json
import sys
from pathlib import Path

from . import __version__
from .document import bounded_read, extract_source, inspect_document
from .errors import CoreError, EXIT_CODES
from .rendering import validate_render
from .svg import MAX_SVG, validate_source
from .writing import build_document, rebuild_document, verify_document
from .protocol import parse_request


class Parser(argparse.ArgumentParser):
    def error(self, message):
        raise CoreError("invalid-arguments", message)


def main(argv=None):
    parser = Parser(description=__doc__)
    parser.add_argument("--version", action="version", version=__version__)
    parser.add_argument("--request-id", help="Opaque caller ID, echoed in the JSON result")
    parser.add_argument("--request-json", action="store_true", help="Read one bounded protocol-1 request on stdin; use alone")
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
    validate.add_argument("--profile", choices=["safe-svg-v1"], help="Strict schema-profile gate with structured diagnostics (Issue #22)")
    verify = commands.add_parser("verify")
    verify.add_argument("png", type=Path)
    for name, source_arg in (("build", "svg"), ("rebuild", "png")):
        writer = commands.add_parser(name)
        writer.add_argument(source_arg, type=Path)
        writer.add_argument("output", type=Path)
        writer.add_argument("--overwrite", action="store_true")
        writer.add_argument("--expected-sha256")
        if name == "build":
            writer.add_argument("--width", type=int, default=1024)
            writer.add_argument("--height", type=int, default=1024)
    envelope = {"protocol": 1, "command": None, "request_id": None, "ok": False}
    status = 0
    try:
        arguments = sys.argv[1:] if argv is None else argv
        args = parse_request(sys.stdin.buffer) if arguments == ["--request-json"] else parser.parse_args(arguments)
        if getattr(args, "request_json", False):
            raise CoreError("invalid-arguments", "--request-json must be used alone")
        envelope.update(command=args.command)
        if args.request_id is not None and len(args.request_id) > 128:
            raise CoreError("invalid-arguments", "request-id exceeds 128 characters")
        envelope["request_id"] = args.request_id
        if args.command == "inspect":
            result = inspect_document(args.png)
        elif args.command == "extract":
            result = extract_source(args.png, args.output)
        elif args.command == "verify":
            result = verify_document(args.png)
            if result["preview"] == "mismatch":
                raise CoreError("render-mismatch", "Preview differs from this renderer", result)
        elif args.command in {"build", "rebuild"}:
            options = {"overwrite": args.overwrite, "expected_sha256": args.expected_sha256}
            if args.command == "build":
                source = getattr(args, "source", None)
                result = build_document(source if source is not None else bounded_read(args.svg, MAX_SVG), args.output,
                                        args.width, args.height, **options)
            else:
                result = rebuild_document(args.png, args.output, **options)
        else:
            source = getattr(args, "source", None)
            if source is None:
                source = bounded_read(args.svg, MAX_SVG)
            if getattr(args, "profile", None):
                from .profile_check import check_profile
                diagnostics = check_profile(source, strict_structure=True)
                if diagnostics:
                    raise CoreError("unsupported-profile",
                                    f"{len(diagnostics)} safe-svg-v1 diagnostic(s); first: {diagnostics[0]['message']}",
                                    {"diagnostics": diagnostics})
            result = validate_source(source) if args.syntax_only else validate_render(source, args.width, args.height)
        envelope.update(ok=True, result=result)
    except CoreError as exc:
        status = EXIT_CODES[exc.code]
        envelope["error"] = {"code": exc.code, "message": str(exc)[:2000]}
        if exc.details is not None:
            envelope["error"]["details"] = exc.details
    except OSError as exc:
        status = EXIT_CODES["io-error"]
        envelope["error"] = {"code": "io-error", "message": str(exc)[:2000]}
    except KeyboardInterrupt:
        status = EXIT_CODES["cancelled"]
        envelope["error"] = {"code": "cancelled", "message": "Operation interrupted"}
    print(json.dumps(envelope, ensure_ascii=True, separators=(",", ":")))
    return status

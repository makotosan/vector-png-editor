"""Strict, bounded one-request JSON transport; no shell command interpolation."""
import argparse
import base64
import binascii
import json
from pathlib import Path

from .errors import CoreError
from .svg import MAX_SVG

MAX_REQUEST = 2_000_000
COMMANDS = {"inspect", "extract", "validate", "build", "verify", "rebuild"}


def _unique(pairs):
    value = {}
    for key, item in pairs:
        if key in value:
            raise ValueError("Duplicate JSON property")
        value[key] = item
    return value


def parse_request(stream):
    raw = stream.read(MAX_REQUEST + 1)
    if len(raw) > MAX_REQUEST:
        raise CoreError("resource-limit", "JSON request exceeds 2,000,000 bytes")
    try:
        request = json.loads(raw.decode("utf-8"), object_pairs_hook=_unique,
                             parse_constant=lambda value: (_ for _ in ()).throw(ValueError("Non-finite JSON number")))
    except (ValueError, UnicodeError, RecursionError) as exc:
        raise CoreError("invalid-arguments", "Request must be one strict UTF-8 JSON object") from exc
    if type(request) is not dict:
        raise CoreError("invalid-arguments", "Request must be an object")
    try:
        for value in request.values():
            if isinstance(value, str):
                value.encode("utf-8", errors="strict")
    except UnicodeError as exc:
        raise CoreError("invalid-arguments", "JSON strings must contain Unicode scalar values") from exc
    command = request.get("command")
    if type(command) is not str or command not in COMMANDS:
        raise CoreError("invalid-arguments", "Unsupported request command")
    allowed = {"protocol", "command", "request_id", "input"}
    if command in {"extract", "build", "rebuild"}:
        allowed.add("output")
    if command in {"validate", "build"}:
        allowed |= {"source_base64", "width", "height"}
    if command == "validate":
        allowed.add("syntax_only")
    if command in {"build", "rebuild"}:
        allowed |= {"overwrite", "expected_sha256"}
    if set(request) - allowed or type(request.get("protocol")) is not int or request["protocol"] != 1:
        raise CoreError("invalid-arguments", "Unknown properties or unsupported protocol")
    if type(request.get("request_id")) is not str or not 1 <= len(request["request_id"]) <= 128:
        raise CoreError("invalid-arguments", "request_id must contain 1 through 128 characters")
    source = None
    if "source_base64" in request:
        encoded = request["source_base64"]
        if "input" in request or type(encoded) is not str or len(encoded) > 1_333_336:
            raise CoreError("invalid-arguments", "Supply exactly one source input")
        try:
            source = base64.b64decode(encoded, validate=True)
            if base64.b64encode(source).decode("ascii") != encoded:
                raise ValueError("Non-canonical base64")
        except (ValueError, binascii.Error) as exc:
            raise CoreError("invalid-arguments", "Invalid source_base64") from exc
        if len(source) > MAX_SVG:
            raise CoreError("resource-limit", "SVG exceeds byte limit")
    for key in ("input", "output"):
        if key in request and (type(request[key]) is not str or not 1 <= len(request[key]) <= 32768
                               or "\0" in request[key]):
            raise CoreError("invalid-arguments", "Invalid path")
    if source is None and "input" not in request:
        raise CoreError("invalid-arguments", "Missing input")
    if command in {"extract", "build", "rebuild"} and "output" not in request:
        raise CoreError("invalid-arguments", "Missing output")
    width, height = request.get("width", 1024), request.get("height", 1024)
    if type(width) is not int or type(height) is not int or not 1 <= width <= 4096 or not 1 <= height <= 4096 or width * height > 4_000_000:
        raise CoreError("invalid-arguments", "Invalid request viewport")
    for key in ("syntax_only", "overwrite"):
        if key in request and type(request[key]) is not bool:
            raise CoreError("invalid-arguments", "Options must be JSON booleans")
    token = request.get("expected_sha256")
    if "expected_sha256" in request and (type(token) is not str or len(token) != 64
                                        or any(c not in "0123456789abcdef" for c in token)):
        raise CoreError("invalid-arguments", "Invalid revision token")
    if command in {"build", "rebuild"} and request.get("overwrite", False) != (token is not None):
        raise CoreError("invalid-arguments", "Overwrite requires a revision token")
    path = Path(request["input"]) if "input" in request else None
    return argparse.Namespace(command=command, request_id=request["request_id"], source=source,
        png=path, svg=path, output=Path(request["output"]) if "output" in request else None,
        width=width, height=height, syntax_only=request.get("syntax_only", False),
        overwrite=request.get("overwrite", False), expected_sha256=token)

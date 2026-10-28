"""Release version agreement check (Issue #20).

The Core package version in packages/core/pyproject.toml is canonical.
The runtime __version__ and the extension's package.json version must
spell the same version (npm uses '-' where PEP 440 uses '.' in the
prerelease segment). With --tag vX.Y.Z, the tag must agree too - a
release is only ever cut from a matching tag.

Usage: python tools/check_versions.py [--tag v0.1.0.dev3]
Exit code 0 when everything agrees, 1 with the mismatches listed.
"""
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def pep440_to_npm(version: str) -> str:
    match = re.fullmatch(r"(\d+\.\d+\.\d+)(?:\.(dev|a|b|rc)(\d+))?", version)
    if not match:
        raise ValueError(f"unsupported version form: {version}")
    base, kind, number = match.groups()
    if kind is None:
        return base
    label = {"dev": "dev", "a": "alpha", "b": "beta", "rc": "rc"}[kind]
    return f"{base}-{label}{number}"


def main(argv: list[str]) -> int:
    tag = None
    if argv[:1] == ["--tag"]:
        tag = argv[1].removeprefix("v")
    pyproject = (ROOT / "packages" / "core" / "pyproject.toml").read_text(encoding="utf-8")
    canonical = re.search(r'^version = "([^"]+)"', pyproject, re.M).group(1)
    init = (ROOT / "packages" / "core" / "src" / "vector_png_editor" / "__init__.py").read_text(encoding="utf-8")
    runtime = re.search(r'^__version__ = "([^"]+)"', init, re.M).group(1)
    extension = json.loads((ROOT / "packages" / "extension" / "package.json").read_text(encoding="utf-8"))["version"]
    problems = []
    if runtime != canonical:
        problems.append(f"__version__ {runtime} != pyproject {canonical}")
    try:
        expected_npm = pep440_to_npm(canonical)
    except ValueError as error:
        problems.append(str(error))
        expected_npm = None
    if expected_npm is not None and extension != expected_npm:
        problems.append(f"extension version {extension} != npm spelling of {canonical} ({expected_npm})")
    if tag is not None and tag != canonical:
        problems.append(f"tag version {tag} != pyproject {canonical}")
    if problems:
        for problem in problems:
            print(f"version mismatch: {problem}")
        return 1
    print(f"versions agree: core {canonical}, extension {extension}" + (f", tag v{tag}" if tag else ""))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))

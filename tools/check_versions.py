"""Release version agreement check (Issue #20).

The extension's package.json version is canonical: it is the
version of the only release artifact (the VSIX). With --tag
vX.Y.Z, the tag must agree too - a release is only ever cut from
a matching tag. Tags and the package version both use the npm
spelling (0.1.0-dev3).

Usage: python tools/check_versions.py [--tag v0.1.0-dev3]
Exit code 0 when everything agrees, 1 with the mismatches listed.
"""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def main(argv: list[str]) -> int:
    tag = None
    if argv[:1] == ["--tag"]:
        tag = argv[1].removeprefix("v")
    extension = json.loads((ROOT / "packages" / "extension" / "package.json").read_text(encoding="utf-8"))["version"]
    problems = []
    if tag is not None and tag != extension:
        problems.append(f"tag version {tag} != extension {extension}")
    if problems:
        for problem in problems:
            print(f"version mismatch: {problem}")
        return 1
    print(f"versions agree: extension {extension}" + (f", tag v{tag}" if tag else ""))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))

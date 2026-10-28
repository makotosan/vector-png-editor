#!/usr/bin/env python3
"""Generate the safe-svg-v1 schema artifacts from the policy (Issue #22).

schemas/safe-svg-v1.policy.yaml is the single normative data source.
This script derives, deterministically:
  schemas/safe-svg-v1.rng          Relax NG (XML syntax) structure schema
  schemas/safe-svg-v1.rules.md     generation rules for AI callers
  schemas/safe-svg-v1.monaco.json  completion/diagnostic metadata
  schemas/safe-svg-v1.manifest.json profile version + artifact hashes

Usage: generate_safe_svg_schemas.py [--check]
  Without flags it rewrites the artifacts. --check exits non-zero if
  the committed artifacts differ from a fresh generation.
The policy file uses a deliberately small YAML subset (block maps,
block lists of scalars, plain or single-quoted scalars); the parser
below accepts exactly that subset and rejects anything else.
"""
import hashlib
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCHEMAS = ROOT / "schemas"
POLICY = SCHEMAS / "safe-svg-v1.policy.yaml"


def parse_policy(text: str) -> dict:
    root: dict = {}
    stack: list[tuple[int, object]] = [(-1, root)]
    lines = text.splitlines()
    i = 0
    while i < len(lines):
        raw = lines[i]
        i += 1
        if not raw.strip() or raw.lstrip().startswith("#"):
            continue
        indent = len(raw) - len(raw.lstrip(" "))
        line = raw.strip()
        while stack and indent <= stack[-1][0]:
            stack.pop()
        parent = stack[-1][1]
        if line.startswith("- "):
            if not isinstance(parent, list):
                raise ValueError(f"list item outside a list: {raw!r}")
            parent.append(_scalar(line[2:].strip()))
            continue
        match = re.fullmatch(r"([A-Za-z0-9_-]+):(?:\s+(.*))?", line)
        if not match:
            raise ValueError(f"unsupported policy line: {raw!r}")
        key, value = match.group(1), match.group(2)
        if not isinstance(parent, dict):
            raise ValueError(f"mapping entry outside a mapping: {raw!r}")
        if value is not None:
            parent[key] = _scalar(value.strip())
        else:
            # A key with no value opens a list or a nested map; decide
            # by peeking at the next significant line.
            nxt = next((l for l in lines[i:] if l.strip() and not l.lstrip().startswith("#")), "")
            child: object = [] if nxt.strip().startswith("- ") else {}
            parent[key] = child
            stack.append((indent, child))
    return root


def _scalar(value: str):
    if len(value) >= 2 and value[0] == "'" and value[-1] == "'":
        return value[1:-1].replace("''", "'")
    if re.fullmatch(r"-?\d+", value):
        return int(value)
    return value


def _children(policy: dict, element: str) -> list[str]:
    model = policy["content_models"][element]
    if model == "none":
        return []
    return [name.strip() for name in model.split(",")]


def generate_rng(policy: dict) -> str:
    attrs = []
    for name in policy["attributes"]:
        if name == "id":
            value = ('<data type="string" datatypeLibrary="http://www.w3.org/2001/XMLSchema-datatypes">'
                     f'<param name="pattern">{policy["id_pattern"].replace("-", "\\-")}</param></data>')
        else:
            value = "<text/>"
        attrs.append(f'      <optional><attribute name="{name}">{value}</attribute></optional>')
    attr_block = "\n".join(attrs)
    defines = []
    for element in policy["elements"]:
        children = _children(policy, element)
        if children:
            refs = "".join(f'<ref name="el.{name}"/>' for name in children)
            content = f'<zeroOrMore><choice>{refs}</choice></zeroOrMore>'
        else:
            content = "<empty/>"
        if element in policy["text_elements"]:
            content = f"<mixed>{content}</mixed>" if children else "<text/>"
        defines.append(
            f'  <define name="el.{element}">\n    <element name="{element}">\n{attr_block}\n'
            f"      {content}\n    </element>\n  </define>")
    body = "\n".join(defines)
    return (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        "<!-- Generated from schemas/safe-svg-v1.policy.yaml by tools/generate_safe_svg_schemas.py. Do not edit by hand. -->\n"
        '<grammar xmlns="http://relaxng.org/ns/structure/1.0" ns="http://www.w3.org/2000/svg">\n'
        '  <start><ref name="el.svg"/></start>\n'
        f"{body}\n</grammar>\n")


def generate_rules(policy: dict) -> str:
    elements = ", ".join(f"`{e}`" for e in policy["elements"])
    attributes = ", ".join(f"`{a}`" for a in policy["attributes"])
    models = "\n".join(
        f"- `{e}` may contain: {', '.join(_children(policy, e)) or 'no child elements'}"
        for e in policy["elements"])
    return f"""# safe-svg-v1 generation rules for AI callers

Generated from `schemas/safe-svg-v1.policy.yaml` by
`tools/generate_safe_svg_schemas.py`. Do not edit by hand. These rules
constrain direct SVG XML generation (Issue #22, method A): generate
only what is listed here, then validate before any file is written.

## Hard rules

- Root is one `<svg>` in the SVG namespace (`{policy['namespace']}`).
  The document is UTF-8, at most {policy['max_bytes']} bytes,
  {policy['max_elements']} elements, depth {policy['max_depth']}.
- Allowed elements only: {elements}.
- Allowed attributes only: {attributes}.
  Unknown elements, attributes (including `class` and `style`), or
  values are rejected, never silently dropped.
- No DTD, entities, processing instructions, scripts, event-handler
  attributes, hyperlinks, images, `use`, `foreignObject`, animation,
  CSS, or external resources of any kind.
- Attribute values must not contain any of
  `{policy['forbidden_value_characters']}` or control characters
  other than tab/newline/carriage return, and are at most
  {policy['max_attribute_length']} code points.
- `id` values match `{policy['id_pattern']}` and are unique.
- The only URL form is `url(#id)`, and only on `fill`, `stroke`
  (target: a local `linearGradient` or `radialGradient`) and
  `clip-path` (target: a local `clipPath`). No references inside
  gradient or clipPath definitions.
- Numbers, colors, path data and transforms are checked by the
  bounded renderer at build time; keep them simple and finite.

## Structure (content models)

{models}

## Workflow

1. Generate the SVG XML directly; no JSON intermediate form.
2. Validate: `vector-png-editor validate <file.svg> --profile safe-svg-v1`
   and fix every diagnostic (severity/code/element/attribute/line/
   column/message/suggestion) before proceeding.
3. Only after validation passes, build or overwrite the PNG through
   the revision-checked CLI workflow (docs/CODEX.md). A failing SVG
   must never overwrite an existing vector-png.
"""


def generate_monaco(policy: dict) -> str:
    data = {
        "profile": policy["profile"],
        "version": policy["profile_version"],
        "namespace": policy["namespace"],
        "limits": {
            "maxBytes": policy["max_bytes"],
            "maxElements": policy["max_elements"],
            "maxDepth": policy["max_depth"],
            "maxAttributeLength": policy["max_attribute_length"],
        },
        "idPattern": policy["id_pattern"],
        "attributes": list(policy["attributes"]),
        "elements": [
            {
                "name": element,
                "attributes": list(policy["attributes"]),
                "children": _children(policy, element),
                "textContent": element in policy["text_elements"],
            }
            for element in policy["elements"]
        ],
    }
    return json.dumps(data, indent=2, ensure_ascii=False) + "\n"


def build_artifacts(policy: dict) -> dict[str, str]:
    return {
        "safe-svg-v1.rng": generate_rng(policy),
        "safe-svg-v1.rules.md": generate_rules(policy),
        "safe-svg-v1.monaco.json": generate_monaco(policy),
    }


def manifest(policy: dict, artifacts: dict[str, str]) -> str:
    data = {
        "profile": policy["profile"],
        "profileVersion": policy["profile_version"],
        "spec": {
            "repository": policy["spec_repository"],
            "revision": policy["spec_revision"],
            "document": policy["spec_document"],
        },
        "policy": {
            "file": "safe-svg-v1.policy.yaml",
            "sha256": hashlib.sha256(POLICY.read_bytes()).hexdigest(),
        },
        "artifacts": {
            name: hashlib.sha256(text.encode("utf-8")).hexdigest()
            for name, text in sorted(artifacts.items())
        },
        "generator": "tools/generate_safe_svg_schemas.py",
    }
    return json.dumps(data, indent=2, ensure_ascii=False) + "\n"


def main() -> int:
    policy = parse_policy(POLICY.read_text(encoding="utf-8"))
    artifacts = build_artifacts(policy)
    artifacts["safe-svg-v1.manifest.json"] = manifest(policy, artifacts)
    check = "--check" in sys.argv
    drift = []
    for name, text in sorted(artifacts.items()):
        path = SCHEMAS / name
        if check:
            if not path.exists() or path.read_text(encoding="utf-8") != text:
                drift.append(name)
        else:
            path.write_text(text, encoding="utf-8")
            print(f"wrote schemas/{name}")
    if drift:
        print("drift detected:", ", ".join(drift), file=sys.stderr)
        return 1
    if check:
        print("schema artifacts are current")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

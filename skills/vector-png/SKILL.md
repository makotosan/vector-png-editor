---
name: vector-png
description: Generate or edit vector-png artwork by writing safe-svg-v1 SVG XML directly, validating it with the vector-png-editor CLI, and building the PNG only after validation passes. Use when creating a vector-png file, converting a drawing request into a vector-png, or modifying the SVG source of an existing vector-png.
---

# Vector PNG generation (safe-svg-v1)

The safe-svg-v1 profile is a strict allowlist: anything not listed is
rejected. Generate SVG XML directly - there is no JSON intermediate
form - and never write a PNG from unvalidated source.

## Procedure

1. **Read the generation rules first.** Open
   `schemas/safe-svg-v1.rules.md` (generated from
   `schemas/safe-svg-v1.policy.yaml`). It lists the allowed elements,
   attributes, value rules, reference rules and content models for the
   profile version in `schemas/safe-svg-v1.manifest.json`. Do not rely
   on memory of full SVG: common constructs such as `class`, `style`,
   `href`, event handlers, external references and most elements are
   NOT in the profile.
2. **Write the SVG XML** to a working file (for example `artwork.svg`):
   one `<svg>` root in the SVG namespace, only allowed elements and
   attributes, `url(#id)` references only to local gradients/clipPaths,
   children only where the content models allow them.
3. **Validate before building**:
   `vector-png-editor validate artwork.svg --profile safe-svg-v1`
   The command prints one JSON envelope. On failure (`ok: false`,
   exit code 5) read `error.details.diagnostics`: every entry gives
   severity, code, element, attribute, line, column, message and a
   suggestion. Fix the SVG - not the PNG - and re-validate until it
   passes. Do not proceed on warnings-as-errors or partial success.
4. **Build the PNG** (see docs/CODEX.md for the full CLI contract):
   - New file: `vector-png-editor build artwork.svg out.png --width <w> --height <h>`
   - Replacing an existing vector-png: first run
     `vector-png-editor inspect out.png`, take `png_sha256`, and build
     with `--overwrite --expected-sha256 <png_sha256>`. A conflict
     (exit code 13) means the file changed since inspection: re-inspect
     and re-decide; never retry blindly and never overwrite without a
     fresh revision.
5. **Verify**: `vector-png-editor verify out.png` must report `ok`.
   Only then is the task complete.

## Failure rules

- A non-conforming SVG never overwrites an existing vector-png: if
  validation fails, stop, report the diagnostics, and leave any
  existing PNG untouched.
- Validation is profile-exact, not full-SVG: numeric, color, path-data
  and transform syntax are checked by the renderer at build time, so a
  build failure after a passing validation is reported, not worked
  around by editing the PNG.
- Do not reformat or normalize the SVG automatically; preserve the
  source text as generated except for the fixes a diagnostic requires.

## ChatGPT (no CLI available)

Apply the same rules file as the generation contract: generate only
profile-listed constructs, then have the SVG validated with
`vector-png-editor validate --profile safe-svg-v1` in an environment
that has the CLI before any PNG is built from it. There is no separate
ChatGPT-specific rule set.

# safe-svg-v1: implementation correspondence and the v1.2 schema layer

[日本語](SAFE_SVG_V1.ja.md)

## Phase 0 — what the profile actually is (investigated 2026-10-28)

The normative profile is `profiles/safe-svg-v1.md` in
makotosan/vector-png-spec, pinned at revision
12994c57121b759c835ee28cd25b88c12f67463c (draft 0.1). The spec states
it "describes the initial Python implementation's feature subset";
the Core implementation (`packages/core/src/vector_png_editor/svg.py`
and `_backend.py`, adapted from makotosan/vector-png@d00dd88) matches
it point for point, verified by direct comparison:

| Area | Spec and Core agree |
| --- | --- |
| Elements | 18 SVG-namespace elements (svg, g, defs, title, desc, path, rect, circle, ellipse, line, polyline, polygon, text, tspan, linearGradient, radialGradient, stop, clipPath); anything else rejected |
| Attributes | 52 unqualified attributes (the pinned profile's 52, including `letter-spacing` per the G1 amendment below); unknown or namespace-qualified attributes rejected (so `class`, `style`, `href`, event handlers are all out) |
| Values | No backslash, @, braces, semicolon, angle brackets, NUL or controls other than TAB/LF/CR in any attribute value; max 100,000 code points per value |
| References | Only `url(#ID)`; on fill/stroke targeting a local gradient, on clip-path targeting a local clipPath; ids match `[A-Za-z_][A-Za-z0-9_.-]*` and are unique; no references inside resource definitions |
| Structure | UTF-8 only; no DTD/entities/processing instructions; comments and an optional UTF-8 XML declaration allowed; root is `svg` in the SVG namespace |
| Limits | 1,000,000 source bytes, 5,000 elements, depth 32 |
| Numbers, colors, path data, transforms, fonts | **Not** validated by the allowlist: the spec assigns them to the bounded renderer ("Validate numeric/path syntax through a bounded renderer"). CairoSVG accepts or rejects at render time; font selection is host-dependent |
| Parent-child relations | The spec defines **none**, and the Core enforces none |

Differences and risks recorded: (1) the allowlist surface matches the
pinned profile, including the G1 amendment (`letter-spacing`, below) - the remaining risk is *drift*, which the
policy parity test now guards; (2) a file can pass profile
validation yet fail rendering (bad numbers/path data), which is why
`validate` without `--syntax-only` also renders; (3) CLI naming: this
product's shipped command is `vector-png-editor validate <file.svg>`
(one JSON envelope per call, see docs/CODEX.md), so the v1.2 form
`validate --profile safe-svg-v1 --json` is realized as
`vector-png-editor validate <file.svg> --profile safe-svg-v1` on the
existing CLI - JSON is unconditional there, and renaming the shipped
binary would break the documented workflow for no functional gain.

## Phase 1 — the schema layer

`schemas/safe-svg-v1.policy.yaml` is the single machine-readable
normative data. `tools/generate_safe_svg_schemas.py` derives from it:

- `schemas/safe-svg-v1.rng` - Relax NG structure schema (elements,
  attribute names, the id pattern, content models below).
- `schemas/safe-svg-v1.rules.md` - generation rules for AI callers.
- `schemas/safe-svg-v1.monaco.json` - completion/diagnostic metadata.
- `schemas/safe-svg-v1.manifest.json` - profile version and the
  SHA-256 of the policy and every generated artifact.

A Core test fails on any drift between the policy, the generated
artifacts, and the implementation's own allowlists.

**Two layers, deliberately.** Core acceptance (build/save) stays
exactly the spec profile above, so every existing valid file keeps
working (SC-12). The schema layer adds *content models* - which
elements may appear inside which (for example, `stop` only inside
gradients) - as an authoring constraint for generation. The new
diagnostics validator (`profile_check.py`) reports every violation
with severity/code/element/attribute/line/column/message/suggestion:
in compat mode its verdicts equal the Core's; with
`validate --profile safe-svg-v1` the content models are enforced too,
so AI-generated SVG is held to the stricter structure before any PNG
is written. A failing validation never touches an existing PNG; the
write path remains the revision-checked atomic build (P1-03/P2-04).

## Amendment - `letter-spacing` (G1)

makotosan/vector-png-spec#3 (amendment G1) added `letter-spacing` to
safe-svg-v1 as a presentation attribute. The editor implemented it
ahead of the specification (PR #51) while the amendment was being
drafted; the amendment has since merged upstream (specification
PR #4) and the pin in spec-reference.json now points at the merged
revision, so the Core allowlist, the policy and the generated
artifacts and the pinned profile text agree on the same 52
attributes and the temporary divergence is closed. Every other
allowlist verdict is unchanged, and the parity tests guard the
52-attribute surface. docs/SPEC_COMPATIBILITY.md records the change
and its evidence.

## Status against Issue #22

Phase 0 and Phase 1 are implemented, with SC-01 to SC-09, SC-11 and
SC-12 exercised in `packages/core/tests/test_safe_svg_schema.py`.
Phase 2 is implemented as well: `skills/vector-png/SKILL.md` carries
the generation procedure (read the rules, generate XML directly,
validate, fix and re-validate, build with the inspected revision,
verify), and the editor's Monaco completion now consumes the
generated metadata - the host loads `safe-svg-v1.monaco.json`
(packaged under `media/schemas`, or the repo `schemas/` in a
checkout) and completion inside an element is limited to that
element's allowed children. SC-10 runs end to end in
`tests/integration/test_skill_workflow.py`, including the rule that a
non-conforming SVG never overwrites an existing PNG. What remains
for Issue #22 is only the Phase 3 cross-platform confirmation of the
full SC matrix in CI (the Core matrix already exercises the schema
tests on all three OSes).

# Provenance

These fixtures are vendored verbatim from the specification repository
**makotosan/vector-png-spec**, directory `fixtures/normalization/`, at the
pinned revision recorded in the repository-root `spec-reference.json`
(`8238ebdaa136f448affa53133b99ee5afde5765a`, the revision whose HEAD commit is
"Specify safe SVG normalization for CSS-styled diagrams (#2)").

They are original synthetic test data published with the
svg-normalization-v1 profile (`profiles/svg-normalization-v1.md`); no user
content is included. The spec repository's fixture `README.md` /
`README.ja.md` were deliberately not vendored: their relative links target
the spec repository's own layout and would dangle here (this repository's
documentation link checker rejects them). Read them in the spec repository
at the pinned revision instead.
`nameplate.expected.svg` and `nameplate.expected-report.json` are the spec
repository's reviewed golden structural results: the expected report is an
analysis-only result (status `failure`, render `not-checked`, no output
digest) by design — the production normalizer in
`packages/core/src/vector_png_editor/normalize.py` must reproduce its
structural output and its analysis-determined report fields exactly, and
additionally pass the rendering gate before reporting success.

Vendored for Issue #48. Do not edit these files to make a test pass; a
mismatch is a finding about the implementation or about the pinned spec.

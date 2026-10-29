# Provenance

These fixtures are vendored verbatim from the specification repository
**makotosan/vector-png-spec**, directory `fixtures/normalization/`, at the
pinned revision recorded in the repository-root `spec-reference.json`
(`12994c57121b759c835ee28cd25b88c12f67463c`, the merge of the
specification amendments for Issue #3 of that repository — spec PR #4:
`letter-spacing`, curved marker hosts, and the font-family
clarification; the catalog at this revision has 27 cases, and its
`unsupported-marker-host` case uses a degenerate curve).

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
`packages/ts-core/src/normalize.ts` (the TypeScript port; the Python
original was retired with the Phase 3 migration, Issue #60) must reproduce
its structural output and its analysis-determined report fields exactly,
and additionally pass the rendering gate before reporting success.

Vendored for Issue #48. Do not edit these files to make a test pass; a
mismatch is a finding about the implementation or about the pinned spec.

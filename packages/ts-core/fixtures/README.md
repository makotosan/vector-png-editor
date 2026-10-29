# Pinned vector-png fixtures

vectors.json is an exact copy of fixtures/vectors.json from makotosan/vector-png-spec at 8238ebdaa136f448affa53133b99ee5afde5765a, MIT. See ../../THIRD_PARTY_NOTICES.md and ../../LICENSE.

The catalog's container_valid property concerns vector-png containers, not safe-svg-v1 or preview equality. missing-source is a valid ordinary PNG handled by the editor fallback, not a malformed PNG. unsafe-svg and different-preview remain passively discoverable/extractable without rendering. Production tests additionally cover profile rejection, exact source bytes and rendering separately.

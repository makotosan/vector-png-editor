# Release process

[日本語](RELEASE.ja.md)

## Versioning

One version per release, spelled per ecosystem. The canonical value
is `version` in `packages/core/pyproject.toml`; the runtime
`__version__` must equal it, and the extension's `package.json` must
carry the same version in npm spelling (`0.1.0.dev3` in Python is
`0.1.0-dev3` in npm). `python tools/check_versions.py` verifies the
agreement, and `--tag v<version>` additionally verifies a release
tag. Current version: 0.1.0.dev3 in both packages.

## Cutting a release

1. Confirm the acceptance gate below, set the version in the three
   places, and merge to main through the usual protected PR flow.
2. Tag the merge commit `v<version>` and push the tag. The release
   workflow (appendix) runs on the tag.
3. The workflow verifies versions, tests and builds the Core
   wheel/sdist, clean-installs the wheel into a fresh venv and
   smoke-tests the CLI, tests and packages the extension VSIX
   (bundled host code, Monaco assets and the generated profile
   metadata), and creates a GitHub Release with the wheel, sdist,
   VSIX, `THIRD_PARTY_NOTICES.md` and `SHA256SUMS.txt`.

## The acceptance gate (no stable before real-machine acceptance)

Tags with a prerelease component (`dev`, `a`, `b`, `rc`) publish a
GitHub **prerelease**. A stable tag (plain `vX.Y.Z`) may only be cut
after the real-machine acceptance in Issue #18 is complete and
recorded; the v1.0 handoff is not final until then. Cutting a stable
tag earlier is a process error, not a shortcut.

## pip distribution

The GitHub Release is the default distribution channel. Publishing
to PyPI is optional and configuration-gated: it runs only when the
repository variable `PYPI_PUBLISH_ENABLED` is `true` and a PyPI
trusted publisher is configured for this workflow. When it is not
configured, the workflow still succeeds and the GitHub Release is
the complete distribution. When it is enabled and publishing fails,
the workflow run fails visibly on the run and the tag - failures are
reported, never swallowed.

## Failure recovery

- A failed run publishes nothing partial that cannot be repeated:
  fix the cause, delete the tag and any draft/partial release,
  re-tag the corrected commit, and push again.
- A published GitHub prerelease with bad artifacts is deleted and
  re-cut under a new prerelease number; versions are never reused.
- A bad PyPI upload cannot be replaced under the same version
  (PyPI forbids it): yank the release on PyPI and publish a new
  version.

## Dry-run rehearsal (2026-10-28)

Every workflow step was executed locally before this runbook was
written: version check against `v0.1.0.dev3`; wheel and sdist built;
the wheel clean-installed into a fresh venv and the CLI validated,
built and verified a sample; the VSIX packaged
(`vector-png-editor-0.1.0-dev3.vsix`, 161 files) with the bundled
host, Monaco assets, generated profile metadata and the requirements
lock inside; `SHA256SUMS.txt` generated. The rehearsal found and
fixed a real gap: the extension declared `out/extension.js` as its
entry point but nothing emitted it, and the bridge sources live
outside the extension folder - the host is now bundled with esbuild
(`scripts/bundle-extension.mjs`, run by `vscode:prepublish`), and a
`.vscodeignore` keeps sources, tests and node_modules out of the
VSIX. Tag-triggered execution itself is rehearsed by the first real
prerelease tag.

## Appendix: `.github/workflows/release.yml`

The GitHub App used for day-to-day pushes cannot write workflow
files, so this file is added by the repository owner through the
GitHub web UI (the same route as `extension.yml`). Its content is
normative and identical in both language versions of this document:

```yaml
name: Release

# Cut a release by pushing a version tag, e.g. v0.1.0.dev3.
# The tag must agree with packages/core/pyproject.toml (checked by
# tools/check_versions.py). Prerelease tags (dev/a/b/rc) publish a
# GitHub prerelease and are never marked stable; a stable tag may
# only be cut after the real-machine acceptance (Issue #18) is done.
on:
  push:
    tags:
      - "v*"

permissions:
  contents: write # create the GitHub Release
  id-token: write # PyPI trusted publishing, only when enabled below

jobs:
  release:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with:
          python-version: "3.13"
      - uses: actions/setup-node@v4
        with:
          node-version: "24"

      - name: Verify tag and package versions agree
        run: python tools/check_versions.py --tag "$GITHUB_REF_NAME"

      - name: Test and build the Core wheel and sdist
        run: |
          python -m pip install --upgrade pip build
          python -m pip install './packages/core[test]'
          python -m pytest packages/core/tests -q
          python -m build packages/core --outdir dist

      - name: Clean-install the built wheel and smoke-test the CLI
        run: |
          python -m venv /tmp/clean-install
          /tmp/clean-install/bin/python -m pip install dist/*.whl
          cd /tmp
          /tmp/clean-install/bin/vector-png-editor --help > /dev/null
          printf '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="#333"/></svg>' > smoke.svg
          /tmp/clean-install/bin/vector-png-editor validate smoke.svg --profile safe-svg-v1 --syntax-only

      - name: Test and package the extension VSIX
        working-directory: packages/extension
        run: |
          npm install
          npm run check
          npm test
          npm run bundle:monaco
          npm run bundle:schemas
          npm run bundle:extension
          npx --yes @vscode/vsce package --out ../../dist/

      - name: Collect release assets with notices and checksums
        run: |
          cp THIRD_PARTY_NOTICES.md dist/
          mkdir dist-pypi
          cp dist/*.whl dist/*.tar.gz dist-pypi/
          cd dist
          sha256sum *.whl *.tar.gz *.vsix THIRD_PARTY_NOTICES.md > SHA256SUMS.txt

      - name: Create the GitHub Release
        env:
          GH_TOKEN: ${{ github.token }}
        run: |
          PRERELEASE=""
          case "$GITHUB_REF_NAME" in
            *.dev*|*a[0-9]*|*b[0-9]*|*rc[0-9]*) PRERELEASE="--prerelease" ;;
          esac
          gh release create "$GITHUB_REF_NAME" dist/*.whl dist/*.tar.gz dist/*.vsix dist/SHA256SUMS.txt dist/THIRD_PARTY_NOTICES.md \
            --title "vector-png-editor $GITHUB_REF_NAME" \
            --generate-notes $PRERELEASE

      # Optional: publish the wheel/sdist to PyPI via trusted
      # publishing. Enable by setting the repository variable
      # PYPI_PUBLISH_ENABLED=true and configuring the trusted
      # publisher on PyPI. When disabled, the GitHub Release above is
      # the complete distribution and this step is skipped (the run
      # summary says so). When enabled and publishing fails, the job
      # fails and the failure is visible on the run and the tag.
      - name: Publish to PyPI (only when configured)
        if: vars.PYPI_PUBLISH_ENABLED == 'true'
        uses: pypa/gh-action-pypi-publish@release/v1
        with:
          packages-dir: dist-pypi
          skip-existing: false
```

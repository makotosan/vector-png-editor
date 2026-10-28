# リリース手順

[English](RELEASE.md)

## 版数管理

リリースごとに版数は1つで、生態系ごとに表記します。正本は `packages/core/pyproject.toml` の `version` です。実行時の `__version__` はそれと一致しなければならず、拡張の `package.json` は同じ版数をnpm表記で保持しなければなりません（Pythonの `0.1.0.dev3` はnpmでは `0.1.0-dev3`）。`python tools/check_versions.py` が一致を検証し、`--tag v<版数>` ではリリースタグとの一致も検証します。現在の版数は両パッケージとも0.1.0.dev3です。

## リリースの切り方

1. 下記の受入ゲートを確認し、3か所の版数を設定して、通常の保護されたPRフローでmainへマージします。
2. マージコミットに `v<版数>` のタグを付け、タグをプッシュします。リリースワークフロー（付録）がタグで起動します。
3. ワークフローは版数を検証し、Coreのwheel／sdistをテスト・ビルドし、wheelを新しいvenvへクリーン導入してCLIのスモークテストを行い、拡張VSIXをテスト・パッケージし（バンドルされたホストコード、Monacoアセット、生成プロファイルメタデータを含む）、wheel、sdist、VSIX、`THIRD_PARTY_NOTICES.md`、`SHA256SUMS.txt` とともにGitHub Releaseを作成します。

## 受入ゲート（実機受入前に安定版なし）

プレリリース要素（`dev`、`a`、`b`、`rc`）を持つタグは、GitHubの **プレリリース** として公開されます。安定版タグ（素の `vX.Y.Z`）は、Issue #18の実機受入が完了し記録された後にのみ切ることができます。v1.0の引き継ぎはそれまで確定しません。安定版タグを早く切ることは近道ではなく手順の誤りです。

## pip配布

GitHub Releaseが既定の配布経路です。PyPIへの公開は任意で、設定によるゲートがあります。リポジトリ変数 `PYPI_PUBLISH_ENABLED` が `true` で、このワークフロー向けのPyPI信頼済みパブリッシャーが設定されている場合にのみ実行されます。設定されていない場合もワークフローは成功し、GitHub Releaseが完全な配布となります。有効化されていて公開に失敗した場合、ワークフローの実行はその実行とタグ上で目に見える形で失敗します。失敗は報告され、決して握りつぶされません。

## 失敗からの復旧

- 失敗した実行は、繰り返し実行できない部分的な公開をしません。原因を直し、タグと下書き・部分的なリリースを削除し、修正したコミットにタグを付け直して再プッシュします。
- 成果物に問題のある公開済みGitHubプレリリースは削除し、新しいプレリリース番号で切り直します。版数は再利用しません。
- 問題のあるPyPIアップロードは同じ版数では差し替えできません（PyPIが禁止しています）。PyPIでそのリリースをyankし、新しい版数を公開します。

## dry-run予行（2026-10-28）

この手順書を書く前に、ワークフローの全ステップをローカルで実行しました。`v0.1.0.dev3` に対する版数確認、wheelとsdistのビルド、wheelの新しいvenvへのクリーン導入とCLIによるサンプルの検証・build・verify、VSIXのパッケージ（`vector-png-editor-0.1.0-dev3.vsix`、161ファイル。バンドルされたホスト、Monacoアセット、生成プロファイルメタデータ、requirements lockを収録）、`SHA256SUMS.txt` の生成です。予行では実際の不足が見つかり修正しました。拡張は入口として `out/extension.js` を宣言しながら、それを出力するものが何もなく、bridgeのソースは拡張フォルダーの外にありました。ホストはesbuildでバンドルするようになり（`scripts/bundle-extension.mjs`、`vscode:prepublish` が実行）、`.vscodeignore` がソース、テスト、node_modulesをVSIXから除外します。タグ起動そのものの予行は、最初の実プレリリースタグで行います。

## 付録：`.github/workflows/release.yml`

日常のプッシュに使うGitHub Appはワークフローファイルを書けないため、このファイルはGitHubのWeb UIからリポジトリ所有者が追加します（`extension.yml` と同じ経路）。内容は規範的で、この文書の日英両版で同一です。

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

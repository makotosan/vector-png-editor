# Vector PNG Editorのインストール

[English](INSTALL.md)

## リリースからのインストール

GitHubリリースから `.vsix` をダウンロードし、VS Codeにインストールします。

```sh
code --install-extension vector-png-editor-<version>.vsix
```

（またはコマンドパレットの「Extensions: Install from VSIX...」を使います。）インストールはこれで完了です。環境セットアップの手順はなく、拡張が追加のダウンロードを求めることもありません。

## 要件

- VS Code 1.90以降（Windows、macOS、Linux）。
- それ以外は何も要りません。実行時にPython、ネイティブライブラリ（CairoやGTKランタイム）、フォントパッケージ、ネットワーク接続はいずれも不要です。

## 拡張に同梱されるもの

エディタが必要とするものはすべてVSIXの中にあります。Core（PNGコンテナ処理、safe-svg-v1検証、svg-normalization-v1、正規化と描画）は `packages/ts-core` のTypeScript Coreで、拡張ホストのコードにバンドルされます。描画にはWebAssembly化したresvgエンジン（`@resvg/resvg-wasm`、MPL-2.0）を使い、バイナリはパッケージ内の `media/resvg/` に入り、[THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md)に記載します。Monacoも同様に `media/monaco/` に同梱されます。開く、プレビュー、保存、書き出し、正規化はすべて拡張ホスト内でインプロセスに動作します。

## フォント

テキスト描画にはホストのシステムフォントを使い、アクティベーション時に一度だけバッファとして読み込んで描画器へ渡します。通常のサンセリフ系ファミリーに加え、存在すればCJKファミリーも対象です（当面の暫定方針。Issue #61参照）。ある文字をカバーするフォントがないマシンでは、そのテキストは代替フォントで描かれるか描かれません。適切なシステムフォントの導入が対処です。この段階ではフォントのダウンロードも同梱もしません。

## ソースからのビルド

```sh
cd packages/ts-core && npm install && npm test
cd ../extension && npm install && npm run check && npm test
npx --yes @vscode/vsce package
```

ts-coreのインストールを先に実行してください。拡張のスイートはTypeScript Coreをインプロセスに読み込むため、その `@resvg/resvg-wasm` 依存が必要です。`vscode:prepublish` スクリプトがMonaco、プロファイルのスキーマ、resvgのwasmを `media/` へコピーし、ホストコードをバンドルしてからパッケージ化します。

## 履歴：廃止されたPython環境

初期の開発ビルドは、管理対象の仮想環境からPython Coreを動かし、「Set Up Python Environment」「Python Environment Status」「Roll Back Python Environment」コマンド、`vectorPng.corePythonPath`／`vectorPng.coreWheelPath` 設定、同梱wheelを備えていました。TypeScript移行（Issue #58〜#61）で全機能がインプロセスへ移植され、Phase 3でPythonパッケージ、CLI、環境機構はすべて除去されました。それ以前のビルドはインストール済みのまま動作しますが、現在のビルドにはそれらは含まれず、必要でもありません。歴史的な記録は[CORE_PROGRESS.ja.md](CORE_PROGRESS.ja.md)と[EXTENSION_PROGRESS.ja.md](EXTENSION_PROGRESS.ja.md)にあります。

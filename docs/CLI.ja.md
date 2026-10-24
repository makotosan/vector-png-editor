# 実験的Core CLI契約v1

[English](CLI.md)

## 範囲と導入

開発package vector-png-editor-core 0.1.0.dev3はvector-png-editorとpython -m vector_png_editorを公開します。inspect、extract、validate、build、verify、rebuildを実装しています。書込・検証の完全な契約、バックアップ方針、競合制御の制限は[WRITING.ja.md](WRITING.ja.md)に記録し、VS Code editorと統合venv setup UIは未実装です。別の専用venv APIは[INSTALL.ja.md](INSTALL.ja.md)に記録します。Python metadataは3.11〜3.13を候補として許可し、実行した対応根拠は[CORE_PROGRESS.ja.md](CORE_PROGRESS.ja.md)に記録します。描画には別途native Cairoが必要で、WindowsではVECTOR_PNG_CAIRO_DIR、他platformでは導入に適したloader設定を使用します。Coreはsystem Pythonを変更しません。

```text
python -m pip install ./packages/core
vector-png-editor inspect input.png
vector-png-editor extract input.png original.svg
vector-png-editor validate original.svg --width 1024 --height 1024
vector-png-editor --request-id job1 validate original.svg --syntax-only
```

## コマンドと独立した結果

| コマンド | 動作 |
| --- | --- |
| inspect PNG | 上限制御した受動的なPNG／UTF-8 XML発見とraster decode。safe profile検証やSVG描画はしない。通常の有効PNGはkind=png、検出した不正原文はfallbackせずerror。寸法、color type、depth、interlace、PNG／原文SHA-256、原文byte数を返す。 |
| extract PNG OUTPUT | 同じ受動検査の後、新規出力に正確な展開原文byteを格納。BOM、XML宣言、空白、CRLFを保持。上書きoptionはなく、既存file・symlink・並行して作られた出力で失敗。同directory一時file、fsync、atomic no-clobber linkで公開し、入力には書き込まない。 |
| validate SVG | UTF-8 XMLとsafe-svg-v1を検査後、共通CairoSVG subprocessで指定viewport（既定1024×1024）を描画。renderer／版、viewport、font方針、color／alpha／text方針を返す。描画成功で保存PNGと比較したことにはならず、previewはnot-checked。 |
| validate SVG --syntax-only | XML／profile allowlistのみでrender=not-checked。数値・pathのrenderer受入、preview一致、広範なSVGの安全性は証明しない。 |
| build SVG OUTPUT | 変更しない原文を--width／--height（既定1024×1024）で描画し、埋め込み・検証・公開する。上書き・バックアップ・競合方針は[WRITING.ja.md](WRITING.ja.md)を参照。 |
| verify PNG | IHDR viewportで厳密なローカルRGBA8比較を行い、コンテナー・profile・rendererの結果を分離。不一致はerror.detailsを伴い12で終了。 |
| rebuild PNG OUTPUT | 埋め込み原文バイトと既存IHDR viewportから生成し、buildと同じ方針で検証・公開する。 |

inspect／extractはコンテナーとして対応した危険SVGや異なるpreviewのfixtureを実行せず受け入れられます。profile=not-checked、preview=not-checkedを報告します。抽出はactive利用の原文承認ではありません。任意ancillary payloadの妥当性、registryレベルのBCP47 language検証、PNG全体の相互運用は未監査なので、readerはcontainer=passed-supported-checksを返し、完全なcontainer証明を主張しません。XML複雑度上限は受動発見にも適用します。raster decodeでmetadata text／ICCを展開せず、rasterに必要なchunkだけPillowへ渡します。metadata全体の妥当性は明示的な監査項目です。

## JSONと終了コード

操作の成功・error出力はstdoutのJSON object 1個だけで、console encoding互換のためASCII JSON escapeを使用します。help／versionは人間向け出力の例外です。CLIは--request-json単独でstdinの上限付きJSON要求1個を受け取ります。schema、inline原文通信、TypeScriptアダプター、取消の制限は[BRIDGE.ja.md](BRIDGE.ja.md)に記録します。P1-04は一部実装です。任意のglobal --request-id（コマンド前）は最大128文字で、解析済み要求にechoします。不正引数ではcommand／request_id=nullの場合があります。error messageは最大2000 code pointsです。操作stdoutにlogを混ぜず、native／描画失敗を構造化errorにします。

```json
{"protocol":1,"command":"validate","request_id":"job1","ok":true,"result":{"xml":"valid","profile":"safe-svg-v1","profile_check":"passed","render":"not-checked","svg_bytes":42}}
```

これはschemaの例であり、特定入力の根拠ではありません。成功はresult、失敗はcode／messageを持つerrorを含みresultを持ちません。[cli-result-v1.schema.json](../schemas/cli-result-v1.schema.json)を参照してください。失敗をrasterだけのvector-png成功に読み替えません。

| 終了コード | error code・意味 |
| --- | --- |
| 0 | 操作成功。独立したnot-checked項目も確認する |
| 2 | invalid-arguments |
| 3 | invalid-container |
| 4 | invalid-svg：UTF-8／XML／root／DTD／entity／PI／encoding失敗 |
| 5 | unsupported-profile：有効XMLだがsafe-svg-v1外 |
| 6 | resource-limit：宣言したbyte／pixel／複雑度上限 |
| 7 | ordinary-png：原文のないPNGにextract、verify、rebuildを要求 |
| 8 | io-error |
| 9 | output-exists |
| 10 | render-failed。native Cairo設定失敗を含む |
| 11 | render-timeout |
| 12 | render-mismatch。検証報告はerror.details |
| 13 | conflict |
| 14 | cancelled：処理したKeyboardInterrupt |

通常の有効PNGのinspectはkind=pngで成功し、そのPNGのextractは7で終了します。描画失敗はcontainer破損ではありません。書込・検証・競合終了コードは[WRITING.ja.md](WRITING.ja.md)に記載したprotocol-1拡張です。任意のerror.detailsに構造化した比較報告を含めます。

## 上限と失敗時の保護

上限はSVG 1,000,000 bytes、PNG 32,000,000 bytes、一辺4096 pixels、総画素4,000,000、PNG chunk 10,000、XML要素5000、root深さ0から深さ32、属性100,000 code points、描画subprocess 20秒です。IDAT展開はAdam7 passとfilter byteを含む正確なscanline期待サイズを上限とし、単一の完全image zlib streamを要求します。pixel／raster対応はPillowに依存します。実際の検証範囲、任意metadataの不足、native memory制限は[SPEC_COMPATIBILITY.ja.md](SPEC_COMPATIBILITY.ja.md)に記録します。subprocess timeoutはOS sandboxや厳密なmemory quotaではなく、process出力はcapture後に検査します。render worker取消と厳密native memory上限は未実装です。

抽出は処理可能な公開失敗時に一時fileを削除し、入力や既存出力を置換しません。editor保存transaction、危険directoryのsandbox、crash耐久な2 file transactionではありません。描画はprofile検証後の原文のみを受け入れ、外部取得を拒否して原文byteを保持し、normalizationやautoformatをしません。build／rebuildは検証した一時出力の公開、リビジョントークン付き明示上書き、独立バックアップ、協調ロックを提供し、任意の外部ライターとの並行更新制御はP1-03／P2-06に残ります。境界と復旧は[WRITING.ja.md](WRITING.ja.md)を参照してください。


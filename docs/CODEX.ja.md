# CLIによるvector-pngの自動化（Codexワークフロー）

[English](CODEX.md)

このガイドは、コマンドラインからvector-pngファイルを編集する自動呼出（Codexや任意のスクリプト）のためのものです。チャットUIはありません。全ての操作はPython Coreの `vector-png-editor` コンソールスクリプトであり、VS Code拡張がbridge経由で使うのと同じCoreです。まず規則、次にワークフローです。

## 基本規則

1. **呼出ごとにJSON封筒が1つ。** 全ての呼出はちょうど1つのJSONオブジェクトを出力します。成功時は `{protocol, command, request_id, ok, result}`、失敗時は `{..., ok: false, error: {code, message}}` です。封筒を解析してください。プロセスの終了コードも同じ結果を伝えます（下表）。呼出の対応付けには `--request-id <id>` を渡します。
2. **リビジョンは内容のハッシュ。** `inspect` が報告する `png_sha256` は、ファイルの現在のバイトのSHA-256です。上書きは `--overwrite --expected-sha256 <そのハッシュ>` を付けた場合にのみ受け付けられます。トークンは書き込み直前の新しい `inspect` から取り、他の書き込みをまたいで再利用しないでください。
3. **競合は情報であって、リトライの合図ではありません。** 終了コード13（`conflict`）は、トークン取得後にファイルが変わったことを意味します。再度inspectし、現在の内容を確認して、意図的に判断してください。新トークンで盲目的に再試行すると、相手の版（ユーザーが保存したエディターの作業を含む）を捨てることになります。
4. **エラーでは全てが保持されます。** 失敗した `build` は出力先を変更しません（公開は原子的で、旧ファイルのバックアップスナップショットが隣に残ります）。原文ファイルは読まれるだけです。書き込みが起きたと仮定する前に `ok` を確認してください。
5. **extractはバイト単位で正確、描画は描画器次第。** `extract` は埋め込まれた原文バイトを（BOM、CRLF、整形を含め）そのまま返します。`verify` は保存されたプレビューを *この* 描画器の出力と比較するため、不一致は破損ではなく「他で描画された」ことを意味する場合があります。

## セットアップ

管理下環境または固定した環境からCoreを使ってください（[INSTALL.ja.md](INSTALL.ja.md)参照）。呼出側とエディターは、interpreterのパスではなく、Coreとそのリビジョン規律について一致する必要があります。可用性を一度確認します。

```console
$ vector-png-editor --version
0.1.0.dev3
```

## 往復手順

作成し、読み、編集し、書き戻し、結果を証明します。

```console
$ vector-png-editor build a.svg a.png --width 16 --height 16
{"protocol":1,"command":"build","request_id":null,"ok":true,"result":{...,"png_sha256":"2bcb…885f8","preview":"match","backup":null}}

$ vector-png-editor inspect a.png
{"protocol":1,"command":"inspect","request_id":null,"ok":true,"result":{"kind":"vector-png","wire":"v1",...,"png_sha256":"2bcb…885f8","svg_bytes":114,...}}

$ vector-png-editor extract a.png out.svg
$ $EDITOR out.svg

$ vector-png-editor validate out.svg --width 16 --height 16
{"protocol":1,...,"ok":true,"result":{...,"profile_check":"passed","render":"passed",...}}

$ vector-png-editor build out.svg a.png --width 16 --height 16 \
    --overwrite --expected-sha256 2bcb…885f8
{"protocol":1,...,"ok":true,"result":{...,"preview":"match","backup":"a.<uuid>.backup"}}

$ vector-png-editor verify a.png
{"protocol":1,...,"ok":true,"result":{...,"preview":"match"}}
```

注記：

- 記録の中で、`extract` は埋め込み原文とバイト単位で同一のファイルを書き、上書きトークンは直前の `inspect` の `png_sha256` です。
- `validate --syntax-only` は描画なしでXMLとsafe-svg-v1プロファイルを検査し、結果では描画が未検査と報告されます。公開前には完全な形式を使ってください。
- `rebuild a.png out.png` は既存ファイルの *埋め込み* 原文を再描画します（編集済みコピーは無視されます）。「プレビュー再生成」の操作であり、同じリビジョン規則に従います。
- プログラムからの単一リクエスト呼出には、サブコマンド引数の代わりに標準入力からprotocol-1リクエスト（[BRIDGE.ja.md](BRIDGE.ja.md) のbridgeプロトコル）を1つ読む `--request-json` があります：`{"protocol":1,"command":"inspect","request_id":"x","input":"a.png"}`。

## エディターを開いたままでの競合

シナリオ：ユーザーがエディターでファイルを開いて未保存の編集を持っている間に、自動呼出が同じファイルを操作します。

- 呼出側の読み取り（`inspect`、`extract`）は常に安全です。最後に *保存された* 状態が見えます。未保存のエディター編集はディスク上にないため、CLI操作がそれを見たり壊したりすることはありません。
- ユーザーが先に保存すると、ファイルのリビジョンが変わります。呼出側が古いトークンで上書きしようとすると失敗します。

```console
$ vector-png-editor build mine.svg a.png --width 16 --height 16 \
    --overwrite --expected-sha256 <stale token>
{"protocol":1,"command":"build","request_id":null,"ok":false,"error":{"code":"conflict","message":"Output changed since the supplied revision"}}
(exit code 13; a.png is byte-identical to before the call)
```

- 正しい対応は、優先順に： *別の* 出力パスへ書き、人間がマージする。または、再inspectし、新しく保存された原文をextractして、意図した変更をそれへ再適用し、検証して、新しいトークンで上書きする。ループ状の再試行は決してしないでください。
- 鏡像のケースも同様です。呼出側が先に保存すると、エディターが外部変更を検出し、ユーザーのdirtyバッファを保持して、解決方法をユーザーに尋ねます（P2-06）。どちらの側も相手を黙って上書きできません。

## 終了コード

| コード | 意味 | コード | 意味 |
| --- | --- | --- | --- |
| 0 | ok | 8 | io-error |
| 2 | invalid-arguments | 9 | output-exists（`--overwrite` なし） |
| 3 | invalid-container | 10 | render-failed |
| 4 | invalid-svg | 11 | render-timeout |
| 5 | unsupported-profile | 12 | render-mismatch（`verify`） |
| 6 | resource-limit | 13 | conflict |
| 7 | ordinary-png | 14 | cancelled |

## 検証済みワークフロー

`tests/integration/test_codex_workflow.py` が、この往復手順、競合シナリオ、エラー時の保持、`--request-json` モードを、導入済みCLIに対して実行します。

```console
$ VECTOR_PNG_EDITOR_CLI=/path/to/vector-png-editor \
    python -m pytest tests/integration/test_codex_workflow.py -q
```

# 実験的JSON bridgeと環境診断

[English](BRIDGE.md)

## 実装範囲

Core 0.1.0.dev3は既存6コマンド向けの上限付きstdin要求、独立した読み取り専用環境診断、packages/bridgeのTypeScript subprocessアダプターを追加します。P1-04は一部実装です。別の[専用環境管理API](INSTALL.ja.md)で、Pythonアプリ依存のversion lockを使う専用venv構築・健全性検査・有効化・切り戻しを追加しました。VS Code／Webview連携、完全なnative・成果物固定、リリースは残ります。保存形式、仕様固定、[WRITING.ja.md](WRITING.ja.md)の書き込み競合制御の境界は変更しません。PR #24はマージ済みですが、元のCI結果は過去の根拠であり、このbridgeの証明ではありません。

## 1要求と1結果

vector-png-editor --request-json単独、またはpython -m vector_png_editor --request-jsonを実行します。UTF-8 JSON objectを1個送り、stdinを閉じます。NDJSON、常駐server、取消メッセージstreamではありません。読み取りはEOFを待ち、アダプターはstdinを閉じて全体期限を適用します。操作stdoutは既存protocol-1結果の外枠1個、診断は別のstderrです。引数CLIのhelp／versionは人間向け出力の例外のままです。既存の位置引数コマンド構文は保持します。

```json
{"protocol":1,"command":"validate","request_id":"document-7:revision-3","input":"source.svg","syntax_only":true}
```

[cli-request-v1.schema.json](../schemas/cli-request-v1.schema.json)はコマンド別フィールドを定義し、未知のプロパティーを拒否します。protocolは整数1、request_idは必須でUnicode code point 1〜128個です。input／outputパスはcode point 1〜32768個でNULを含めません。inspect／verifyはinput、extract／rebuildはinputとoutputが必須です。validate／buildはinputパスかsource_base64の厳密に一方を受け取り、buildはoutputも必須です。source_base64は原文の正確なバイトを正規のpadding付き標準base64で表し、UTF-8 BOM、XML宣言、Unicode、CRLFを保持します。アダプターはSVGテキストへdecode・再encodeしません。validateはsyntax_only、validate／buildはwidth／height（既定1024×1024）、build／rebuildは既存の対指定方針によるoverwriteとexpected_sha256を受け取ります。

JSON Schemaを補う通信上限は要求生バイト2,000,000、base64文字1,333,336、展開原文バイト1,000,000、一辺4096 pixels、総画素4,000,000です。objectの重複key、非有限数、後続の別JSON文書、不正UTF-8、単独surrogate文字、非正規base64 pad bitを拒否します。JSON Schemaだけではこれらのバイト・decoder・積の要件を証明できません。不正要求は有効な要求context確立前にcommand／request_id=nullの構造化invalid-argumentsまたはresource-limitエラーを返します。解析中にファイルを変更しません。ソース配布のtest fixtureに含めるschemaコピーは、リポジトリーの正規schemaと照合します。

成功要求はcommand／request_idをechoし、ok=trueとresultを返して0で終了します。Core失敗は最上位resultなしのok=falseとerrorを返し、既存の安定した終了コードを使います。プレビュー不一致はerror.detailsにrenderer・比較報告を保持して12で終了します。[結果schema](../schemas/cli-result-v1.schema.json)はprotocol 1のままです。この外枠は独立したcontainer／profile／render／preview／authenticity結果を置き換えません。[CLI.ja.md](CLI.ja.md)と[WRITING.ja.md](WRITING.ja.md)を参照してください。

## TypeScriptアダプターと古い結果

runCoreは信頼済みPython実行ファイルのパスと構造化Requestを受け取り、shell=falseと非表示Windowsウィンドウで固定の引数一覧を起動します。原文、パス、要求IDからshellコマンドを組み立てません。パス・inline原文はstdinへ送ります。要求2,000,000 bytes、stdout 262,144 bytes、stderr 65,536 bytesの上限と、既定60,000msの全体期限（呼び出し側の変更範囲1〜120,000ms）を適用します。不正UTF-8／JSON、異なるprotocol／command／ID、矛盾する成功・失敗の形、終了コード不一致を拒否します。上限付きstderrを応答と分けたdiagnosticsとして返します。結果固有のpayloadフィールドは将来のエディターが検証・使用するまでunknownであり、このアダプターはコマンド結果の完全な意味検証器ではありません。応答と診断を信頼済みコンテンツとしてactive HTMLへ挿入してはいけません。

LatestValidationは文書ごとに保持します。新しいvalidate要求ごとにローカル世代を進め、前の要求を取り消します。呼び出し側が要求IDを再利用しても古い成功・失敗を破棄します。disposeは保留結果を無効化します。呼び出し側は文書・リビジョンを表すIDを指定します。このレーンはvalidate以外を拒否します。AbortSignalは読み取り専用inspect／validate／verifyだけに許可し、extract／build／rebuildは起動前に拒否するので、プレビュー取消が保存を終了させません。全体期限と出力上限は全コマンドへ適用します。それらの上限で中断した保存は、完全なファイルを公開済みの場合も一時ファイル・ロックが残る場合もあり、保存rollbackではありません。エディターの取消と確定境界の協調は残課題です。

プロセス終了はbest effortです。POSIXでは専用process group、Windowsでは非表示のtaskkill /T /Fと5秒の補助process期限、親process終了へのfallbackを使います。abort・timeoutはbridgeエラーであり、Core成功応答を捏造しません。OS sandboxや厳密なmemory quotaはなく、process groupからの離脱やWindows tree終了の失敗で子孫が残る可能性があります。アダプターの上限付きprotocol streamは、既存render subprocessのcapture後サイズ検査という制限を解消しません。native workerの穏当な取消と完全な描画出力上限制御はP1-04に残ります。TypeScript原文はNode 24内蔵の型除去でruntimeテストし、外部npm依存や型検査・build toolchainは使いません。package済み拡張でも、将来のVS Code拡張hostのNode版との互換性の証明でもありません。

## 環境診断と検証根拠

```text
python -m vector_png_editor.environment
```

診断はprotocol=1、kind=environment、reportを持つJSON objectを1個出力します。Core／Python／platformの版、Pythonが3.11〜3.13に入るか、Pillow 13.0.0・CairoSVG 2.9.1・defusedxml 0.7.1のexpected／actual／match、実際の2×2描画結果または上限付きエラーを返します。Python範囲、直接依存固定、描画がすべて合格した場合だけ0、それ以外は1で終了します。site packageの欠落やnative描画失敗を、ファイル変更・導入なしで報告します。公開API importを遅延させ、この診断が任意のruntime import欠落時にも起動できるようにします。この別診断の外枠は要求IDを持たず、7番目の編集コマンドやrunCore応答ではありません。standalone Core内のnative_lockとenvironment_managerはnot-implementedと明示します。別のTypeScript管理処理は[INSTALL.ja.md](INSTALL.ja.md)に記録します。native・推移的依存の完全な再現性、font同等性、導入rollbackは証明しません。

テストは厳密・過大要求、重複key、非有限・深いJSON、不正Unicode／base64、6コマンドJSON原文往復、結果schema検証、依存欠落・不一致とnativeエラー、不正・過大subprocess応答、ID不一致、取消・期限、古い検証、実際のTypeScriptからPythonへの呼び出しを対象とします。clean wheelのsmokeにはソースツリー外でのJSON要求と環境診断を含めます。CoreのOS／Python全9組のCIでもNode 24のbridgeテストを実行します。実行済み根拠は[CORE_PROGRESS.ja.md](CORE_PROGRESS.ja.md)を参照してください。単体・障害テストだけでP1-04／P2の環境復旧やエディターhost受け入れは完了しません。

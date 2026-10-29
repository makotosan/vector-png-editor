# 構成と確定製品要件

[English](ARCHITECTURE.md)

## 1. 製品範囲

製品はvector-png Editorで、Core（packages/ts-core）が拡張ホスト内でインプロセスに動作するTypeScriptのVS Code拡張です。初期拡張配布はGitHub Releases経由のVSIXです。対象はWindows／macOS／Linuxで、格納SVGはsafe-svg-v1を使用します。独立したCLIはありません。初期PhaseのPython Coreとpip CLIは、全機能がTypeScript Coreへ移植された時点でPhase 3（Issue #60）で廃止されました。CodexはエディタでSVG原文を編集し、ChatGPT UIは初期対象外です。SVGを正本、PNG rasterを派生とします。製品引き継ぎv1.0は固定したwire v1 draft 0.1を変更しません。

コマンドはVector PNG: Open in Editorです。拡張子suffixを必須にせず埋込vector-pngを検出します。通常PNGはVS Code標準image viewerで開きます。破損vector-pngは黙って通常PNGにせず診断します。新規文書は1024×1024 pixelsの透明背景です。

## 2. UIと文書model

左paneは保存PNG rasterまたは編集SVGをpreviewし、右paneはローカルMonacoのSVG原文です。XML強調、safe profileに従う補完、検索置換、診断を提供します。入力停止300ms後に検証して編集previewを更新します。保存／編集previewは手動切替のみで、自動画像差分検出はありません。旧処理を取り消し、request／document revision IDで古い結果を破棄します。保存時にSVGを整形・正規化・黙って削除してはいけません。

CustomEditorProviderとCustomDocumentを使い、原文byte、decode textとBOM／改行metadata、IHDR viewport、保存raster、保存disk revision、現原文revisionを保持します。Monaco modelは改行を正規化し得るため、正確なbyte保持を明示検証します。未変更時は元byte bufferを維持し、意図的な編集後もBOM／改行方針を保持します。CustomDocumentEditEventに不変edit eventとundo／redo callbackを渡します。VS Code履歴を正本とし、Monacoの編集・undo／redoで二重履歴とmessage loopを防ぎます。保存、別名保存、revert、backup、hot-exit、複数panel状態が必須です。これは拡張host実証前の設計であり、APIだけで同期できるという主張ではありません。

外部変更を監視します。clean文書はreload可能で、dirty文書はbufferと保存・外部版を保持し競合を通知します。Coreはrevision検査と置換の間の競合を含め、古い保存による外部更新消失を防ぐ必要があります。保存前hashの単純比較だけでは証明不十分で、P2-06で実装した並行処理の境界を検証・文書化します。dirty編集の自動上書き・mergeは行いません。

## 3. 共通Coreと保存

TypeScript Core（packages/ts-core）が唯一のCoreであり、上限制御のコンテナー解析、正確な抽出、profile検証、描画、検証後atomic公開を拡張ホストがインプロセスに呼ぶライブラリです。固定した実装SHAの既存MIT Pythonコードを帰属付きで振る舞いごとに移植したもので、Pythonの原典は廃止されました（implementation-reference.json参照）。拡張と将来の呼び出し側は同じCore生成経路を使用し、独立したCLIはありません。

Coreはinspect、extract、validate、build、rebuildを、安定したエラーコード（TsCoreError）と構造化診断を持つライブラリ関数として実装します。独立したverify入口は未移植です。通常PNG、invalid-container、invalid-svg、unsupported-profile、resource-limit、render-mismatch、render-not-checkedの意味を分離し、最終API文字列・codeはCoreが定義しCoreとともに検証します。抽出原文byteをローカルrenderer画素一致から独立して保持します。inspectでSVGを実行したり未検証SVGをDOMに挿入したりしてはいけません。

保存はSVG検証、IHDR寸法でPNG生成、原文byteを変更せず埋込、全コンテナー／profile／出力preview検証、競合方針確認、atomic公開の順です。profile違反は保存を禁止します。timeout、取消、書込失敗、競合で元ファイルと未保存編集を保護します。backup／別名保存も元データを保護します。ローカルraster完全一致の検証はrenderer／版、viewport、font、color／alpha処理、比較方法を記録し、異種engine一致や真正性を主張しません。

## 4. RuntimeとWebview安全性

Pythonの導入もnativeライブラリも不要です。VSIXにはTypeScript CoreとWebAssembly化したresvg描画器が同梱され、テキスト描画はアクティベーション時に一度だけバッファとして読み込むホストのシステムフォントを使います（Issue #61の暫定フォント方針）。拡張自身の保存領域の外には何も導入・変更しません。

Monaco、script、style、workerをローカル同梱します。制限Content Security Policy、localResourceRoots、検証したmessage schemaを設定します。CDNや外部SVG resource／scriptを禁止します。原文をdataとして扱い、未検証SVGをactive DOMへ埋め込みません。生成を共有するため、編集SVG previewにはCore生成rasterを優先し、原文状態で表示名を付けます。CSP／worker設定と補完はpackage化・offlineの拡張hostテストが必要です。

## 5. リポジトリと配布

source pathです（TypeScript Coreは実装済みで、実装範囲は[現在の進捗](EXTENSION_PROGRESS.ja.md)を参照してください）。

```text
vector-png-editor/
  packages/ts-core/       # TypeScript Core: container, validation, normalization, rendering
  packages/extension/     # Custom Editor, local Monaco, bundled host code
  schemas/                # safe-svg-v1 policy and generated profile artifacts
  docs/                   # requirements, research, acceptance, paired translations
  evidence/               # reproducible finite check results
  tools/                  # research and validation tools
  spec-reference.json
  implementation-reference.json
  .github/workflows/
```

GitHub IssuesでPhase・task単位に管理します。各Issueに目的、予定対象ファイル、実装、依存ID、受入、testを記載します。mainを成功CI必須で保護し、機能branchとPRで統合します。GitHub Actionsは対応OSでTypeScript Coreと拡張をテストし、VSIXをbuildして、タグ起動のGitHub Releasesへの公開を検証します。配布・実機条件は[ACCEPTANCE.ja.md](ACCEPTANCE.ja.md)に記録します。全条件合格まで安定版完成と判定しません。

## 6. API参照と残る検証

公式[Custom Editor guide](https://code.visualstudio.com/api/extension-guides/custom-editors)と[VS Code API](https://code.visualstudio.com/api/references/vscode-api)はcustom document edit event、save、revert、backupを説明します。[Webview guide](https://code.visualstudio.com/api/extension-guides/webview)はCSPとlocal resource処理を説明します。構成選択の根拠ですが、Monaco履歴や競合処理の実証ではありません。P0-04／P2-05／P2-06で拡張hostの連携を検証します。既存上流のextract／inspectはprofile／描画と発見を結合し、必要な独立API結果を持たないため、単純なコマンド改名ではなくCore再構成が必要です。非互換な形式変更は認可されていません。その変更や未確定の製品判断の前には利用者判断を求めます。


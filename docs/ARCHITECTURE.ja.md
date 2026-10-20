# 構成と確定製品要件

[English](ARCHITECTURE.md)

## 1. 製品範囲

製品はvector-png Editorで、TypeScriptのVS Code拡張、再利用するPython Core、独立したpip CLIを構成します。初期拡張配布はGitHub Releases経由のVSIXです。対象はWindows／macOS／Linuxで、格納SVGはsafe-svg-v1を使用します。Codexは共通CLIで編集し、ChatGPT UIは初期対象外です。SVGを正本、PNG rasterを派生とします。製品引き継ぎv1.0は固定したwire v1 draft 0.1を変更しません。

コマンドはVector PNG: Open in Editorです。拡張子suffixを必須にせず埋込vector-pngを検出します。通常PNGはVS Code標準image viewerで開きます。破損vector-pngは黙って通常PNGにせず診断します。新規文書は1024×1024 pixelsの透明背景です。

## 2. UIと文書model

左paneは保存PNG rasterまたは編集SVGをpreviewし、右paneはローカルMonacoのSVG原文です。XML強調、safe profileに従う補完、検索置換、診断を提供します。入力停止300ms後に検証して編集previewを更新します。保存／編集previewは手動切替のみで、自動画像差分検出はありません。旧処理を取り消し、request／document revision IDで古い結果を破棄します。保存時にSVGを整形・正規化・黙って削除してはいけません。

CustomEditorProviderとCustomDocumentを使い、原文byte、decode textとBOM／改行metadata、IHDR viewport、保存raster、保存disk revision、現原文revisionを保持します。Monaco modelは改行を正規化し得るため、正確なbyte保持を明示検証します。未変更時は元byte bufferを維持し、意図的な編集後もBOM／改行方針を保持します。CustomDocumentEditEventに不変edit eventとundo／redo callbackを渡します。VS Code履歴を正本とし、Monacoの編集・undo／redoで二重履歴とmessage loopを防ぎます。保存、別名保存、revert、backup、hot-exit、複数panel状態が必須です。これは拡張host実証前の設計であり、APIだけで同期できるという主張ではありません。

外部変更を監視します。clean文書はreload可能で、dirty文書はbufferと保存・外部版を保持し競合を通知します。Coreとadapterはrevision検査と置換の間の競合を含め、古い保存による外部更新消失を防ぐ必要があります。保存前hashの単純比較だけでは証明不十分で、P2-06で実装した並行処理の境界を検証・文書化します。dirty編集の自動上書き・mergeは行いません。

## 3. 共通Core・bridge・保存

固定した実装SHAの既存MIT Pythonコードを帰属付きで再利用します。上限制御のコンテナー解析、正確な抽出、profile検証、描画、検証後atomic公開のPython公開APIを設けます。根拠がある場合だけ機能ごとに段階的にTypeScriptへ移行し、初期TypeScriptはVS Code連携とJSON制御を担当します。CLIと拡張は同じCore生成経路を使用します。

inspect、extract、validate、build、verify、rebuildを実装します。P1-02／P1-04で版付きJSON要求・結果schema、安定した終了コード、request ID、診断、取消、worker出力上限を定義します。stdoutはprotocol専用、logはstderrです。通常PNG、invalid-container、invalid-svg、unsupported-profile、resource-limit、render-mismatch、render-not-checkedの意味を分離し、最終API文字列・codeをPhase 1で定義・検証します。抽出原文byteをローカルrenderer画素一致から独立して保持します。inspectでSVGを実行したり未検証SVGをDOMに挿入したりしてはいけません。

保存はSVG検証、IHDR寸法でPNG生成、原文byteを変更せず埋込、全コンテナー／profile／出力preview検証、競合方針確認、atomic公開の順です。profile違反は保存を禁止します。timeout、取消、環境失敗、書込失敗、競合で元ファイルと未保存編集を保護します。backup／別名保存も元データを保護します。ローカルraster完全一致の検証はrenderer／版、viewport、font、color／alpha処理、比較方法を記録し、異種engine一致や真正性を主張しません。

## 4. RuntimeとWebview安全性

Pythonは利用者が導入し、拡張は専用の版付きvenvを管理します。候補Pythonは3.11〜3.13で、実際の依存テストで確定します。Python不在時は導入を案内し、native Cairo設定も説明します。検証済みPython packageを固定し、native依存を確認します。更新venvを別に作り、導入・健全性検査成功後にのみ切替え、失敗時は旧環境を保持します。system Pythonを変更しません。

Monaco、script、style、workerをローカル同梱します。制限Content Security Policy、localResourceRoots、検証したmessage schemaを設定します。CDNや外部SVG resource／scriptを禁止します。原文をdataとして扱い、未検証SVGをactive DOMへ埋め込みません。生成を共有するため、編集SVG previewにはCore生成rasterを優先し、原文状態で表示名を付けます。CSP／worker設定と補完はpackage化・offlineの拡張hostテストが必要です。

## 5. リポジトリと配布

予定のsource pathです（この段階では計画・根拠・toolのみ存在します）。

```text
vector-png-editor/
  packages/core/          # Python Core, independent pip CLI, tests
  packages/extension/     # TypeScript adapter, Custom Editor, local Monaco
  schemas/               # versioned JSON request/result contracts
  tests/integration/     # CLI/editor conflict and distribution tests
  docs/                  # requirements, research, acceptance, paired translations
  evidence/              # reproducible finite check results
  tools/                 # research and validation tools
  spec-reference.json
  implementation-reference.json
  .github/workflows/
```

GitHub IssuesでPhase・task単位に管理します。各Issueに目的、予定対象ファイル、実装、依存ID、受入、testを記載します。mainを成功CI必須で保護し、機能branchとPRで統合します。GitHub Actionsは対応OS／Pythonのテスト、VSIXとwheel／sdistのbuild、タグ起動のGitHub Releasesと設定したpip indexへの公開検証を行います。配布・実機条件は[ACCEPTANCE.ja.md](ACCEPTANCE.ja.md)に記録します。全条件合格まで安定版完成と判定しません。

## 6. API参照と残る検証

公式[Custom Editor guide](https://code.visualstudio.com/api/extension-guides/custom-editors)と[VS Code API](https://code.visualstudio.com/api/references/vscode-api)はcustom document edit event、save、revert、backupを説明します。[Webview guide](https://code.visualstudio.com/api/extension-guides/webview)はCSPとlocal resource処理を説明します。構成選択の根拠ですが、Monaco履歴や競合処理の実証ではありません。P0-04／P2-05／P2-06で拡張hostの連携を検証します。既存上流のextract／inspectはprofile／描画と発見を結合し、必要な独立API結果を持たないため、単純なコマンド改名ではなくCore再構成が必要です。非互換な形式変更は認可されていません。その変更や未確定の製品判断の前には利用者判断を求めます。


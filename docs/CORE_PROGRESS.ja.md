# 初期Core実装 — 2026-10-20

[English](CORE_PROGRESS.md)

## 実装した範囲

P1-01／P1-02としてpackages/coreに実験的Python package、公開API、inspect／extract／validate JSON CLI、safe profile検査、共通の上限制御CairoSVG rendererを追加しました。Phase 1の開始であり、Phase 0全監査やPhase 1全体の完了を宣言しません。この初期基準ではbuild／verify／rebuild、全bridge transport／取消、拡張、管理venv、releaseが未完了でした。現在の範囲は下の書き込み追加を参照してください。Phase 0報告・根拠は過去の基準であり、Coreが存在しないとの記述とXML不足3点が未修正との記述について、新packageでは今回の結果が優先します。元の上流実装は変更していません。

移植したallowlist／rendererはmakotosan/vector-pngに固定して帰属を記載しました。MIT noticeと上流fixtureの正確な出典をrepository／packageとwheel licenseに含めます。直接runtime版はPillow 13.0.0、CairoSVG 2.9.1、defusedxml 0.7.1に固定します。推移・native全依存のlockではありません。候補Python metadataは>=3.11,<3.14ですが、対応はこの宣言から推測せず実行済み根拠に限ります。

## 変更と互換性

- SPEC §3：部分文字列検査をparserでのXML宣言／PI処理に置換。BOM＋UTF-8宣言と無害comment文字列を受け入れ、非UTF-8宣言を拒否。抽出でCRLF・BOM・commentを含む原文byteを正確に保持し、再serializeしません。
- SPEC §§2–4：singleton／critical chunk順序、連続IDAT、APNG acTL／fcTL／fdAT拒否、CRC／末尾、IHDR field、palette／transparency制約、上限制御した単一zlib stream、raster scanline／filter検証を明示。Adam7サイズ計算を実装しましたが、広範なinterlace／raster検証は監査が必要です。
- SPEC §§5、7：受動inspect／extractは描画もsafe-svg-v1適用もしません。container-positiveな危険SVGと異なるrasterを受動抽出できます。validateはprofile検査、実描画、未確認のpreview一致を分離します。自動normalizationや外部取得はしません。
- SPEC §6：抽出はno-clobber atomic公開で、失敗時に入力を保持します。editorの上書き・保存・並行処理transactionは未実装です。

正確なJSON field、終了コード、上限は[CLI.ja.md](CLI.ja.md)に記録します。wire keyword、iTXt payload、固定仕様は変えず、形式移行は不要です。language tag registry検証、ancillary payloadの意味、広範decoder検証が未完了なので、container結果は意図的にpassed-supported-checksとします。有限testから完全準拠を主張しません。font依存native rendererは汎用の画素判定基準ではありません。

## 検証と配布状態

ローカルWindows x64／Python 3.13.5で初期Core suiteは55件合格、4.49秒でした。固定21例、XML回帰3点、原文byte、危険／profile入力、PNG／APNG規則、公開失敗、JSON CLI、実alpha描画、timeoutを含みます。過去のPhase 0 probeとは異なり新packageを検査します。最終suite／package根拠は後続の検証記録を参照してください。

Windows／macOS／Linux × Python 3.11／3.12／3.13の9組のhosted CIを追加し、実描画、CLI test、wheel／sdist build、source外でのclean venv wheel導入を行います。core-checkは全matrixを集約し、planning-checkは別の文書検査です。workflowの存在は各組の合格を意味せず、現在のremote結果はPR／Actions runから確認する必要があります。editor実機受入はなく、pip／VSIX公開もしていません。

GitHub再認証後にmain保護を確認しました。PR必須、planning-check必須、branch最新化必須、管理者にも適用、force-push／削除禁止です。Phase 0 PR #21はこの保護経由でmergeし、Core変更はcodex/core-read-validationと別PRを使用します。実装CIの進展に応じて必須checkをreviewする必要があります。

## 確認と残る作業

最終ローカル検証（2026-10-21 Asia/Tokyo）は62件合格、4.89秒でした。XML／展開のresource結果、明示的な末尾eXIf順序、正常Adam7 raster、request ID過大時の上限errorを追加しています。build 1.6.1、setuptools 84.2.0、wheel 0.48.0でwheelとsdistを作成しました。source外のclean venv導入でpackage workerの実描画が合格しました。通常console entry pointもpackage smoke scriptで検査します。一時directory制限のためbuild／clean導入は承認済み通常実行を使用しました。system Python packageは変更せず、build toolはworkspaceに導入しました。上記の初期55件の結果を補完します。

P0-01／P0-02には全ancillary／raster／profile監査、P0-03にはnative依存・license matrix確認、P0-04には拡張host試作が残ります。file追加だけでP1-01／P1-02を閉じません。P1-03はbuild／verify／rebuildとfile競合、P1-04はTypeScript transport全体、schema詳細、取消、出力・memory制御、環境lock、P1-05は全6コマンドのpip配布を扱います。保存形式の変更や未確定の製品選択は行っていません。README、構成、受入、互換性、Phase 0からの案内、新CLI／進捗の日英全文を同期し、意味、表、識別子、コマンド、参照先、数値上限、状態を確認しました。


## 書き込み追加 — 2026-10-21

Core 0.1.0.dev2はbuild／verify／rebuild、原文保持生成、厳密なローカルRGBA8比較、独立バックアップと協調リビジョン・ロック検査を備えた一時出力の公開を追加します。完全な契約、SPEC §§3〜7への影響、外部ライターとの競合制御の明示的な制限は[WRITING.ja.md](WRITING.ja.md)を参照してください。P1-03は一部実装です。この文書の先行結果は初期Coreの基準であり、新しい書き込みコードの証明ではありません。現在のローカル・package・CI根拠は実行後に以下へ追記します。仕様固定、キーワード、互換性移行の変更はありません。

書込検証（2026-10-21）：Windows／Python 3.13.5でローカル80件が33.20秒で合格し、置換失敗と後からの同一ファイルへの書き込み後も独立バックアップが保持されることを含みます。0.1.0.dev2のwheel／sdistを作成し、ソースツリー外のclean venvへのwheel導入で6コマンドすべて、BOM／CRLF原文の正確な往復、実際のCairoSVG描画が合格しました。計画文書の構造検査も合格しました。今回追加分のhosted CIは未完了です。初期PR #23のmatrixは9組すべて合格してマージ済みですが、過去の根拠に限ります。影響するREADME、CLI、進捗、互換性、書込の日英ペアを節ごとに照合し、意味、表、例、コマンド、参照先、上限、失敗・競合制御の主張の一致を確認しました。

## JSON bridge追加

Core 0.1.0.dev3は全6コマンド向けの厳密な上限付きprotocol-1 stdin要求、正確なinline原文バイト、出力上限・期限・読み取り専用取消・世代による古いプレビュー結果拒否を備えたTypeScriptアダプター、読み取り専用のPython・直接依存・実描画環境診断を追加します。完全な要求schemaと境界は[BRIDGE.ja.md](BRIDGE.ja.md)を参照してください。Windows／Python 3.13.5のローカルPythonテスト116件が45.48秒で合格し、実際のPython呼び出しを含むNode 24 bridgeテスト15件が合格しました。wheel／sdistを作成しました。導入smokeとhosted CI根拠は実行後に今回のPRへ記録します。P1-04は一部実装で、native・推移的依存固定、穏当なrenderer取消・出力上限、管理venv更新・切り戻し、拡張host受け入れは残ります。これらのテストは任意ライターとの競合制御や形式完全準拠を証明しません。README、CLI、互換性、進捗、bridgeの日英ペアを節ごとに照合し、例、表、参照先、上限、状態、取消・失敗時保証を含む全文の意味の一致を確認しました。上記の書込・初期基準の結果は過去の根拠であり、PR #24はマージ済みです。

## 専用Python環境管理の追加

TypeScript管理処理で独立venvを作成し、信頼済みwheel／lock digestとPython範囲を検査し、requirements.lockのアプリ依存9個を固定導入し、venv identity・package閉包・依存・実描画を検証して、active／previous pointerをatomicに切り替えます。旧環境と失敗環境を保持し、健全性を条件に切り戻します。runManagedCoreはPython／pip変数を除去したready interpreterを選びます。offline／network選択、API契約、復旧の制限は[INSTALL.ja.md](INSTALL.ja.md)を参照してください。ローカルWindowsでNodeテスト全28件がskipなしで115.63秒で合格しました。実際の専用venv統合、offline導入失敗、不正・不健全wheel、取消、並行setup、周囲の不正な変数、切り戻し、active pointer・原文の正確な保持を含みます。Core wheelは0.1.0.dev3でCore原文は変更せず、先のPython 116件は過去の基準根拠です。今回追加分のhosted CIは未完了で、OS／Python全9組でそれらのCoreテストと実際の管理テストも実行します。P1-04／P2-07は一部実装で、interpreter自動検出・native setup UI、release manifest、成果物・native hash、完全なrenderer resource・取消制御、VS Code連携、実機受け入れは残ります。README、bridge、導入、受け入れ、進捗の日英ペア全文について、節の意味、識別子、版、上限、例外条件、参照先、失敗・有効化の境界を照合しました。PR #25はマージ済みです。

## CIと保護されたPR統合 — P3-03

`main` の必須チェック登録は3つの名前付きチェックで、各層を担い、パスフィルターはどこにもありません（全てのpull requestで3つ全てが動きます）。

| 必須チェック | ワークフロー | 範囲 |
| --- | --- | --- |
| `core-check` | Core tests | 3 OS × Python 3.11-3.13行列全体のゲートジョブ：Core pytest（parser、CLI、書き込み、notices）、wheel／sdistビルド、bridge＋管理下環境テスト、ツリー外wheel検査、そして `packages/core/tests/test_codex_integration.py` 経由でP3-01 CLI統合スイートを全セルで実行 |
| `planning-check` | Planning checks | `tools/check_planning.py`：日英文書ペア、pin、リンク |
| `extension-check` | Extension tests | 拡張の型検査と単体テスト |

skipされたジョブが必須テストを隠すことはありません。行列のゲートジョブは `if: always()` で動き、行列の結果がちょうど `success` の場合にのみ成功します（失敗・取消・skipは全てゲートを失敗させます）。他の2ワークフローは単一ジョブで、pull requestでskipされうる条件もパスフィルターもありません。

強制の証跡：作業は `codex/*` 機能ブランチからpull request経由でのみ `main` に入ります（本系列では#27〜#36）。2026-10-28、PR #29には失敗したPlanningチェックが2件あり、GitHubはそのPRを `blocked` と表示し、フォローアップコミットでチェックが合格するまでマージは実行できず、その後に状態は `clean` となってマージが進みました。これは、失敗したPRが拒否され、緑のPRが統合可能になることを実際に観測した事例です。保護 *設定* 自体はリポジトリー設定の中にあり、ここで使う自動化からは見えません。本登録は、設定を一目で照合できるよう、必須とすべきチェックを正確に名指しするものであり、上記の挙動証跡が、必須チェックが実際にマージをゲートしていることを示します。実機受入はP3-02として残り、これらのいずれによっても置き換えられません。

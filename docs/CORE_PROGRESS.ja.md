# 初期Core実装 — 2026-10-20

[English](CORE_PROGRESS.md)

## 実装した範囲

P1-01／P1-02としてpackages/coreに実験的Python package、公開API、inspect／extract／validate JSON CLI、safe profile検査、共通の上限制御CairoSVG rendererを追加しました。Phase 1の開始であり、Phase 0全監査やPhase 1全体の完了を宣言しません。build／verify／rebuild、全bridge transport／取消、拡張、管理venv、releaseは未完了です。Phase 0報告・根拠は過去の基準であり、Coreが存在しないとの記述とXML不足3点が未修正との記述について、新packageでは今回の結果が優先します。元の上流実装は変更していません。

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


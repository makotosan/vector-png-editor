# Phase 0調査 — 2026-10-20（Asia/Tokyo）

[English](PHASE0.md)

Core実装前の調査snapshotです。現在の結果と解消したXML不足は[CORE_PROGRESS.ja.md](CORE_PROGRESS.ja.md)に記録し、上流codeとこの基準の根拠は変更していません。

## 1. 根拠と範囲

[8238ebdaa136f448affa53133b99ee5afde5765a](https://github.com/makotosan/vector-png-spec/tree/8238ebdaa136f448affa53133b99ee5afde5765a)に固定した英語SPEC.md、safe-svg-v1、IMPLEMENTATIONS.md、および既存Pythonプロジェクトの[d00dd8800cdf6978ebf1d5c6ae61042c7fbadbc2](https://github.com/makotosan/vector-png/tree/d00dd8800cdf6978ebf1d5c6ae61042c7fbadbc2)にあるvector_png.py、pyproject.toml、requirements、tests、examples、CI、license、OSS review、互換性記録を確認しました。GitHubでsource blob 4828b4bb60a97704161bf71e70eaeff8fc97ef49を確認しています。ローカルでテストした原文のSHA-256はimplementation-reference.jsonに記録します。ローカルのrepositoryフォルダーは未コミットの親Gitリポジトリ内のソースsnapshotであり、独立した上流cloneではありません。それらのフォルダーから履歴を推測していません。

仕様リポジトリは形式・profile文書と有限のテストツールを提供します。再利用する本番Python実装はmakotosan/vector-pngにあり、仕様側のテスト用transformerではありません。今回、上流の形式・実装ファイルは変更していません。Phase 0調査を記録しましたが、P0 Issueは全監査、対応matrix、editor試作の受入条件を満たすまで未完了とします。

## 2. コンテナーとprofileの調査結果

SPEC §§2–3は、キーワードvector-png.svg、flag 1、method 0、zlib UTF-8 SVGの圧縮iTXtをちょうど1つ格納します。JSON wrapper、version field、profile markerを追加しません。PNGのCRC・順序・decode、iTXt／tEXt／zTXtを横断したkeyword重複、APNG拒否、末尾の余分なバイトが要件です。抽出は任意のBOMを含む展開バイトを保持し、XMLでencodingを宣言する場合はUTF-8にする必要があります。

SPEC §4の基準上限はSVG 1,000,000 bytes、PNG 32,000,000 bytes、一辺4096 pixels、総画素4,000,000です。既存コードはこれらの数値とPNG chunk最大10,000を使用します。safe-svg-v1は列挙したSVG要素・属性、local gradient／clip参照、要素5000、深さ32、属性100,000 code pointsのみを許可します。CSS／style、script、image／data URL、hyperlink、use、foreignObject、animation、DTD／entity、外部参照、XML宣言以外の処理命令を拒否します。コメントとescape文字は許可します。既存rendererは外部取得を拒否し、20秒のsubprocessで動作します。OS sandboxや厳密なmemory quotaではありません。

SPEC §§6–7は格納原文とpreviewをPNG IHDR viewportで同時に再生成し、不完全な更新を公開しないことを要求します。コンテナー妥当性、safe profile対応、renderer固有のpreview検証は別の主張です。CairoSVGのRGBA完全一致は既存のローカル方針であり、形式共通の要件や作者認証ではありません。フォント選択はhostに依存します。上流0.2.0の任意normalizationは明示的なimport機能であり、初期safe-svg-v1 editorには不要で、抽出・保存時に自動実行してはいけません。

## 3. 再利用とCLIの不足

| 必須コマンド | 既存の機能 | 必要な作業 |
| --- | --- | --- |
| inspect | JSON inspect。profile検証と描画を実行 | 受動的な発見とprofile／描画検査を分け、結果を別々に報告 |
| extract | CLI extractはreadと描画完全一致を使用 | ローカルraster一致から独立してバイトを保持し、未対応profileを区別 |
| validate | validate_svg Python関数 | 公開CLI、詳細診断、上限制御した構文・描画方針 |
| build | createコマンドとcreate／render／atomic_write関数 | 公開共通Core build経路。新規既定値を上流512×512から1024×1024へ |
| verify | inspect／_matchesのRGBA完全一致 | 専用コマンド。renderer／版／viewport／font／color／alpha／方式の根拠 |
| rebuild | updateコマンド | 原文保持の共通transaction、競合保護、JSON結果 |

現在のCLIは大半のエラーをstderrのtextと終了コード2で報告し、全コマンドがJSONを出すわけではありません。Phase 1でwire v1を変えず版付き構造化protocolと安定した終了コードを定義します。固定したMITの解析・検証・描画・書込コードを1つのCore経由で再利用し、TypeScriptで描画を重複実装しません。移植時は帰属を保持します。該当入力への対応を主張する前に構造監査とbyte処理を修正する必要があります。

## 4. 依存関係・版・ライセンス

既存package 0.2.0はPython >=3.10、Pillow >=11.3,<14、CairoSVG >=2.8.2,<3、defusedxml >=0.7.1,<1を宣言します。これらは範囲指定であり、将来のEditor lockではありません。native Cairoが別途必要で、Python導入だけでは足りません。任意normalizationはtinycss2 >=1.4,<2とPlaywright ==1.64.0／Chromiumを追加します。後に明示採用しない限り、初期editorの依存から省きます。

実装はMITで、著作権・licenseを保持して再利用できます。既存OSS_REVIEWはPillow MIT-CMU、CairoSVG LGPL-3.0-or-later、defusedxml PSF、native Cairo LGPL-2.1／MPL-1.1 dual licenseを記録しています。推移Python／native依存とMonaco noticeは配布前に正確な版で確認が必要です。CoreのMIT licenseで依存を再licenseしません。noticeと配布義務を確認せずnative DLLを同梱しません。

今回使用したのはWindows x64、Python 3.13.5、Pillow 13.0.0、CairoSVG 2.9.1、defusedxml 0.7.1、pytest 9.1.1で、既存の利用者venvとCairo pathを使用しました。system Pythonの導入・変更はしていません。Python 3.11／3.12とclean環境導入は未検証です。上流CIはWindows／macOS／Linux × Python 3.10／3.13を設定していますが、設定や過去の結果でこのeditorの対応は証明できません。P0-03完了までEditorの候補は3.11〜3.13のままです。

## 5. 実行した検査と確認した非互換

既存実装のtest_vector_png.pyとtest_spec_baseline.pyは43件合格、Pillow getdata非推奨警告1件、16.48秒でした。往復、Unicode、alpha、gradient、危険入力、上限、CRC、重複、描画timeout、text回帰を含みます。固定仕様のunittest suiteは10件合格、0.144秒でした。このsuiteは有限のfixture／normalization構造を検査し、本番実装の準拠検証ではありません。最初のsandbox実行は一時folder権限で失敗し、承認済み通常実行で同じ検査が合格しました。いずれも新Editorのtest suiteではありません。

非描画probeで固定PNG fixture全21件に既存_read_document、宣言2例にvalidate_svgを実行しました。結果は[phase0-probes.json](../evidence/phase0-probes.json)、再実行scriptは[phase0_probe.py](../tools/phase0_probe.py)です。container-positive 7件のうち5件は原文byte一致で受け入れられました（単独BOMと異なるpreviewを含む）。unsafe-svgはprofile方針で正しく拒否されました。escaped-and-commentはvalidatorがcomment文字列内で処理命令構文を探すため誤拒否されました。container-negative 14件のうち13件は拒否され、wrong-xml-encodingは誤受入されました。追加probeではBOM＋UTF-8宣言が拒否され、非UTF-8宣言が受け入れられました。これは観測した互換性不足であり、仕様変更案ではありません。probeはSVGを描画せず、preview一致を証明しません。他のコンテナー／profile要件には引き続き要件単位の監査が必要です。APNG fixtureの拒否だけで全APNG markerの拒否は証明できません。

## 6. 次の作業と完了の限界

[20件のIssue](TASKS.md)はP0-01〜P0-04、P1-01〜P1-05、P2-01〜P2-07、P3-01〜P3-04を対象とし、目的、予定パス、実装、依存、受入、testを日英全文で記載します。確認したXMLの3点をP0-01に記録し、P1-02で修正し、共通Core移植前にコンテナー規則を監査します。Phase 0を閉じる前に依存・OS matrixとCustom Editor試作を完了します。[構成](ARCHITECTURE.ja.md)、[互換性](SPEC_COMPATIBILITY.ja.md)、[受入](ACCEPTANCE.ja.md)を参照してください。

安定editor、pip公開、VSIX公開、OS横断実機受入、完全準拠は主張しません。非互換な形式変更や未確定の製品選択には事前に利用者判断が必要で、今回は実装していません。README、Phase 0、構成、互換性、受入の日英の組と全20 Issueの両言語節について、全文の意味、要件、数値、表、code、link、制限を節ごとに照合しました。

## 7. 再実行コマンド

記録した依存とnative Cairoを設定したPython環境を使用します。固定SHAの信頼したsource snapshotを取得し、ここではbaseline-implementationとbaseline-specとします。実装testはそのsource directoryから実行します。上流の構造normalization testには任意依存tinycss2が必要です。

```text
cd baseline-implementation
python -m pytest tests/test_vector_png.py tests/test_spec_baseline.py -q -p no:cacheprovider
cd ../baseline-spec
python -m unittest discover -s tests -v
cd ../vector-png-editor
python tools/phase0_probe.py --source ../baseline-implementation/vector_png.py --fixtures ../baseline-spec/fixtures/vectors.json --output-dir ../phase0-probe-replay
python tools/check_planning.py
```

新しい出力directoryを使用します。probeは信頼したローカル実装codeをimportし、fixture PNGを描画せず解析し、fixtureごとのPNGとresults.jsonを出力します。信頼していないPythonを指定しないでください。結果のsource SHAは正確なローカルbyteを識別し、checkout時の改行変換でGit blobの論理sourceが同じでもhashは変わり得ます。planning checkはpin、日英body項目、組の構造、local linkのみを検査し、翻訳の意味一致や製品の正しさを証明できません。



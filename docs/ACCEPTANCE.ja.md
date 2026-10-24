# 受入とリリース記録

[English](ACCEPTANCE.md)

## 安定版の必須条件

初期安定版完成の前に全行について自動テストとWindows／macOS／Linux実機検証の双方に合格する必要があります。OS／版、Python／native／renderer／VS Code版、成果物版／hash、日付、担当、根拠、失敗を記録します。matrix設定やhosted CI実行だけで実機受入を代替しません。

| 条件 | 現在のEditor状態 |
| --- | --- |
| 既存vector-pngの起動、SVG編集、PNG保存、原文の損失なし再抽出 | 未実装・未検証 |
| PNG構造／順序／CRC、decode raster、preview検証結果の分離 | 実験的Core subsetを検証済み。全container監査とeditor受入は未完了 |
| Monaco強調／補完／検証／検索置換とVS Code undo／redo同期 | 未実装・未検証 |
| 別名保存、revert、backup／hot exit、1024×1024透過新規文書 | 未実装・未検証 |
| Python／native setup失敗、更新／取消、rollbackで元ファイルとdirty編集を保護 | 独立した専用venv APIで失敗・取消・切り戻し・原文保持を検証。拡張・native setup UIとdirty編集受け入れは残る |
| 外部Codex／CLI更新とVS Code未保存編集の双方を保護し競合を通知 | 未実装・未検証 |
| 3 OSでPython 3.11〜3.13のclean導入後、対応matrixを確定 | ローカルWindows Python 3.13 Core／clean wheelを検証。hosted 9組matrixを追加し、実runを確認する |
| local Monaco／CSPを含むoffline package VSIXと独立pip wheel／sdist導入 | Core開発wheel／sdistとclean導入を検証。全6コマンド配布とVSIXは未完了 |
| GitHubタグでtest／build／VSIXとpip成果物の公開、GitHub Releasesからdownload・再導入 | 未設定・未検証 |

現在のCore根拠と残る制限は[CORE_PROGRESS.ja.md](CORE_PROGRESS.ja.md)に記録します。editor実機の全条件は未完了です。

## 作業とbranch方針

[20件のGitHub Issues](TASKS.md)で4 Phaseを管理し、各受入条件を根拠で満たすまで未完了とします。mainをCI成功必須で保護し、機能branchとPRを使用します。Phase 0計画はplanning-check CIのみ追加し、P3-03のCore／拡張／OS suiteの代替にはしません。branch保護設定と実際のremote CI状態はworkflow fileとは別に検証します。文書に要求があるだけで保護が有効とは報告しません。

## 2026-10-20に記録した根拠

既存Windows Python 3.13.5実装subsetは43件合格、非推奨警告1件。固定構造suiteは10件合格。受動互換性probeはfixture 21件と宣言2件で、XML不足3点を確認しました。範囲、版、コマンド、限界は[PHASE0.ja.md](PHASE0.ja.md)を参照してください。これは基準の調査結果であり、Windows、macOS、LinuxのEditor実機承認はありません。3 OSの全必須行に根拠が揃うまで安定版を公開しません。非互換な形式変更または未確定の製品選択が必要になれば実装前に利用者判断を求めます。


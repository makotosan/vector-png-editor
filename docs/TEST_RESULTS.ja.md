# テスト結果 — 実機受入

[English](TEST_RESULTS.md)

## macOS 実施 — 2026-10-29（Issue #18、チェックリスト v2）

- **マシン：** MacBook Air M4、macOS 26.5.2（25F84）、VS Code 1.144.0（arm64）。システム Python は 3.9.6、実施には Homebrew Python 3.13.16 を使用。
- **成果物：** エディタ VSIX「ビルド13」（PR #56 時点、Core wheel 同梱。SHA-256 `1a1d37345dea28ece61fdf44bab93bf638f43d9d4ca7c021595b533e5c335f90`、一致）とプレリリース v0.1.0.dev3 の Core wheel（SHA256SUMS 照合 OK）。
- **実施者：** ユーザーのマシン上の Codex。記入済みチェックリスト v2 を 2026-10-29 にユーザーが提出。
- **判定：** macOS 受け入れは**未完了**。期待結果と異なった3項目（5.7 の FILL の Undo、6.2 の Normalize の Undo、7.1 の Environment Status）を除き、すべて合格。この3件は実施後に原因を特定し、PR #56 ブランチで修正済み（ビルド14）。再確認が残る。

### セクション別結果

- **§1 成果物：** 合格。wheel のチェックサム OK、ビルド13 VSIX のハッシュ一致。
- **§2 CLI／Core：** すべて合格。`validate` は `profile_check: passed`、`verify` は `preview: match`、`inspect` は `kind: vector-png`。抽出したソースはバイト単位で一致（SHA-256 は両ファイルとも `344596ae86b6550bb1073f5a93fdee2bc48b9af890be20e9437643308e164a44`）。壊れたファイルは終了コード 3、`invalid-container`、「Invalid PNG ending」で拒否された。
- **§3 導入と Core なしの確認：** 合格。VSIX はインストールでき、エディタは Open With から起動する（既定のビューア（Office Viewer／Image Preview）が開くのは設計どおりで、エディタは明示選択のまま）。クローンフォルダーは git status が空の状態で開けた。環境セットアップ前に開いた SVG は、分割 UI、描画された Editing プレビュー、無効な PNG ボタンを表示した。コード折りたたみも動作した（シェブロンで範囲が畳める）。プレーン PNG は表示専用で開き、ボタンはなく、SHA-256 は前後とも `60d0e55283e573e7051d0e6aa454cdb432aa58eca87ce702cae1975a7661c474` で不変だった。
- **§4 環境セットアップ：** 合格。同梱 wheel で「Set Up Python Environment」が完了し（environment ready）、Environment Status に管理環境と Effective Python が表示された。このマシンではネイティブ Cairo の追加対処は不要だった。
- **§5 vector-png：** 5.1 合格（生成中メッセージの後に Editing が描画され、PNG 切替で保存済みラスターが表示される）。5.2 合格（閉じて開き直しても再描画され、「Output already exists」は再発しなかった）。5.3 合格（補完。`stop` は `<linearGradient>` 内でのみ候補に出る）。5.4 合格（編集と保存。プレビューが追随し、CLI の `verify` は `preview: match` のまま）。5.5 合格（保存をはさむ Undo／Redo）。5.6 合格（Format が入れ子に応じてインデントし、Copy SVG が現在のソースを貼り付け、Wrap が切り替わる）。5.7 は**背景部分は合格**（プリセット切替でソースもファイルも変わらず、SHA-256 `c8084ad4b147891cb2bdc3c01e110097d42590055e74a91ee93938945b83ecc9` のまま、編集済み表示も付かなかった）が、**FILL の Undo 部分が期待結果と異なる**（所見 F1）。5.8 合格（Export SVG が、保存した PNG から抽出したソースとバイト一致）。5.9 合格（Export Plain PNG：`inspect` は `kind: png`、`extract` は `ordinary-png` で終了コード 7）。5.10 合格（New Document：1024×1024、全画素アルファ 0、`verify` は `preview: match`）。5.11 合格（競合の知らせが表示され、未保存版は `fill="#ff0000"` を保ったまま取り出せ、外部版は SHA-256 `2739d60098bcc08936992c066b56ea15ecff211e2e92c915d3ac80b289cc19cd` のままで `verify` も `preview: match`）。
- **§6 SVG（Issue #47）：** 6.1 合格（`<style>` と `class` を含む SVG が開き、Editing に描画される）。6.2 は**期待結果と異なる**：正規化自体は正常（要約通知が表示され、保存したソースは `profile_check: passed`）だが、Cmd+Z 1回での復帰が効かなかった（所見 F1）。6.3 合格（Export as Vector PNG ボタンで隣に PNG ができ、`verify` は `preview: match`、エディタで開ける）。
- **§7 失敗系：** 7.1 は**期待結果と異なる**（所見 F2）。VS Code とファイルに被害はなかった。

### 所見と処置

- **F1 — ホスト起点の編集が Cmd+Z で取り消せなかった**（項目 5.7 と 6.2）。webview はホストからのソース更新（Normalize SVG、FILL の Apply、ホスト側 Undo／Redo、外部変更の再読み込み）を Monaco の `editor.setValue()` で適用していたが、これは Undo スタックを破棄する。Monaco で打った編集は通常どおり取り消せる（5.5 は合格）。機構は同梱 Monaco 0.57 で検証済み：`setValue` の変更は取り消し不可だが、`editor.executeEdits()` ＋ `pushUndoStop()` は取り消し可能で、フォーカス時のキーボード Undo でも効く。**修正（PR #56）：** `sourceSync` は `editor.executeEdits('vectorPng.hostSync', …)` と `pushUndoStop()` で適用するよう変更。初回ロードは意図的に `setValue` のままとし、開いた直後のソースが空モデルへ取り消せることはない。ビルド14での再確認が残る。
- **F2 — Environment Status が存在しない Python を使えるものとして表示した**（項目 7.1）。`vectorPng.corePythonPath` に `/nonexistent/python3` を設定しても、ステータスはそれを Configured／Effective Python として表示し、無効である旨が示されなかった。**修正（PR #56）：** 設定パス／実効パスが存在しない場合、ステータスに「(file not found)」を付ける。ビルド14での再確認が残る。

### 残る受け入れ範囲

ACCEPTANCE.md の安定版ゲートには Windows と Linux の実機確認も必要です。Windows は 2026-10-29 のユーザー日常利用でかなりカバーされています（開き直し修正を含む Editing プレビュー、パネルのボタンとラベル、管理環境経由の Export PNG）。Linux は未実施です。

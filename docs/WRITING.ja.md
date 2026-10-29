# 実験的な書き込みとプレビュー検証

[English](WRITING.md)

## コマンドと独立した結果

Core 0.1.0.dev2はinspect、extract、validateにbuild、verify、rebuildを追加します。wire形式と仕様の固定リビジョンは変更しません。VS Codeエディター、管理venv、安定版は未実装です。P1-03は一部実装で、コマンドは存在しますが、任意の外部書き込みとの厳密な競合制御とエディター受け入れ検証は残ります。

```text
vector-png-editor build original.svg output.png --width 1024 --height 1024
vector-png-editor verify output.png
vector-png-editor rebuild output.png rebuilt.png
vector-png-editor rebuild output.png output.png --overwrite --expected-sha256 SHA256_FROM_INSPECT
```

buildは変更しないUTF-8原文バイトを受け取り、safe-svg-v1を検査し、明示された出力viewport（既定1024×1024）で描画します。言語・翻訳キーワードが空の圧縮iTXtを1個、IDATの前に書き、BOM、XML宣言、Unicode、コメント、CRLFを保持します。rebuildは上限付きスナップショットを読み、埋め込み原文とIHDRのviewportを使い、SVGを再シリアライズしません。両方とも任意のPNGメタデータを破棄し、rasterに必要なchunkのみ保持します。通常のPNGには再生成・検証する原文がなく、終了コード7になります。

公開前に両ライターは候補をメモリー上で対応範囲のコンテナー検査に通し、埋め込み原文バイトを比較し、再描画して厳密なRGBA8一致を要求します。生成物の不一致は公開せず12で終了します。verifyは書き込まず同じローカル比較を行います。公開Python APIのverify_documentはpreview=matchまたはmismatchを返します。CLI verifyの不一致はok=false、error.code=render-mismatchと、error.details内の完全な比較報告を返し、失敗時の最上位resultはありません。既存JSONの外枠はprotocol 1のまま、schemaにこれらのコマンド、エラーコード、任意のerror.detailsを追加します。

比較報告はcontainer=passed-supported-checks、profile=safe-svg-v1、profile_check=passed、renderer=CairoSVG、renderer_version、viewport、fonts=host-selected、color_alpha=CairoSVG default; transparent background、text_policy=grayscale antialias; hint style/metrics disabled、comparison=exact-rgba8、authenticity=not-checked、PNG／原文SHA-256、原文バイト数を含みます。PNG raster変換はPillow RGBA8で、高ビット深度入力の縮小変換も含み、元の高ビット深度サンプル比較やICC色管理は行いません。不一致はコンテナー不正の根拠、異なるエンジン間の同等性検査、改ざんの証明ではありません。既存のancillary／言語／raster監査の制限は残ります。

## 公開と競合制御の境界

新規出力は同一ディレクトリーの一時ファイル、flush／fsync、上書きしないatomic hard linkを使います。並行して作られたものを含め、既存出力を黙って置換しません。ファイルシステムのhard link対応が必要で、安全でないコピーへのfallbackはありません。公開前の処理可能な失敗・中断では一時ファイルを削除します。生成した原文とrasterは一緒に公開します。

上書きには--overwriteと、保存先のinspectから得た小文字64桁16進数の--expected-sha256トークンの両方が必要です。トークン不一致または保存先ロックの存在は13（conflict）で終了します。片方のみの指定や不正なトークンは2になります。symlinkの保存先は拒否します。ライターはOUTPUT.vector-png.lockを排他的に作成し、既存保存先を検査し、候補を一時保存してfsyncし、独立した元データのスナップショットをOUTPUT.UUID.backupにfsyncして保存し、保存先を再検査してからatomicなos.replaceを使います。成功は保持したバックアップのパスを返し、新規保存成功はbackup=nullを返します。後続の競合・失敗でもバックアップは残り、呼び出し側が保持・確認する必要があります。元の原文と図を含み、自動削除方針はありません。

このロックは同じ保存先パスを使うCoreライター間で協調します。OSのcompare-and-swapではなく、ロックを無視する外部アプリは最終検査と置換の間に書き込んだり、別名からファイルを変更したり、開いたハンドルからinodeを変更したりできます。そのようなすべての並行バージョンの厳密な保持は保証しません。外部で編集中のファイルには別名保存を使ってください。独立したバックアップは後からの同一ファイルへの書き込みからも取得済みの元データを保護しますが、この競合窓は解消しません。危険なディレクトリーやパス差し替え、権限・所有者の保持、プロセス終了後の古いロックの復旧、ディレクトリー更新をまたぐクラッシュ耐久性は未実装です。古いロックは安全側に失敗し、実行中プロセスを調べて手動復旧します。より強いplatform固有の競合制御とエディターテストのため、P1-03／P2-06は未完了です。

## エラー、上限と検証根拠

追加終了コードは12 render-mismatch、13 conflict、14 cancelled（処理したKeyboardInterrupt）です。既存のCLI契約を補います。強制プロセス終了は処理可能な取消ではなく、一時ファイルや古いロックが残り得ます。atomic公開境界の後の取消では、完全なファイルがすでに確定している場合があります。bridge取消とsubprocess出力の上限制御はP1-04に残ります。描画は既存のsubprocess 20秒timeoutとnative依存・安全性の制限を使用し、OS sandboxや厳密なmemory quotaはありません。原文／PNG／画素／複雑度上限は変更しません。safe profile拒否、描画timeout、模擬ディスク失敗、候補不一致、公開前中断について元ファイル保持をテストします。

テストはUnicode／BOM／CRLF原文往復、build／verify／rebuild、コンテナーと比較の結果を分離した異なるraster、明示上書きとバックアップ、古いリビジョン、協調ロック、並行作成された新規出力、置換前に検出した外部変更、通常PNGの拒否を対象とします。clean wheelのsmoke検証はソースツリー外で6コマンドすべてを実行します。hosted CIはOS／Pythonの9組を保持し、Core CIをPRとmain pushで実行して、同名の必須チェックを持つfeature branch push／PRの二重実行を避けます。現在の実行根拠は[CORE_PROGRESS.ja.md](CORE_PROGRESS.ja.md)に記録し、workflowの存在を成功結果とはしません。形式の完全準拠、任意ライターとの競合制御、実機エディター受け入れ完了は主張しません。

# 仕様互換性記録

[English](SPEC_COMPATIBILITY.md)

## 基準と主張

[8238ebdaa136f448affa53133b99ee5afde5765a](https://github.com/makotosan/vector-png-spec/tree/8238ebdaa136f448affa53133b99ee5afde5765a)の英語SPEC.mdが正規仕様、SPEC.ja.mdは全文の参考訳です。[spec-reference.json](../spec-reference.json)と[implementation-reference.json](../implementation-reference.json)を参照してください。これは過去の上流調査と[CORE_PROGRESS.ja.md](CORE_PROGRESS.ja.md)・[CLI.ja.md](CLI.ja.md)に記録した現在の実験的Core作業を扱います。新CoreはXML不足3点を解消し、受動発見とprofile／描画を分離し、PNG／rasterの明示検査を追加しましたが、ancillary／language／raster監査は未完了です。完全準拠は主張しません。wire v1は変更せず、既存ファイルの形式移行は不要です。

## 過去の上流要件の状態

以下の行は元の上流基準を記録します。新packageではXML回帰3点を修正し、受動読取と共通描画を実装しました。現在の上限、対応検査、test、残る監査は過去の行から推測せず、[CORE_PROGRESS.ja.md](CORE_PROGRESS.ja.md)を参照してください。

| 要件 | 根拠・残る作業 |
| --- | --- |
| SPEC §2 PNG妥当性／順序／CRC／APNG | 既存のCRC、keyword重複、末尾、rasterテストは合格。全順序、未知critical chunk、全APNG marker、raster subsetは未監査。APNG fixture 1件の拒否では不十分。P0-01／P1-01／P1-02。 |
| SPEC §3 圧縮iTXt／UTF-8 | 21-fixtureの受動probeでbasic／source-after-idat／language-fields／単独BOMを原文一致で受入。誤ったtype／compression／method／末尾zlib／不正UTF-8を拒否。広範なzlib／language制約は監査が必要。 |
| SPEC §3 XML原文 | wrong-xml-encodingを受入、escaped-and-commentを拒否、BOM＋UTF-8宣言を拒否した。安全性を弱めず3点を修正する。XML再serializeや自動normalizationは行わない。P0-01／P1-02。 |
| SPEC §4 有限上限／結果 | SVG／PNG／pixel数値上限は基準に一致し、上流chunk上限は10,000。profileは要素5000／深さ32／属性長100,000。構造化エラー分離とallocation範囲には監査が必要。P1-02／P1-04。 |
| SPEC §5 safe-svg-v1 | 既存allowlist／参照制限と危険入力テストは有限の根拠。profile拒否とcontainer-invalidを区別する。DOM実行・発見、外部取得を禁止。全profile監査はP0-02で実施。 |
| SPEC §6 原文／preview transaction | 既存create／updateは再生成しatomic_writeで公開する。editorのbyte保持保存、競合race、backup、crash／失敗対応は未実装。P1-03／P2-04／P2-06。 |
| SPEC §7 preview整合性 | 既存CairoSVG RGBAのローカル完全一致は厳しい独自方針。different-previewはcontainer-validで、受動probeで受入し描画はしていない。engine／版／viewport／font／color／alpha／方法または未検証を報告。真正性や汎用画素一致を主張しない。 |
| SPEC §8 識別／進化 | 必須suffix／profile fieldではなくPNG signature／内容とvector-png.svgで識別する。Editor製品v1.0は新wire版ではない。非互換変更には別の上流提案と利用者判断が必要。 |

## 根拠の限界

[Phase 0](PHASE0.ja.md)にWindows／Python 3.13の実装43件と固定構造10件の合格、およびコンテナー21件＋XML 2件のprobeによる上記不足を記録します。[probe生結果](../evidence/phase0-probes.json)は準拠合格数とせず受入・拒否をそのまま保持します。危険SVGもcontainer-validであり得て、preview一致は独立です。Python 3.11／3.12、全OS対応、拡張host動作、全実機受入は未検証です。任意の上流normalizationを自動でeditorへ移植しません。後続変更では仕様節、fixture、結果、互換性影響、日英全文更新を記録してください。


現在の書込範囲（SPEC §§3〜7）：変更しないUTF-8原文の正規圧縮iTXt、IHDR viewport生成、候補検証と厳密なローカルRGBA8検証、明示上書き・バックアップ、協調競合制御を実装しました。任意の外部ライターとの競合、クラッシュ耐久性、エディター保存は残り、[WRITING.ja.md](WRITING.ja.md)を参照してください。wire・固定基準の変更や完全準拠の主張はありません。

bridge追加：0.1.0.dev3でprotocol-1 stdin要求、正確なinline原文、厳密な上限付きdecode、TypeScript制御・古い結果の拒否、読み取り専用環境診断を実装しました。[BRIDGE.ja.md](BRIDGE.ja.md)を参照してください。ファイル形式、renderer方針、仕様固定、書込競合制御は変更しません。P1-04のnative・推移的依存固定、穏当なworker取消、描画出力上限、更新・切り戻しは残ります。

専用環境管理の追加：別のTypeScript APIで、レビューしたPythonアプリ依存のversion lockの導入、新しい不変venvの健全性検査、atomic有効化、検証済み切り戻しに対応しました。[INSTALL.ja.md](INSTALL.ja.md)を参照してください。native・成果物hash、VS Code setup・dirty編集連携、完全なrenderer制御は残ります。wire v1、仕様固定、Coreライター、standalone pipの既定依存動作は変更しません。

safe-svg-v1スキーマ追加（Issue #22、SPEC §5）：プロファイルをCoreと全点照合し、allowlist全体（要素18・属性51・値と参照の規則・上限）で一致を確認しました。機械可読なpolicyが、Relax NGスキーマ、AI生成ルール、Monacoメタデータ、ハッシュ付きmanifestを生成し、ずれ検出テストがこれを守ります。診断Validatorは全ての違反を位置と修正提案つきで報告します。Coreの受理は変更せず、スキーマ層の内容モデルは `validate --profile safe-svg-v1` の生成ゲートでのみ有効なため、既存の有効なファイルへの影響はなく、wire・固定基準の変更もありません。証拠：CoreスイートのSC-01からSC-09、SC-11、SC-12。Phase 2（skills/vector-png/SKILL.mdのSkill手順、生成メタデータを消費し内容モデルの子補完を行うMonaco連携）とSC-10（生成・検証・build・verifyのエンドツーエンド、失敗時に上書きしない規則を含む）を実装しました。[SAFE_SVG_V1.ja.md](SAFE_SVG_V1.ja.md)を参照してください。

P0監査深掘りの続報（Issue #1／#2、SPEC §§2-4、6-8）：チャンクの順序とAPNGマーカー、未知のcritical／ancillaryチャンク、テキストチャンク種別をまたぐキーワード重複、zlibストリームの完全性、言語タグと翻訳キーワード、上限のエラー分類、パレット／グレースケール／Adam7ラスターの広さ、rebuild時のメタデータ非保持、透明度の正確さ、外部参照の拒否、タイムアウトの分類、inspect／verifyの主張分離について、要件レベルのプローブを追加しました（50件、すべて合格。[PHASE0.ja.md](PHASE0.ja.md) の日付付き節を参照）。挙動、固定、主張の変更はありません。明示的な未監査項目を1件記録します。iTXt言語タグのBCP 47レジストリレベルの検証は行われていません（現在はASCIIのみの確認）。厳格化は自動変更ではなく利用者の判断です。

BCP 47判断の続報（Issue #1）：2026-10-28に、利用者はwire v1についてリーダーの現在の寛容な言語タグの挙動（ASCII確認のみ、BCP 47レジストリ検証なし）を維持すると判断しました。監査項目は記録された判断として閉じます。挙動は変わりません。

svg-normalization-v1の取り込み（Issue #48、同じ固定8238ebdaにおける正規化プロファイル§§1-8）：Coreに実験的な入力処理プロファイルを明示的コマンド `normalize input.svg output.svg --report report.json` と `convert input.svg output.png --report report.json` として実装しました（protocol-1 JSONトランスポートからも到達可能）。実装内容：§2の入力検証とベースライン上限、§3の閉じたCSS部分集合に対する手書きのCSSトークナイザ／パーサー（盲目的なセミコロン分割はせず、tinycss2はCoreの依存ではありません）、§3.1の制限付き矢印マーカー展開、§4のカスケード／継承（勝利宣言をプレゼンテーション属性として実体化し、出力をsafe-svg-v1で完全再検証）、§5のアクセシビリティ移行（除去したすべてのrole／aria-*属性を移行先または損失理由つきで記録）、§6の変換前後描画ゲート（既存の制限付きCairoSVGレンダラーでデコード済みRGBA完全一致、ステージング済みno-clobber公開、入力は決して変更しない）、§7の変換レポートと同プロファイルの失敗コード（invalid-xml、unsafe-input、unsupported-css、invalid-reference、resource-limit、output-exists、output-alias、render-error、render-mismatch）、§8のconvert経路（正規化ゲートを先に実行し、続いて既存ライターとコンテナー検査を行い、結果を分けて記録）。仕様フィクスチャは出所注記つきでpackages/core/tests/fixtures/normalizationへ逐語的に取り込みました。カタログ24件すべてが期待どおりの失敗コードで合格し、合成銘板の出力はnameplate.expected.svgとバイト単位で一致し、解析で決まるレポート項目はnameplate.expected-report.jsonと一致します。Coreスイートに正規化テスト62件を追加しました（スイート全体：245件合格、1件スキップ、Python 3.13）。利用者の実ファイル9件に対するコーパス検証（ローカルの証拠のみ、コミットしません）：6件が描画ゲート合格で正規化に成功し、ce-marking-qr-nameplate.svgは `letter-spacing` のみで失敗し（unsupported-css。同プロパティは§3の表になく、safe-svg-v1の属性にも存在しません。仕様側の不足G1、makotosan/vector-png-spec#3）、ISO 7010の2件は曲線（Cセグメント）のmarker-endホストのみで失敗しました（未対応のマーカー形状、仕様側の不足G2）。解釈の選択を2件記録します。font-familyの単語はプロファイル本文に従い（引用符なしの先行ハイフン名、例：-apple-system、および最初の文字に制限のない引用符付き名を受け入れます。フィクスチャツールの狭いパターンは採用しません。仕様側の不足G3）、マーカ三角形の閉路コマンドは小文字zも受け入れます（SVGでは同一のコマンドです）。互換性への影響：safe-svg-v1の受理は全面的に不変であり（build／保存／validateの判定、SC-03、許可リスト）、wire v1と仕様固定も変更しません。正規化はこの明示的なインポート操作としてのみ実行され、読み取り・抽出・保存時に自動では決して行いません。上流の正規化を「自動でeditorへ移植しない」という以前の記述は、この意図的で明示的な意味においてのみ置き換えられます。有限のフィクスチャと9件のコーパスは証拠であり、任意のCSS付きSVGへの完全準拠の証明ではありません。

svg-normalization-v1改訂の続報（Issue #48／#22、makotosan/vector-png-spec#3を追跡）：仕様リポジトリで並行して起草中の3件の仕様改訂に対する、エディター側の実装です。本変更はそれらを先行実施するものであり、固定は更新しません。G1：`letter-spacing` を、固定に先行してsafe-svg-v1のプレゼンテーション属性として追加しました。Coreのallowlistは51→52属性となり、policyと再生成したRNG／rules／Monaco／manifest成果物に反映し、`profile_check.py` が共有します。拡張機能側のミラー済みプロファイルデータも一致するよう更新しました。正規化§3の表に同プロパティを加え、文法は「符号つき10進数、任意でpx。キーワード `normal` は受理しません」とし、他のプロパティと同様に実体化され、ゲートではCairoSVGが描画します。G2：正規化§3.1のホストパスで、M/L/H/Vに加えて絶対Cセグメントを使用可能としました（S/Q/Tと他の全コマンドは引き続き拒否）。3次セグメントの最終接線は終点から第2制御点を引いたものとし、前者がゼロの場合は終点から第1制御点を引いたものへフォールバックし、両方ゼロの場合は縮退したマーカー形状として拒否します。他の§3.1の制限はすべて不変です。G3：挙動の変更はありません。実装は既にfont-family名についてプロファイル本文に従っており、-apple-systemと二重引用符つき名を含むリストを対象とする固定テストを追加しました。影響する仕様の節：safe-svg-v1の属性一覧（G1）、正規化§3（G1／G3）と§3.1（G2）。証拠：Coreスイート255件合格、1件スキップ（Python 3.13。本変更前のベースラインは245件合格、1件スキップ）。新しい合成改訂ケース3件（letter-spacing、curved-marker-host、font-family-system-names。仕様リポジトリへ追加中のフィクスチャと同一のidと入力）が受理され、`validate --profile safe-svg-v1` はletter-spacingのファイルを受理し、class/styleを引き続き拒否します。拡張機能スイートは、再生成したMonacoメタデータで79件合格、8件スキップ、0件失敗、TypeScript検査もクリーンです。利用者の実ファイル9件に対するコーパス検証（ローカルの証拠のみ、コミットしません）：9件すべてが描画ゲート合格で正規化に成功し、入力は前後でバイト単位で同一でした。銘板のletter-spacingは `letter-spacing="1px"` として実体化され、曲線のISO 7010ホストは§3.1の接線で展開され（例：M315 170 C365 170 375 210 425 225ホストで rotate(16.6992)）、レンダラーのネイティブマーカーと一致するため、ゲートは不一致なしで合格します。固定済みフィクスチャの期待1件は意図的に置き換えられます。取り込み済みカタログのケース `unsupported-marker-host`（曲線ホスト）は改訂前の拒否を保持していましたが、現在は正規化されます。フィクスチャデータ自体は逐語的なまま保持し、上書きは、固定更新でカタログが置き換わるまでテスト内に記録します。互換性への影響：v1の受理は正確に1属性（`letter-spacing`）だけ広がり、`class`／`style` と他のすべての拒否は不変で、wire v1も変更しません。spec-reference.jsonの仕様固定は本変更では更新**しません**。固定更新は、仕様改訂が makotosan/vector-png-spec#3 でマージされた後の別ステップであり、その際に置き換えられたフィクスチャカタログもあわせて差し替えます。

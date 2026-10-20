# 仕様互換性記録

[English](SPEC_COMPATIBILITY.md)

## 基準と主張

[8238ebdaa136f448affa53133b99ee5afde5765a](https://github.com/makotosan/vector-png-spec/tree/8238ebdaa136f448affa53133b99ee5afde5765a)の英語SPEC.mdが正規仕様、SPEC.ja.mdは全文の参考訳です。[spec-reference.json](../spec-reference.json)と[implementation-reference.json](../implementation-reference.json)を参照してください。これは上流コードの調査記録で、新Editor Coreは未実装であり、完全準拠は主張しません。wire v1は変更せず、既存ファイルの形式移行は不要です。

## 要件の状態

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


# safe-svg-v1：実装対応表とv1.2スキーマ層

[English](SAFE_SVG_V1.md)

## Phase 0 — プロファイルの実態（2026-10-28調査）

規範プロファイルは makotosan/vector-png-spec の `profiles/safe-svg-v1.md` で、リビジョン 8238ebdaa136f448affa53133b99ee5afde5765a（draft 0.1）に固定されています。仕様は「初期Python実装の機能サブセットを記述する」と述べており、Core実装（`packages/core/src/vector_png_editor/svg.py` と `_backend.py`、makotosan/vector-png@d00dd88 から適応）は、直接比較により全ての点で一致することを確認しました。

| 領域 | 仕様とCoreの一致 |
| --- | --- |
| 要素 | SVG名前空間の18要素（svg、g、defs、title、desc、path、rect、circle、ellipse、line、polyline、polygon、text、tspan、linearGradient、radialGradient、stop、clipPath）。それ以外は拒否 |
| 属性 | 修飾なし51属性。未知または名前空間修飾つき属性は拒否（したがって `class`、`style`、`href`、イベントハンドラーは全て対象外） |
| 値 | 全ての属性値で、バックスラッシュ、@、波括弧、セミコロン、山括弧、NUL、TAB/LF/CR以外の制御文字を禁止。値あたり最大100,000コードポイント |
| 参照 | `url(#ID)` のみ。fill/strokeではローカルgradientへ、clip-pathではローカルclipPathへ。idは `[A-Za-z_][A-Za-z0-9_.-]*` に一致し一意。リソース定義内部の参照は禁止 |
| 構造 | UTF-8のみ。DTD・実体・処理命令なし。コメントと任意のUTF-8 XML宣言は可。ルートはSVG名前空間の `svg` |
| 上限 | 原文1,000,000バイト、要素5,000、深さ32 |
| 数値、色、パスデータ、transform、フォント | allowlistでは **検証しません**。仕様はこれらを有界レンダラーへ割り当てています（「数値・パス構文は有界レンダラーを通じて検証する」）。CairoSVGが描画時に受理・拒否し、フォント選択はホスト依存です |
| 親子関係 | 仕様は **何も** 定義せず、Coreも強制しません |

記録する差異とリスク：(1) allowlistの表面では仕様と実装の差異は現在ありません。リスクは *ずれ* であり、policy同一性テストがこれを守ります。(2) ファイルはプロファイル検証を通っても描画に失敗し得ます（不正な数値・パスデータ）。そのため `--syntax-only` なしの `validate` は描画も行います。(3) CLI命名：本製品の出荷済みコマンドは `vector-png-editor validate <file.svg>`（呼出ごとにJSON封筒1つ、docs/CODEX.ja.md参照）であり、v1.2形式の `validate --profile safe-svg-v1 --json` は既存CLI上の `vector-png-editor validate <file.svg> --profile safe-svg-v1` として実現します。そこではJSONは無条件であり、出荷済みバイナリの改名は機能的利益なく文書化済みワークフローを壊します。

## Phase 1 — スキーマ層

`schemas/safe-svg-v1.policy.yaml` が、機械可読な単一の規範データです。`tools/generate_safe_svg_schemas.py` がそこから次を生成します。

- `schemas/safe-svg-v1.rng` — Relax NG構造スキーマ（要素、属性名、idパターン、下記の内容モデル）。
- `schemas/safe-svg-v1.rules.md` — AI呼出向け生成ルール。
- `schemas/safe-svg-v1.monaco.json` — 補完・診断用メタデータ。
- `schemas/safe-svg-v1.manifest.json` — プロファイル版数と、policyおよび全生成物のSHA-256。

Coreのテストが、policy、生成物、実装自身のallowlistの間のいかなるずれも失敗として検出します。

**意図的な2層構成。** Coreの受理（build／保存）は上記の仕様プロファイルそのままに保たれるため、既存の有効なファイルは全て動き続けます（SC-12）。スキーマ層は *内容モデル*（どの要素がどの要素の中に現れてよいか。例えば `stop` はgradientの中だけ）を、生成のための著述制約として追加します。新しい診断Validator（`profile_check.py`）は、全ての違反を severity／code／element／attribute／line／column／message／suggestion つきで報告します。互換モードではその判定はCoreと一致し、`validate --profile safe-svg-v1` では内容モデルも強制されるため、AI生成SVGはPNGが書かれる前に、より厳格な構造へ従うことを求められます。検証に失敗しても既存PNGには触れず、書込み経路はリビジョン確認つきの原子的なbuildのままです（P1-03／P2-04）。

## Issue #22 に対する状態

Phase 0とPhase 1を実装し、SC-01からSC-09、SC-11、SC-12を `packages/core/tests/test_safe_svg_schema.py` で検証しました。Phase 2（Codex Skillの文面、エディターでのMonacoメタデータ消費）とSC-10のエンドツーエンド生成実行が残ります。SC-10の機構自体はP3-01のCLI往復テストで既にカバーされています。

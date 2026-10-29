# vector-png Editor

[English](README.md)

PNG内のSVGを編集するVS Code拡張です。Core（packages/ts-core）はTypeScriptで拡張ホスト内にインプロセス動作し、Pythonコンポーネントも独立CLIもありません。SVGを正本、PNGラスターを派生データとします。状態は実験的段階で、エディタはTypeScript Coreによるinspect／extract／validate／build／rebuild、svg-normalization-v1、resvg描画を提供し、安定版の条件は受入記録のとおり未完了です。

- [インストール（Python不要、セットアップなし）](docs/INSTALL.ja.md)
- [書き込みと競合制御の境界](docs/WRITING.ja.md)
- [Python Coreの進捗と根拠（歴史的記録）](docs/CORE_PROGRESS.ja.md)
- [Phase 0調査結果](docs/PHASE0.ja.md)
- [構成と確定製品要件](docs/ARCHITECTURE.ja.md)
- [互換性記録](docs/SPEC_COMPATIBILITY.ja.md)
- [受入・リリース条件](docs/ACCEPTANCE.ja.md)
- [20件のPhase・タスクIssueと依存関係](docs/TASKS.md)

[spec-reference.json](spec-reference.json)の固定リビジョンにある英語SPEC.mdを形式の正規仕様とし、SPEC.ja.mdを全文の参考訳とします。Editor v1.0引き継ぎ仕様は製品計画の名称であり、新たな保存形式の版ではありません。再利用の基準は[implementation-reference.json](implementation-reference.json)に記録します。完全準拠は主張しません。

作業は機能別branchからmainへのPRで行います。main保護でCI成功を必須にします。最初のREADMEが初期化用の唯一のmain直接コミットであり、Phase 0と初期CoreはPRで統合しました。後続作業はcodex/機能branchで行います。安定版完成には自動テストとWindows／macOS／Linux実機テストの双方が必要です。未実施項目は受入記録を参照してください。


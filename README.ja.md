# vector-png Editor

[English](README.md)

PNG内のSVGを編集するVS Code拡張＋Python Core＋独立したpip CLIです。SVGを正本、PNGラスターを派生データとします。状態はPhase 0の調査と引き継ぎ計画であり、動作するエディターや安定版ではありません。

- [Phase 0調査結果](docs/PHASE0.ja.md)
- [構成と確定製品要件](docs/ARCHITECTURE.ja.md)
- [互換性記録](docs/SPEC_COMPATIBILITY.ja.md)
- [受入・リリース条件](docs/ACCEPTANCE.ja.md)
- [20件のPhase・タスクIssueと依存関係](docs/TASKS.md)

[spec-reference.json](spec-reference.json)の固定リビジョンにある英語SPEC.mdを形式の正規仕様とし、SPEC.ja.mdを全文の参考訳とします。Editor v1.0引き継ぎ仕様は製品計画の名称であり、新たな保存形式の版ではありません。再利用の基準は[implementation-reference.json](implementation-reference.json)に記録します。完全準拠は主張しません。

作業は機能別branchからmainへのPRで行います。main保護でCI成功を必須にします。最初のREADMEは初期化用の唯一のmain直接コミットであり、その後の作業はcodex/phase0-handoffで提案します。安定版完成には自動テストとWindows／macOS／Linux実機テストの双方が必要です。未実施項目は受入記録を参照してください。


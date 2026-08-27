# Windows向け Codex AgentMemory

OpenAI Codex Desktop と Codex CLI のための、独立した Windows ネイティブの
AgentMemory ダウンストリームです。

[English](../README.md) | [한국어](README.ko-KR.md) | [日本語](README.ja-JP.md)

[![Windows向け Codex AgentMemory](../assets/social-preview.png)](../assets/social-preview.png)

> [!IMPORTANT]
> このリポジトリは、ソースのみを提供する Technical Preview
> `0.1.0-preview.1` です。
> [AgentMemory](https://github.com/rohitg00/agentmemory) `v0.9.29` を基に
> していますが、公式アップストリームリポジトリでも、`@agentmemory/*` の
> npm リリースでもなく、アップストリームによるサポートを約束するものでも
> ありません。アップストリームの `npx` コマンドや互換性用プラグイン
> manifest を、以下の Windows ビルド・インストール手順の代わりに使用しないで
> ください。

開発注記: このダウンストリームは AI 生成・ユーザーテスト済みです。[開示
全文](#ai-開発に関する開示)を参照してください。

> **Windows で Codex を使って評価する**
>
> ネイティブ Windows でこのリポジトリを Codex で開き、[`INSTALL_FOR_AGENTS.md`](../INSTALL_FOR_AGENTS.md) に従うよう依頼してください。このランブックは、固定されたネイティブ入力とソースチェックアウトを検証し、インストーラーを既定で dry-run／検証専用モードに保ち、実際の cutover のために `-Execute` を追加する前に明示的な承認を要求します。ハッシュ、所有権、パス、マニフェスト、または既存インストール状態に不一致があれば停止してください。

## このプレビューで提供するもの

- `SessionStart`、`UserPromptSubmit`、`Stop`、`SessionEnd` の4つの管理対象
  Codex hook で、メインエージェントの通常のユーザー入力と最終回答を取得します。
- 周辺 UI 状態、タイトル・fork 通信、既知の内部ホスト prompt、subagent 通信は
  永続取得から除外します。
- 書き込み、削除、curation、provenance は、厳密に現在のプロジェクトだけを
  対象にします。
- プロジェクト横断の読み取りは件数を制限し、出典プロジェクトを表示します。
  wildcard 書き込みは許可しません。
- 任意で、認証情報を必要としない loopback 専用のローカル Qwen を typed graph
  抽出だけに使用できます。その他の LLM 機能は noop provider を使用し、外部
  fallback は無効のままです。
- サポート対象プロファイルは認証済み loopback MCP endpoint を使用します。
  stdio launcher は互換性経路としてのみパッケージに含まれます。

アップストリーム互換のソース surface には、56個の MCP tools、6個の
resources、3個の prompts、port 3111 の133個の REST endpoints、12個の
portable hooks、17個の skills があります。サポート対象の Windows
プロファイルで意図的に有効化する管理対象 hook は、上記の4つだけです。

## バージョンの区別

| 区分 | 値 | 意味 |
|---|---:|---|
| 公開ダウンストリーム版 | `0.1.0-preview.1` | 公開リポジトリ版とソース tag |
| AgentMemory 互換版 | `0.9.29` | CLI、MCP、package、API、export、インストール済み runtime の互換性 |
| 検証リビジョン | `r32` | 内部 build provenance。公開バージョン系列ではありません |
| iii engine | `0.11.2` | ビルド時に SHA-256 を検証する固定 Windows 入力 |

正確なアップストリームの tag、commit、tree、元の package hash は
[`upstream-source.json`](../upstream-source.json) に記録されています。

## 必要な環境

- PowerShell 5.1 以降を備えた Windows。このプレビューは Windows 11 で検証済み
- Node.js 20 以降
- リポジトリで固定された pnpm `11.19.0`
- [`third-party-inputs.json`](../packaging/windows-codex/config/third-party-inputs.json)
  の SHA-256 と一致する、公式 iii engine `0.11.2` Windows 実行ファイル

最初のソース公開版には、ビルド済みまたは署名済みの installer を添付しません。

## ソースからビルドする

Windows PowerShell で次を実行します。出力ディレクトリは事前に存在していては
いけません。

```powershell
git clone https://github.com/M-T-D-N/agentmemory-codex-windows.git
Set-Location agentmemory-codex-windows

& .\packaging\windows-codex\Build-WindowsCodex.ps1 `
  -OutputDirectory D:\staging\agentmemory-codex `
  -IiiEnginePath D:\inputs\iii-0.11.2.exe
```

通常のビルドは、native 入力の hash、固定 lockfile、skill の整合性、typecheck、
build、package test、Codex adapter test、production dependency tree、全
immutable-file manifest を検証します。

installer は既定で dry-run です。ファイル hash、所有権、正確なパス、既存の
インストール状態を確認するだけです。`-Execute` を使用する前に、英語の
[`Windows/Codex 運用ガイド`](../packaging/windows-codex/README.md) にある build、
cutover、rollback、保持、認証の契約をすべて確認してください。

> [!WARNING]
> この installer は、所有権を確認できる管理対象 AgentMemoryCodex サービス配置を
> 対象としています。無関係なディレクトリに適用したり、build 出力をユーザー
> データとして扱ったりしないでください。正規の `data`、秘密情報、log、task
> identity、rollback 資料には、それぞれ独立したライフサイクルがあります。

## プライバシーとセキュリティの境界

- サポート対象プロファイルの MCP とサービス通信は、認証済み loopback endpoint
  内にとどまります。
- 任意の Qwen provider は認証情報を持たない loopback HTTP だけを許可し、graph
  抽出に機能を限定します。
- 公開ソースには、memory database、session transcript、ユーザー export、API key、
  生成済み installer、個人開発の Git 履歴を含めません。
- セキュリティ上の問題は GitHub の非公開脆弱性報告機能で報告してください。
  詳細は [`SECURITY.md`](../SECURITY.md) を参照してください。

## リポジトリ構成

| パス | 役割 |
|---|---|
| `src/` | AgentMemory 互換ソース |
| `packaging/windows-codex/` | サポート対象の Windows/Codex adapter、builder、installer、test |
| `plugin/` | ソース build に含まれるアップストリーム互換 assets。サポート対象のインストール経路ではありません |
| `test/` | 単体・セキュリティ regression test |
| `benchmark/`、`eval/` | アップストリーム由来の harness と過去の参考結果。Windows 公開版の検証結果ではありません |
| `integrations/` | 互換性 integration。独立してサポートするダウンストリーム製品ではありません |
| `upstream-source.json` | 正確なアップストリーム provenance |

アップストリームの宣伝 website、cloud 配布例、その他のアップストリーム言語版、
生成 build 出力、個人 monorepo 履歴は、最初の公開リポジトリに含めません。過去の
benchmark 資料は再現性の参考としてのみ残し、その数値をこのダウンストリーム
公開版の性能主張には使用しません。

## 開発時の検証

```powershell
pnpm install --frozen-lockfile
pnpm run skills:check
pnpm run typecheck
pnpm run build
pnpm test
node packaging/windows-codex/tests/codex-turn.test.mjs
```

package manifest は、アップストリームの `@agentmemory/*` 名義で誤って公開される
ことを防ぐため `private` に設定されています。コントリビューション方法は
[`CONTRIBUTING.md`](../CONTRIBUTING.md)、ダウンストリームの変更履歴は
[`CHANGELOG.md`](../CHANGELOG.md) を参照してください。

## AI 開発に関する開示

ダウンストリーム変更の大部分は、ユーザーが提示した要件と反復的な受け入れ
要求に基づき、OpenAI Codex が生成・修正しました。リポジトリ所有者はソース
コードを手作業で読んだりレビューしたりしていません。検証は、所有者の
Windows/Codex 環境で実施した自動テストと実機能テストに基づきます。独立した
第三者によるコードレビューまたはセキュリティ監査は実施されていません。

**要約:** AI 生成、ユーザーテスト済み、手動コードレビュー未実施です。

## アップストリーム表記とライセンス

このダウンストリームは、Rohit Ghumare と AgentMemory contributors による
AgentMemory を基にしています。表記と正確な元ソース情報は
[`NOTICE`](../NOTICE) と [`upstream-source.json`](../upstream-source.json) にあり、
コードは [Apache License 2.0](../LICENSE) の下で提供されます。

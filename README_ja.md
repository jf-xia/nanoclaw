<p align="center">
  <img src="assets/nanoclaw-logo.png" alt="NanoClaw" width="400">
</p>

<p align="center">
  エージェントをローカルのグループ別ワークスペースで実行するAIアシスタント。軽量で、理解しやすく、あなたのニーズに合わせて直接コードで調整できます。
</p>

<p align="center">
  <a href="https://nanoclaw.dev">nanoclaw.dev</a>&nbsp; • &nbsp;
  <a href="README.md">English</a>&nbsp; • &nbsp;
  <a href="README_zh.md">中文</a>&nbsp; • &nbsp;
  <a href="https://discord.gg/VDdww8qS42"><img src="https://img.shields.io/discord/1470188214710046894?label=Discord&logo=discord&v=2" alt="Discord" valign="middle"></a>&nbsp; • &nbsp;
  <a href="repo-tokens"><img src="repo-tokens/badge.svg" alt="34.9k tokens, 17% of context window" valign="middle"></a>
</p>

---

<h2 align="center">Native Runtime</h2>
<p align="center">各エージェントはローカルの子プロセスとして起動します。<br>イメージビルド不要、セットアップが単純、実行コードとリポジトリの差分がありません。</p>

---

## NanoClawを作った理由

[OpenClaw](https://github.com/openclaw/openclaw)は素晴らしいプロジェクトですが、理解しきれない複雑なソフトウェアに自分の生活へのフルアクセスを与えたまま安心して眠れるとは思えませんでした。OpenClawは約50万行のコード、53の設定ファイル、70以上の依存関係を持っています。セキュリティはアプリケーションレベル（許可リスト、ペアリングコード）であり、真のOS レベルの分離ではありません。すべてが共有メモリを持つ1つのNodeプロセスで動作します。

NanoClawは同じコア機能を提供しますが、理解できる規模のコードベースで実現しています：1つのプロセスと少数のファイル。エージェントはローカル子プロセスとして起動し、グループごとの作業ディレクトリとセッション状態を分けて扱います。

## クイックスタート

```bash
gh repo fork qwibitai/nanoclaw --clone
cd nanoclaw
copilot
```

<details>
<summary>GitHub CLIなしの場合</summary>

1. GitHub上で[qwibitai/nanoclaw](https://github.com/qwibitai/nanoclaw)をフォーク（Forkボタンをクリック）
2. `git clone https://github.com/<あなたのユーザー名>/nanoclaw.git`
3. `cd nanoclaw`
4. `copilot`

</details>

その後、`/setup`を実行します。Copilot CLIが依存関係、認証、ローカル agent-runner のビルド、サービス設定を処理します。

> **注意:** `/`で始まるコマンド（`/setup`、`/add-whatsapp`など）はNanoClawのワークフロープロンプトです。通常のターミナルではなく、`copilot` CLIセッション内で入力してください。移行ガイドは [docs/COPILOT_CLI_MIGRATION.md](docs/COPILOT_CLI_MIGRATION.md) を参照してください。

## 設計思想

**理解できる規模。** 1つのプロセス、少数のソースファイル、マイクロサービスなし。NanoClawのコードベース全体を理解したい場合は、Copilot CLIに説明を求めるだけです。

**スコープ管理による安全性。** エージェントはローカル実行ですが、各グループに専用の作業ディレクトリ、セッション状態、マウントポリシーがあります。これはネイティブ実行であり、OSレベルのサンドボックスではありません。

**個人ユーザー向け。** NanoClawはモノリシックなフレームワークではなく、各ユーザーのニーズに正確にフィットするソフトウェアです。肥大化するのではなく、オーダーメイドになるよう設計されています。自分のフォークを作成し、Copilot CLIにニーズに合わせて変更させます。

**カスタマイズ＝コード変更。** 設定ファイルの肥大化なし。動作を変えたい？コードを変更するだけ。コードベースは変更しても安全な規模です。

**AIネイティブ。**
- インストールウィザードなし — Copilot CLIがセットアップを案内。
- モニタリングダッシュボードなし — Copilotに状況を聞くだけ。
- デバッグツールなし — 問題を説明すればCopilotが修正。

**機能追加ではなくワークフロー。** すべてをコアに入れる代わりに、`/add-telegram`のようなワークフロー文書と分岐差分で必要な機能だけを追加します。結果として、必要なことだけを行うクリーンなコードが手に入ります。

**最高のハーネス、最高のモデル。** NanoClawはGitHub Copilot SDK上で動作します。つまり、Copilot CLIを直接実行しているということです。Copilot CLIは高い能力を持ち、そのコーディングと問題解決能力によってNanoClawを変更・拡張し、各ユーザーに合わせてカスタマイズできます。

## サポート機能

- **マルチチャネルメッセージング** - WhatsApp、Telegram、Discord、Slack、Gmailからアシスタントと会話。`/add-whatsapp`や`/add-telegram`などのスキルでチャネルを追加。1つでも複数でも同時に実行可能。
- **グループごとの分離コンテキスト** - 各グループは独自の`AGENTS.md`メモリ、作業ディレクトリ、Copilot セッション状態を持ちます。
- **メインチャネル** - 管理制御用のプライベートチャネル（セルフチャット）。各グループは完全に分離。
- **スケジュールタスク** - Copilotを実行し、メッセージを返せる定期ジョブ。
- **Webアクセス** - Webからのコンテンツ検索・取得。
- **ネイティブランタイム** - エージェントはローカルのストリーミング子プロセスとして実行され、起動が速く、デバッグも単純です。
- **エージェントスウォーム** - 複雑なタスクで協力する専門エージェントチームを起動。
- **オプション連携** - Gmail（`/add-gmail`）などをスキルで追加。

## 使い方

トリガーワード（デフォルト：`@Andy`）でアシスタントに話しかけます：

```
@Andy 毎朝9時に営業パイプラインの概要を送って（Obsidian vaultフォルダにアクセス可能）
@Andy 毎週金曜に過去1週間のgit履歴をレビューして、差異があればREADMEを更新して
@Andy 毎週月曜の朝8時に、Hacker NewsとTechCrunchからAI関連のニュースをまとめてブリーフィングを送って
```

メインチャネル（セルフチャット）から、グループやタスクを管理できます：
```
@Andy 全グループのスケジュールタスクを一覧表示して
@Andy 月曜のブリーフィングタスクを一時停止して
@Andy Family Chatグループに参加して
```

## カスタマイズ

NanoClawは設定ファイルを使いません。変更するには、Copilot CLIに伝えるだけです：

- 「トリガーワードを@Bobに変更して」
- 「今後はレスポンスをもっと短く直接的にして」
- 「おはようと言ったらカスタム挨拶を追加して」
- 「会話の要約を毎週保存して」

または`/customize`を実行してガイド付きの変更を行えます。

コードベースは十分に小さいため、Copilotが安全に変更できます。

## コントリビューション

**機能を追加するのではなく、スキルを追加してください。**

Telegram対応を追加したい場合、コアコードベースにTelegramを追加するPRを作成しないでください。代わりに、NanoClawをフォークし、ブランチでコード変更を行い、PRを開いてください。あなたのPRから`skill/telegram`ブランチを作成し、他のユーザーが自分のフォークにマージできるようにします。

ユーザーは自分のフォークで`/add-telegram`を実行するだけで、あらゆるユースケースに対応しようとする肥大化したシステムではなく、必要なものだけを正確に実行するクリーンなコードが手に入ります。

### RFS（スキル募集）

私たちが求めているスキル：

**コミュニケーションチャネル**
- `/add-signal` - Signalをチャネルとして追加

**セッション管理**
- `/clear` - 会話をコンパクト化する`/clear`コマンドの追加（同一セッション内で重要な情報を保持しながらコンテキストを要約）。GitHub Copilot SDKを通じてプログラム的にコンパクト化をトリガーする方法の解明が必要。

## 必要条件

- macOSまたはLinux
- Node.js 20以上
- [Copilot CLI](https://docs.github.com/copilot/how-tos/copilot-cli)

## アーキテクチャ

```
チャネル --> SQLite --> ポーリングループ --> ローカル Agent Runner（GitHub Copilot SDK） --> レスポンス
```

単一のNode.jsプロセス。チャネルはスキルで追加され、起動時に自己登録します。エージェントはローカル子プロセスとして実行されます。グループごとのメッセージキューと同時実行制御を持ち、IPC はファイルシステム経由です。

詳細なアーキテクチャについては、[docs/SPEC.md](docs/SPEC.md)を参照してください。

主要ファイル：
- `src/index.ts` - オーケストレーター：状態、メッセージループ、エージェント呼び出し
- `src/channels/registry.ts` - チャネルレジストリ（起動時の自己登録）
- `src/ipc.ts` - IPCウォッチャーとタスク処理
- `src/router.ts` - メッセージフォーマットとアウトバウンドルーティング
- `src/group-queue.ts` - グローバル同時実行制限付きのグループごとのキュー
- `src/container-runner.ts` - ストリーミングエージェントプロセスの起動
- `src/task-scheduler.ts` - スケジュールタスクの実行
- `src/db.ts` - SQLite操作（メッセージ、グループ、セッション、状態）
- `groups/*/AGENTS.md` - グループごとのメモリ

## FAQ

**なぜネイティブランタイムなのか？**

イメージビルド、デーモン依存、ホストと実行環境の差分を取り除けるからです。起動が速く、問題も追いやすく、リポジトリ上のコードがそのまま実行されます。

**Linuxで実行できますか？**

はい。ネイティブ runner は macOS と Linux の両方で動作します。`/setup`を実行するだけです。

**セキュリティは大丈夫ですか？**

安全性はありますが、OSレベルのサンドボックスではありません。エージェントはホスト上の子プロセスとして動作します。高権限の操作は信頼できるグループに限定し、マウント範囲を慎重に見直してください。詳しくは[docs/SECURITY.md](docs/SECURITY.md)と[docs/NATIVE_RUNTIME.md](docs/NATIVE_RUNTIME.md)を参照してください。

**なぜ設定ファイルがないのか？**

設定の肥大化を避けたいからです。すべてのユーザーがNanoClawをカスタマイズし、汎用的なシステムを設定するのではなく、コードが必要なことを正確に実行するようにすべきです。設定ファイルが欲しい場合は、Copilotに追加するよう伝えることができます。

**サードパーティやオープンソースモデルを使えますか？**

はい。NanoClawはCopilot API互換のモデルエンドポイントに対応しています。`.env`ファイルで以下の環境変数を設定してください：

```bash
ANTHROPIC_BASE_URL=https://your-api-endpoint.com
ANTHROPIC_AUTH_TOKEN=your-token-here
```

以下が使用可能です：
- [Ollama](https://ollama.ai)とAPIプロキシ経由のローカルモデル
- [Together AI](https://together.ai)、[Fireworks](https://fireworks.ai)等でホストされたオープンソースモデル
- Anthropic互換APIのカスタムモデルデプロイメント

注意：最高の互換性のため、モデルはAnthropic APIフォーマットに対応している必要があります。

**問題のデバッグ方法は？**

Copilot CLIに聞いてください。「スケジューラーが動いていないのはなぜ？」「最近のログには何がある？」「このメッセージに返信がなかったのはなぜ？」これがNanoClawの基盤となるAIネイティブなアプローチです。

**セットアップがうまくいかない場合は？**

問題がある場合、セットアップ中にCopilotが動的に修正を試みます。それでもうまくいかない場合は、`copilot`を実行してから`/debug`を実行してください。Copilotが他のユーザーにも影響する可能性のある問題を見つけた場合は、セットアップのSKILL.mdを修正するPRを開いてください。

**どのような変更がコードベースに受け入れられますか？**

セキュリティ修正、バグ修正、明確な改善のみが基本設定に受け入れられます。それだけです。

それ以外のすべて（新機能、OS互換性、ハードウェアサポート、機能拡張）はスキルとしてコントリビューションすべきです。

これにより、基本システムを最小限に保ち、すべてのユーザーが不要な機能を継承することなく、自分のインストールをカスタマイズできます。

## コミュニティ

質問やアイデアは？[Discordに参加](https://discord.gg/VDdww8qS42)してください。

## 変更履歴

破壊的変更と移行ノートについては[CHANGELOG.md](CHANGELOG.md)を参照してください。

Copilot CLI移行の要約、利用手順、今後の最適化案は [docs/COPILOT_CLI_MIGRATION.md](docs/COPILOT_CLI_MIGRATION.md) を参照してください。

## ライセンス

MIT

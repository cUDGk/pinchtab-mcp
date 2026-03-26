<h1 align="center">pinchtab-mcp</h1>

<p align="center">
  <strong><a href="https://github.com/pinchtab/pinchtab">PinchTab</a> 用 MCP サーバー — AIエージェントのためのブラウザ自動化</strong><br/>
  OpenCode、Cursor、Claude Desktop、その他あらゆる MCP 対応クライアントで動作
</p>

<p align="center">
  <img src="https://img.shields.io/badge/MCP-stdio-6B46C1?style=flat-square&logo=data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCI+PHBhdGggZmlsbD0id2hpdGUiIGQ9Ik0xMiAyQzYuNDggMiAyIDYuNDggMiAxMnM0LjQ4IDEwIDEwIDEwIDEwLTQuNDggMTAtMTBTMTcuNTIgMiAxMiAyem0tMSAxNXYtNEg3bDUtOXY0aDRsLTUgOXoiLz48L3N2Zz4=" alt="MCP stdio"/>
  <img src="https://img.shields.io/badge/node-%3E%3D18-339933?style=flat-square&logo=node.js&logoColor=white" alt="Node.js ≥18"/>
  <img src="https://img.shields.io/badge/TypeScript-5.x-3178C6?style=flat-square&logo=typescript&logoColor=white" alt="TypeScript"/>
  <img src="https://img.shields.io/badge/license-MIT-blue?style=flat-square" alt="MIT license"/>
</p>

---

## これは何？

[PinchTab](https://github.com/pinchtab/pinchtab) は、HTTP API 経由で AI エージェントに Chrome ブラウザの完全な制御を提供するスタンドアロンの Go バイナリです。トークン効率が高く、ヘッドレス対応で、永続的なブラウザプロファイルをサポートしています。

**pinchtab-mcp** は、PinchTab の HTTP API をラップする軽量な [Model Context Protocol](https://modelcontextprotocol.io)（MCP）stdio サーバーです。MCP 対応の AI コーディングエージェントやチャットクライアントで、標準的な MCP ツールとして利用できます。

```
AI クライアント (OpenCode / Cursor / Claude Desktop)
        │  MCP stdio (JSON-RPC)
        ▼
  pinchtab-mcp  ──HTTP──▶  PinchTab :9867  ──CDP──▶  Chrome
```

### なぜ別の MCP ラッパーが必要なのか？

PinchTab は標準的な HTTP API を提供しています。一方、MCP クライアントは JSON-RPC を使って stdin/stdout で通信します。このサーバーは両者を橋渡しし、以下を追加します：

- 統一された `action` パラメータを持つ単一の `pinchtab` ツール — コンテキストの肥大化を最小限に
- Zod による型付きバリデーション付き入力
- 認証トークンの転送、タイムアウト設定
- スクリーンショットを MCP 画像コンテンツ（base64 JPEG）として返却

---

## 前提条件

| 要件 | 備考 |
|------|------|
| **Node.js >= 18** | MCP サーバーの実行に必要 |
| **PinchTab** | Go バイナリがローカル（または Docker 内）で実行されている必要あり |

### PinchTab のインストール

```bash
# macOS / Linux — 推奨
curl -fsSL https://pinchtab.com/install.sh | bash

# Docker
docker run -d -p 9867:9867 ghcr.io/pinchtab/pinchtab:latest
```

> **注意:** `npm install -g pinchtab` は全てのプラットフォームで確実にバイナリをインストールできるわけではありません。インストールスクリプトまたは Docker を使用してください。

> PinchTab の完全なドキュメント: [pinchtab.com/docs](https://pinchtab.com/docs)

---

## セットアップ

### 1. クローンとビルド

```bash
git clone https://github.com/domci/pinchtab-mcp.git
cd pinchtab-mcp
npm install
npm run build
```

これにより `src/index.ts` が `dist/index.js` にコンパイルされます。

### 2. PinchTab を起動

別のターミナルで実行してください — MCP サーバーを使用する前に PinchTab が起動している必要があります：

```bash
# 基本
pinchtab

# 認証トークン付き（推奨）
BRIDGE_TOKEN=my-secret pinchtab
```

> **MCP ツールが `Connection failed` を返す場合**、PinchTab が起動していません。上記のように起動してからリトライしてください。

### 3. クライアントの設定

#### OpenCode

`~/.config/opencode/opencode.json`（グローバル）またはプロジェクトルートの `opencode.json` に追加：

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "pinchtab": {
      "type": "local",
      "command": ["node", "/absolute/path/to/pinchtab-mcp/dist/index.js"],
      "enabled": true,
      "environment": {
        "PINCHTAB_URL": "http://localhost:9867",
        "PINCHTAB_TOKEN": "my-secret"   // 認証トークンが不要な場合は省略
      }
    }
  }
}
```

#### Cursor IDE

`~/.cursor/mcp.json`（グローバル）またはプロジェクトルートの `.cursor/mcp.json` に追加：

```json
{
  "mcpServers": {
    "pinchtab": {
      "command": "node",
      "args": ["/absolute/path/to/pinchtab-mcp/dist/index.js"],
      "env": {
        "PINCHTAB_URL": "http://localhost:9867",
        "PINCHTAB_TOKEN": "my-secret"
      },
      "type": "stdio"
    }
  }
}
```

#### Claude Desktop

`~/Library/Application Support/Claude/claude_desktop_config.json` に追加：

```json
{
  "mcpServers": {
    "pinchtab": {
      "command": "node",
      "args": ["/absolute/path/to/pinchtab-mcp/dist/index.js"],
      "env": {
        "PINCHTAB_URL": "http://localhost:9867"
      }
    }
  }
}
```

---

## 環境変数

| 変数 | デフォルト | 説明 |
|------|-----------|------|
| `PINCHTAB_URL` | `http://localhost:9867` | 実行中の PinchTab サーバーのベース URL |
| `PINCHTAB_TOKEN` | *（空）* | Bearer トークン — PinchTab に設定した `BRIDGE_TOKEN` と一致させる必要あり |
| `PINCHTAB_TIMEOUT` | `30000` | HTTP リクエストのタイムアウト（ミリ秒） |

---

## ツールリファレンス

単一の `pinchtab` ツールが登録されます。すべての操作は `action` パラメータで振り分けられます。

### アクション

| アクション | 説明 | 主要パラメータ |
|-----------|------|---------------|
| `navigate` | URL に移動 | `url`, `newTab?`, `blockImages?`, `timeout?` |
| `snapshot` | 現在のページのアクセシビリティツリー | `filter?`, `format?`, `diff?`, `maxTokens?`, `depth?` |
| `click` | 要素をクリック | `ref` |
| `type` | フォーカスされた要素にテキストを入力 | `ref`, `text` |
| `fill` | 入力欄をクリアして値をセット | `ref`, `text` |
| `press` | キーを押下 | `ref`, `key`（例: `Enter`, `Tab`） — フォーム送信には送信ボタンの `click` を推奨 |
| `hover` | 要素にホバー | `ref` |
| `scroll` | ページをスクロール | `ref?`, `scrollY` |
| `select` | ドロップダウンのオプションを選択 | `ref`, `value` |
| `focus` | 要素にフォーカス | `ref` |
| `text` | ページのテキストを抽出（約800トークン） | `mode?`（`readability`\|`raw`） |
| `tabs` | タブの一覧表示・開く・閉じる | `tabAction?`（`list`\|`new`\|`close`） |
| `screenshot` | JPEG スクリーンショットを撮影 | `quality?`（1-100） |
| `evaluate` | ページ内で JavaScript を実行 | `expression` |
| `pdf` | ページを PDF として出力 | `landscape?`, `scale?` |
| `health` | PinchTab の接続状態を確認 | — |

すべてのアクションは、特定のタブを対象にするためのオプション `tabId` を受け付けます。

### トークン戦略

| シナリオ | 推奨アクション | 概算トークン数 |
|---------|---------------|---------------|
| ページ内容の読み取り | `text` | 約800 |
| インタラクティブ要素の検索 | `snapshot`（`filter=interactive&format=compact`） | 約3,600 |
| ページ変更の追跡 | `snapshot`（`diff=true`） | 差分のみ |
| 視覚的な確認 | `screenshot` | 約2,000 |

---

## プロンプト例

```
https://news.ycombinator.com にアクセスして、トップ10の記事タイトルを抽出して。
use pinchtab
```

```
https://example.com/login にアクセスして、ユーザー名とパスワードを入力し、フォームを送信して。
use pinchtab
```

```
現在のページのスクリーンショットを撮って。
use pinchtab
```

---

## 開発

```bash
# 依存関係のインストール
npm install

# ビルド (TypeScript → dist/)
npm run build

# 直接実行
node dist/index.js
```

### プロジェクト構成

```
pinchtab-mcp/
├── src/
│   └── index.ts       # MCP stdio サーバー — すべてのロジックはここに集約
├── dist/              # コンパイル出力（git-ignored）
├── package.json
└── tsconfig.json
```

---

## トラブルシューティング

**`Connection failed: fetch failed. Is PinchTab running at http://localhost:9867?`**
PinchTab バイナリが起動していません。別のターミナルで `pinchtab` を実行してから、リトライしてください。

**`npm install -g pinchtab` でインストールしたが `pinchtab` コマンドが見つからない**
npm パッケージは全てのプラットフォームで Go バイナリをインストールできるわけではありません。代わりにインストールスクリプトを使用してください：
```bash
curl -fsSL https://pinchtab.com/install.sh | bash
```

**`press Enter` でフォームが送信されない / ページが遷移しない**
一部のサイトでは、入力欄のキーボードイベントではなく、送信ボタンのクリックイベントでフォーム送信を処理しています。入力欄での `press Enter` の代わりに、送信ボタンの ref に対して `click` を使用してください。

**検索入力欄に `"queryEnter"` が値として表示される**
これは `press` がフィールドの値にそのまま文字列を追加してしまう場合に発生します。`fill` を使って値を正しくセットしてから、送信ボタンを `click` してください。

---

## セキュリティに関する注意事項

- **`BRIDGE_TOKEN` / `PINCHTAB_TOKEN`** — 本番環境では必ずトークンを設定し、定期的にローテーションしてください。
- **`evaluate`** は Chrome 内で任意の JavaScript を実行します — 信頼できるエージェントとドメインのみにアクセスを制限してください。
- PinchTab を公開インターネットに公開しないでください。`localhost` またはプライベートネットワーク内で使用してください。

---

## ライセンス

MIT — [LICENSE](LICENSE) を参照。

---

<p align="center">
  <a href="https://github.com/pinchtab/pinchtab"><strong>PinchTab</strong></a> をベースに構築 — PinchTab 作者によるプロジェクト / MCP ラッパー: <a href="https://github.com/domci">domci</a>
</p>

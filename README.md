<h1 align="center">pinchtab-mcp</h1>

<p align="center">
  <strong><a href="https://github.com/pinchtab/pinchtab">PinchTab</a> を MCP ツール化する stdio サーバー</strong><br/>
  OpenCode / Cursor / Claude Desktop など MCP 対応クライアントで使える
</p>

<p align="center">
  <img src="https://img.shields.io/badge/MCP-stdio-6B46C1?style=flat-square&logo=data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCI+PHBhdGggZmlsbD0id2hpdGUiIGQ9Ik0xMiAyQzYuNDggMiAyIDYuNDggMiAxMnM0LjQ4IDEwIDEwIDEwIDEwLTQuNDggMTAtMTBTMTcuNTIgMiAxMiAyem0tMSAxNXYtNEg3bDUtOXY0aDRsLTUgOXoiLz48L3N2Zz4=" alt="MCP stdio"/>
  <img src="https://img.shields.io/badge/node-%3E%3D18-339933?style=flat-square&logo=node.js&logoColor=white" alt="Node.js ≥18"/>
  <img src="https://img.shields.io/badge/TypeScript-5.x-3178C6?style=flat-square&logo=typescript&logoColor=white" alt="TypeScript"/>
  <img src="https://img.shields.io/badge/license-MIT-blue?style=flat-square" alt="MIT license"/>
</p>

---

## 概要

[PinchTab](https://github.com/pinchtab/pinchtab) は Chrome をHTTP APIで操作できるGoバイナリ。トークン効率が良く、ヘッドレスもプロファイル永続化もいける。

**pinchtab-mcp** はその HTTP API を [MCP](https://modelcontextprotocol.io)（stdio）でラップしたもの。AIエージェントから MCP ツールとしてブラウザを叩ける。

```
AI クライアント (OpenCode / Cursor / Claude Desktop)
        │  MCP stdio (JSON-RPC)
        ▼
  pinchtab-mcp  ──HTTP──▶  PinchTab :9867  ──CDP──▶  Chrome
```

### なぜラッパーが要るのか

PinchTab は HTTP API、MCP クライアントは stdin/stdout の JSON-RPC。このサーバーがその間を埋める。

- `action` パラメータ1つで全操作 → コンテキスト消費を抑える
- Zod でバリデーション
- 認証トークン転送・タイムアウト設定
- スクリーンショットは base64 JPEG で返す

---

## 必要なもの

| 要件 | 備考 |
|------|------|
| **Node.js >= 18** | MCP サーバーの実行に必要 |
| **PinchTab** | Go バイナリをローカルか Docker で動かしておく |

### PinchTab のインストール

```bash
# macOS / Linux
curl -fsSL https://pinchtab.com/install.sh | bash

# Docker
docker run -d -p 9867:9867 ghcr.io/pinchtab/pinchtab:latest
```

> `npm install -g pinchtab` は環境によってバイナリが入らないことがある。上のスクリプトか Docker を推奨。

> 公式ドキュメント: [pinchtab.com/docs](https://pinchtab.com/docs)

---

## セットアップ

### 1. クローン & ビルド

```bash
git clone https://github.com/cUDGk/pinchtab-mcp.git
cd pinchtab-mcp
npm install
npm run build
```

`src/index.ts` → `dist/index.js` にコンパイルされる。

### 2. PinchTab を起動

別ターミナルで先に起動しておく:

```bash
# そのまま
pinchtab

# トークン付き（推奨）
BRIDGE_TOKEN=my-secret pinchtab
```

> MCP ツールが `Connection failed` を返す場合は PinchTab が起動していない。

### 3. クライアント設定

#### OpenCode

`~/.config/opencode/opencode.json` かプロジェクトルートの `opencode.json`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "pinchtab": {
      "type": "local",
      "command": ["node", "/path/to/pinchtab-mcp/dist/index.js"],
      "enabled": true,
      "environment": {
        "PINCHTAB_URL": "http://localhost:9867",
        "PINCHTAB_TOKEN": "my-secret"
      }
    }
  }
}
```

#### Cursor IDE

`~/.cursor/mcp.json` かプロジェクトルートの `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "pinchtab": {
      "command": "node",
      "args": ["/path/to/pinchtab-mcp/dist/index.js"],
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

`~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "pinchtab": {
      "command": "node",
      "args": ["/path/to/pinchtab-mcp/dist/index.js"],
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
| `PINCHTAB_URL` | `http://localhost:9867` | PinchTab のURL |
| `PINCHTAB_TOKEN` | *(なし)* | PinchTab 側の `BRIDGE_TOKEN` と合わせる |
| `PINCHTAB_TIMEOUT` | `30000` | リクエストタイムアウト (ms) |

---

## ツール一覧

`pinchtab` という1つのツールに全アクションが集約されている。`action` で振り分け。

### アクション

| アクション | やること | 主なパラメータ |
|-----------|---------|---------------|
| `navigate` | URLに遷移 | `url`, `newTab?`, `blockImages?`, `timeout?` |
| `snapshot` | アクセシビリティツリー取得 | `filter?`, `format?`, `diff?`, `maxTokens?`, `depth?` |
| `click` | 要素クリック | `ref` |
| `type` | テキスト入力 | `ref`, `text` |
| `fill` | 入力欄をクリアして値セット | `ref`, `text` |
| `press` | キー押下 | `ref`, `key` (例: `Enter`, `Tab`) |
| `hover` | ホバー | `ref` |
| `scroll` | スクロール | `ref?`, `scrollY` |
| `select` | ドロップダウン選択 | `ref`, `value` |
| `focus` | フォーカス | `ref` |
| `text` | ページテキスト抽出 | `mode?` (`readability` / `raw`) |
| `tabs` | タブ操作 | `tabAction?` (`list` / `new` / `close`) |
| `screenshot` | スクリーンショット (JPEG) | `quality?` (1-100) |
| `evaluate` | JS実行 | `expression` |
| `pdf` | PDF出力 | `landscape?`, `scale?` |
| `health` | 接続確認 | — |

全アクションで `tabId` を指定して対象タブを切り替え可能。

> フォーム送信は `press Enter` より送信ボタンの `click` の方が確実。

### トークン消費の目安

| やりたいこと | 推奨 | トークン目安 |
|-------------|------|-------------|
| ページの中身を読む | `text` | ~800 |
| ボタンやリンクを探す | `snapshot` + `filter=interactive&format=compact` | ~3,600 |
| 変更差分だけ取る | `snapshot` + `diff=true` | 差分のみ |
| 見た目を確認 | `screenshot` | ~2,000 |

---

## 使用例

```
https://news.ycombinator.com を開いてトップ10の記事タイトルを抽出して
use pinchtab
```

```
https://example.com/login でユーザー名とパスワードを入力してログインして
use pinchtab
```

```
今のページのスクショ撮って
use pinchtab
```

---

## 開発

```bash
npm install        # 依存インストール
npm run build      # TypeScript → dist/
node dist/index.js # 直接実行
```

### 構成

```
pinchtab-mcp/
├── src/
│   └── index.ts       # 全ロジックここに集約
├── dist/              # ビルド出力 (gitignore)
├── package.json
└── tsconfig.json
```

---

## トラブルシューティング

**`Connection failed: ... Is PinchTab running at http://localhost:9867?`**
→ PinchTab が起動していない。別ターミナルで `pinchtab` を実行。

**`npm install -g pinchtab` したのにコマンドが見つからない**
→ npm版は環境によってGoバイナリが入らない。インストールスクリプトを使う:
```bash
curl -fsSL https://pinchtab.com/install.sh | bash
```

**`press Enter` でフォームが送信されない**
→ サイトによってはボタンのクリックイベントで送信している。送信ボタンの ref を `click` する。

**検索欄に `"queryEnter"` が入る**
→ `press` が値として追加してしまうケース。`fill` で値をセットしてからボタンを `click`。

---

## セキュリティ

- `BRIDGE_TOKEN` / `PINCHTAB_TOKEN` は本番では必ず設定して定期的にローテーション
- `evaluate` はページ内で任意JSを実行するので、信頼できるドメインのみで使う
- PinchTab を外部公開しない。`localhost` かプライベートネットワーク内で

---

## ライセンス

MIT — [LICENSE](LICENSE)

---

<p align="center">
  <a href="https://github.com/pinchtab/pinchtab"><strong>PinchTab</strong></a> の MCP ラッパー / 元プロジェクト: <a href="https://github.com/domci">domci</a>
</p>

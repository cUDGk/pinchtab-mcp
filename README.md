<div align="center">

# pinchtab-mcp

### PinchTab MCP ラッパー

[![Node.js](https://img.shields.io/badge/Node.js-18+-339933?style=for-the-badge&logo=node.js&logoColor=white)](https://nodejs.org/)
[![MCP](https://img.shields.io/badge/MCP-Model_Context_Protocol-8B5CF6?style=for-the-badge)](https://modelcontextprotocol.io/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?style=for-the-badge&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![License](https://img.shields.io/badge/License-MIT-green?style=for-the-badge)](LICENSE)

**[PinchTab](https://github.com/pinchtab/pinchtab) の HTTP API を MCP ツールとして公開する stdio サーバー**

---

</div>

AI エージェント（Claude Code / Cursor / OpenCode 等）から、MCP 経由でブラウザ操作ができるようになります。ナビゲーション、クリック、フォーム入力、スクリーンショット、JS 実行まで、単一の `pinchtab` ツールに集約。

## 特徴

- **単一ツール設計** -- `action` パラメータ1つで18種類の操作を振り分け。コンテキスト消費を最小限に抑える
- **Zod バリデーション** -- 全パラメータに型付きバリデーション
- **スクリーンショット対応** -- base64 JPEG で MCP 画像コンテンツとして返却
- **認証トークン転送** -- PinchTab 側の `BRIDGE_TOKEN` をそのまま転送
- **タイムアウト制御** -- リクエスト単位でタイムアウトを設定可能

---

## 処理フロー

```mermaid
graph LR
    A[AI クライアント] -->|MCP stdio / JSON-RPC| B[pinchtab-mcp]
    B -->|HTTP| C[PinchTab :9867]
    C -->|CDP| D[Chrome / Brave]

    style A fill:#5865F2,color:#fff,stroke:none
    style B fill:#2b2d31,color:#fff,stroke:#8B5CF6
    style C fill:#00ADD8,color:#fff,stroke:none
    style D fill:#FB542B,color:#fff,stroke:none
```

---

## アクション一覧

| アクション | 説明 | 主なパラメータ | `tabId?`¹ |
|-----------|------|---------------|----------|
| `navigate` | URL に遷移 | `url`, `newTab?`, `blockImages?`, `timeout?` | ✓ |
| `snapshot` | アクセシビリティツリー取得 | `filter?`, `format?`, `diff?`, `maxTokens?`, `depth?` | ✓ |
| `click` | 要素をクリック | `ref` | ✓ |
| `type` | テキスト追記/タイプ | `ref`, `text` | ✓ |
| `fill` | 入力欄をクリアして値セット | `ref`, `value` | ✓ |
| `press` | キー押下 | `ref`, `key` (例: `Enter`, `Tab`) | ✓ |
| `hover` | 要素にホバー | `ref` | ✓ |
| `scroll` | スクロール | `ref?`, `scrollY` | ✓ |
| `select` | ドロップダウン選択 | `ref`, `value` | ✓ |
| `focus` | 要素にフォーカス | `ref` | ✓ |
| `text` | ページテキスト抽出 | `mode?` (`readability` / `raw`) | ✓ |
| `tabs` | タブ操作 | `tabAction?` (`list` / `new` / `close`) | ✓ |
| `screenshot` | スクリーンショット (JPEG) | `quality?` (1-100) | ✓ |
| `evaluate` | ページ内で JS 実行 | `expression` | ✓ |
| `pdf` | PDF 出力 | `landscape?`, `scale?` | ✓ |
| `back` | 履歴を戻る | — | ✓ |
| `forward` | 履歴を進む | — | ✓ |
| `health` | 接続確認 | — | — |

> ¹ `tabId` はほぼ全アクションで省略可能。省略時はアクティブなタブを対象とする。

> **未実装 (将来検討):** `wait` / `wait_for_selector` (要素やネットワーク待機)、`cookies` (取得/設定/削除) は PinchTab 側のエンドポイント拡張が決まり次第追加予定。

> フォーム送信は `press Enter` より送信ボタンの `click` が確実。

### トークン消費の目安

| やりたいこと | 推奨 | トークン目安 |
|-------------|------|-------------|
| ページの中身を読む | `text` | ~800 |
| ボタンやリンクを探す | `snapshot` + `filter=interactive&format=compact` | ~3,600 |
| 変更差分だけ取る | `snapshot` + `diff=true` | 差分のみ |
| 見た目を確認 | `screenshot` | ~2,000 (画像トークン、テキストトークンではない) |

---

## インストール

### 1. PinchTab を導入

```bash
# Docker (推奨)
docker run -d -p 9867:9867 ghcr.io/pinchtab/pinchtab:latest
```

バイナリを直接インストールする場合は、[リリースページ](https://github.com/pinchtab/pinchtab/releases) からチェックサム付きのアーカイブをダウンロードして検証してください:

```bash
# 例 (Linux amd64)
curl -fsSL -o pinchtab.tar.gz \
  https://github.com/pinchtab/pinchtab/releases/download/vX.Y.Z/pinchtab-linux-amd64.tar.gz
# チェックサム検証 (リリースページの SHA256 と照合)
sha256sum pinchtab.tar.gz
tar -xzf pinchtab.tar.gz
```

> **注意:** `curl ... | bash` 形式のパイプインストールはスクリプト内容を検証できず危険です。チェックサム付きダウンロードを使ってください。

> 公式ドキュメント: [pinchtab.com/docs](https://pinchtab.com/docs)

### 2. リポジトリをクローン & ビルド

```bash
git clone https://github.com/cUDGk/pinchtab-mcp.git
cd pinchtab-mcp
npm install
npm run build
```

`src/index.ts` → `dist/index.js` にコンパイルされます。

### 3. AI クライアントに MCP サーバーとして登録

#### Claude Desktop

設定ファイルパス:

- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`
- Linux: `~/.config/Claude/claude_desktop_config.json`

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

Windows 上では `args` のパスを `"C:\\Users\\you\\pinchtab-mcp\\dist\\index.js"` のようにバックスラッシュをエスケープしてください。

#### Cursor IDE

`~/.cursor/mcp.json` またはプロジェクトルートの `.cursor/mcp.json`:

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

#### Claude Code

設定ファイルパス:

- macOS / Linux: `~/.claude/settings.json`
- Windows: `%USERPROFILE%\.claude\settings.json` (= `C:\Users\<you>\.claude\settings.json`)

```json
{
  "mcpServers": {
    "pinchtab": {
      "command": "node",
      "args": ["/path/to/pinchtab-mcp/dist/index.js"],
      "env": {
        "PINCHTAB_URL": "http://localhost:9867",
        "PINCHTAB_TOKEN": "my-secret"
      }
    }
  }
}
```

**Windows パス例 (バックスラッシュをエスケープ):**

```json
{
  "mcpServers": {
    "pinchtab": {
      "command": "node",
      "args": ["C:\\Users\\user\\pinchtab-mcp\\dist\\index.js"],
      "env": {
        "PINCHTAB_URL": "http://localhost:9867"
      }
    }
  }
}
```

ツール名は `mcp__pinchtab__browser` として呼び出されます。

#### OpenCode

`~/.config/opencode/opencode.json` またはプロジェクトルート:

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

---

## 環境変数

| 変数 | デフォルト | 説明 |
|------|-----------|------|
| `PINCHTAB_URL` | `http://localhost:9867` | PinchTab サーバーの URL (http/https のみ) |
| `PINCHTAB_TOKEN` | *(なし)* | PinchTab 側の `BRIDGE_TOKEN` と一致させる |
| `PINCHTAB_TIMEOUT` | `30000` | リクエストタイムアウト ms (最大 120000) |
| `PINCHTAB_ALLOW_REMOTE` | `0` (無効) | `1` にセットするとリモート/プライベートIPへの接続を許可 (デフォルトは loopback のみ。SSRF 対策) |
| `PINCHTAB_ALLOW_EVALUATE` | `0` (無効) | `1` にセットすると `evaluate` アクションを有効化 (任意 JS 実行) |

---

## 使い方

### PinchTab を起動

```bash
# そのまま
pinchtab

# トークン付き（推奨）
BRIDGE_TOKEN=my-secret pinchtab
```

### AI クライアントから呼び出す

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

## プロジェクト構成

```
pinchtab-mcp/
├── src/
│   └── index.ts       # MCP stdio サーバー（全ロジック集約）
├── dist/              # ビルド出力 (gitignore)
├── package.json
└── tsconfig.json
```

---

## トラブルシューティング

| 症状 | 原因と対処 |
|------|-----------|
| `Connection failed: ... Is PinchTab running?` | PinchTab が起動していない。別ターミナルで `pinchtab` を実行 |
| `pinchtab` コマンドが見つからない | npm 版は存在しない。[GitHub Releases](https://github.com/pinchtab/pinchtab/releases) からチェックサム付きアーカイブをダウンロードして検証する |
| `press Enter` でフォームが送信されない | サイトによってはボタンクリックで送信。送信ボタンの ref を `click` する |
| 検索欄に `"queryEnter"` が入る | `press` が値として追加されるケース。`fill` で値をセットしてからボタンを `click` |

---

## セキュリティ

- `BRIDGE_TOKEN` / `PINCHTAB_TOKEN` は本番では必ず設定し、定期的にローテーション
- `evaluate` はページ内で任意 JS を実行する。信頼できるドメインのみで使用すること
- PinchTab は `localhost` かプライベートネットワーク内で運用。外部に公開しない

---

## Attribution

このプロジェクトは以下のオープンソースプロジェクトの上に構築されています:

- **[PinchTab](https://github.com/pinchtab/pinchtab)** -- Go 製のブラウザ自動化エンジン。HTTP API 経由で Chrome を操作。PinchTab authors によるプロジェクト。
- **[MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)** -- Model Context Protocol の公式 TypeScript 実装。Anthropic による [MCP 仕様](https://modelcontextprotocol.io/) に基づく。
- 元リポジトリ: **[domci/pinchtab-mcp](https://github.com/domci/pinchtab-mcp)**

---

## ライセンス

[MIT License](LICENSE) -- Copyright (c) 2026 cUDGk

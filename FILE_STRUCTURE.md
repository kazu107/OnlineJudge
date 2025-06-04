# プロジェクト構成

このリポジトリは Next.js を用いたオンラインジャッジのサンプル実装です。主なディレクトリとファイルの概要を以下にまとめます。

## ルートディレクトリ

| パス | 説明 |
| --- | --- |
| `Procfile` | Heroku 等でアプリを起動するコマンドを定義します。 |
| `docker-compose.yml` | `next-app` と `executor` のコンテナを構築する Compose 設定です。 |
| `README.md` | プロジェクトの基本的なセットアップ方法を記載しています。 |
| `jsconfig.json` | Next.js 用のパスエイリアス設定です。 |
| `memo` | 開発用メモ。Docker イメージのビルド方法などが記されています。 |
| `next.config.mjs` | Next.js の設定ファイル。最低限の設定のみです。 |
| `postcss.config.mjs` | PostCSS のプラグイン設定。Tailwind CSS を利用しています。 |
| `tailwind.config.mjs` | Tailwind CSS の設定ファイル。 |
| `package.json` / `package-lock.json` | 依存パッケージの管理ファイルです。 |
| `executor/` | ユーザコードを実行する Node.js サービスのソース。Docker イメージとして使用されます。 |
| `next-app/` | Next.js アプリ本体。問題ページや API エンドポイントが含まれます。 |

## `executor/` ディレクトリ

| パス | 説明 |
| --- | --- |
| `Dockerfile` | コード実行環境を構築するための Dockerfile。 |
| `server.js` | `/run` エンドポイントを提供するシンプルな実行サーバー。 |
| `run.sh` | Python/C++ など各言語の実行方法を統一するラッパースクリプト。実行時間・メモリ計測も行います。 |
| `package.json` | 実行サーバーの依存設定。 |

## `next-app/` ディレクトリ

| パス | 説明 |
| --- | --- |
| `pages/` | Next.js のページおよび API ルート。`pages/api` 以下に実行・提出用 API が実装されています。 |
| `problems/` | 各問題フォルダ。`statement.md` やテストケースなどを含みます。 |
| `evaluators/` | カスタム評価用スクリプトを配置する場所。例として `tsp_evaluator.py` があります。 |
| `test_tle_mle.js` | TLE/MLE テスト用のスクリプト。バックエンド API を直接呼び出して動作確認を行います。 |
| `package.json` | Next.js アプリの依存設定。 |

## `next-app/pages/` 内主要ファイル

| パス | 説明 |
| --- | --- |
| `index.js` | トップページ。言語選択とコード実行サンプルを表示します。 |
| `pages/problems/[id].js` | 問題詳細ページ。Markdown 表示や提出結果の表示処理を行います。 |
| `pages/api/execute.js` | コードを単発で実行する API。 |
| `pages/api/submit.js` | 提出されたコードをテストケースで評価する API。SSE で進捗を返します。 |
| `pages/api/submit.test.js` | `submit.js` のユニットテスト（モック依存を想定）。 |

## `next-app/problems/` 例

各問題ディレクトリは以下のような構造を持ちます。

```
problem1/
├── explanation.md  # 解説
├── meta.json       # タイムアウト等のメタ情報
├── statement.md    # 問題文
└── tests/          # 入力・出力ファイル群
```

`tsp/` も同様の構成で、`evaluators/` 内のスクリプトを用いたカスタム評価問題の例です。

---

以上が本リポジトリの主なファイル構成です。詳細は各ファイルを参照してください。
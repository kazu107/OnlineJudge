# プロジェクト概要

## 1. はじめに

このドキュメントは、オンラインジャッジシステムプロジェクトの全体像、技術的な詳細、運用方法について解説するものです。主にプロジェクトの管理者および開発・運用に深く関わる方を対象としています。

本システムは、ユーザーが記述したソースコードをオンラインで提出し、自動的にコンパイル、実行、評価を行うプラットフォームを提供することを目的としています。標準的な入力比較による評価に加え、カスタム評価スクリリプトによる柔軟な評価、さらにはインタラクティブ形式の問題にも対応しています。

## 2. システムアーキテクチャ

本システムは、主に以下のコンポーネントから構成されています。

*   **Next.js フロントエンド (`next-app/`)**:
    *   ユーザーインターフェース (UI) を提供し、ユーザーからのコード提出、問題閲覧などのリクエストを処理します。
    *   Next.js の API ルート (`next-app/pages/api/`) を使用して、バックエンドのコード実行サービス (`executor`) と通信します。
    *   React ベースのコンポーネントで画面が構築されています。

*   **コード実行サービス (`executor/`)**:
    *   Node.js (Express) で構築された独立したサービスです。
    *   ユーザーから提出されたコードのコンパイル、実行、および評価を行います。
    *   標準入力/出力ベースの評価、カスタム評価スクリリプトによる評価、インタラクティブ評価など、複数の評価モードをサポートします。
    *   リソース分離とセキュリティ確保のため、コード実行は Docker コンテナ内で行われます。

*   **Docker (`docker-compose.yml`, `executor/Dockerfile`)**:
    *   `executor` サービス自体、およびユーザーコードの実行環境をコンテナ化します。
    *   `docker-compose.yml` は、`next-app` と `executor` サービスを連携して起動するための設定を定義します (ただし、現在の `docker-compose.yml` は `executor` のみを対象としている可能性があります。Next.jsアプリはホスト側で別途起動する構成が一般的です)。
    *   `executor/Dockerfile` は、コード実行に必要な各種言語のランタイムやツールを含む Docker イメージを定義します。

### コンポーネント間連携

1.  **ユーザー**はブラウザ経由で **Next.js フロントエンド**にアクセスし、問題を選択してコードを提出します。
2.  **Next.js フロントエンド** (`/pages/api/submit.js`) は提出リクエストを受け取り、問題のメタデータ (`meta.json`) を参照して評価方法を判断します。
3.  評価の実行は **コード実行サービス (`executor/`)** に委譲されます。Next.js バックエンドは、HTTP リクエストを通じて `executor` の各エンドポイント (`/execute`, `/evaluate`, `/execute_interactive`) を呼び出します。
4.  **コード実行サービス (`executor/`)** は、リクエストに応じて `ExecutionService.js` を使用し、ユーザーコードを Docker コンテナ内で安全に実行・評価します。
5.  実行結果 (正誤、実行時間、メモリ使用量、エラーメッセージ、インタラクションログなど) は `executor` から Next.js バックエンドに返却され、最終的にSSE (Server-Sent Events) を通じてユーザーのブラウザにリアルタイムで通知されます。

### 主要技術スタック

*   **フロントエンド**: Next.js (React), Tailwind CSS
*   **バックエンド (APIルート)**: Next.js (Node.js)
*   **コード実行サービス**: Node.js, Express.js
*   **コンテナ技術**: Docker
*   **主な開発言語**: JavaScript, Python (評価スクリプト等)

## 3. セットアップと実行方法

### 3.1. 開発環境のセットアップ

本システムを開発・実行するためには、以下のツールがローカル環境にインストールされている必要があります。

*   **Node.js**: JavaScriptランタイム環境。Next.js および `executor` サービスの実行に必要です。(推奨バージョン: LTS版)
*   **npm** または **yarn**: Node.js のパッケージマネージャ。依存ライブラリのインストールに使用します。
*   **Docker**: コンテナ技術。`executor` サービスおよびユーザーコードの分離実行環境として使用します。
*   **Docker Compose**: 複数のDockerコンテナを定義・実行するためのツール (`docker-compose.yml` で利用)。

セットアップ手順の概要:

1.  **リポジトリのクローン**:
    ```bash
    git clone <リポジトリURL>
    cd <プロジェクトディレクトリ>
    ```

2.  **依存関係のインストール**:
    *   プロジェクトルート (Next.jsアプリ用):
        ```bash
        npm install
        # または
        # yarn install
        ```
    *   `executor` サービス用:
        ```bash
        cd executor
        npm install
        # または
        # yarn install
        cd ..
        ```

3.  **Dockerイメージのビルド**:
    `executor` サービス用のDockerイメージをビルドします (初回のみ、または `executor/Dockerfile` に変更があった場合)。
    ```bash
    docker-compose build executor 
    # または executor ディレクトリ内で直接 docker build を行う場合
    # cd executor
    # docker build -t <イメージ名> . 
    # cd ..
    ```
    (注: `docker-compose.yml` 内で `build: ./executor` のように指定されていれば、`docker-compose up` 時に自動でビルドされることもあります。)


### 3.2. ローカルでの実行

1.  **コード実行サービス (`executor`) の起動**:
    `docker-compose.yml` を使用して `executor` サービスをバックグラウンドで起動します。
    ```bash
    docker-compose up -d executor
    ```
    `executor` サービスはデフォルトで `3001` 番ポートでリッスンします (環境変数 `EXECUTOR_PORT` または `PORT` で変更可能)。

2.  **Next.js フロントエンド (開発モード) の起動**:
    プロジェクトルートで以下のコマンドを実行します。
    ```bash
    npm run dev
    # または
    # yarn dev
    ```
    Next.js アプリケーションはデフォルトで `3000` 番ポートで起動します。ブラウザで `http://localhost:3000` にアクセスすると表示されます。

### 3.3. 環境変数

システムが参照する可能性のある主要な環境変数は以下の通りです。必要に応じて `.env.local` ファイルなどを作成して設定してください。

*   **`EXECUTOR_URL`**:
    *   Next.js アプリケーション (`next-app/pages/api/submit.js` など) が `executor` サービスにアクセスするためのURL。
    *   デフォルト: `http://localhost:3001`
    *   例: `.env.local` (next-appディレクトリ直下) に `EXECUTOR_URL=http://localhost:3001` と記述。

*   **`EXECUTOR_PORT`** または **`PORT`** (executorサービス側):
    *   `executor` サービスがリッスンするポート番号。
    *   `executor/server.js` で参照されます。`docker-compose.yml` でポートマッピング (`ports:`) も合わせて確認・設定する必要があります。
    *   デフォルト: `3001`

*   **その他**:
    *   特定のAPIキーやデータベース接続情報など、将来的に追加される可能性があります。

停止する場合は、Next.jsアプリは `Ctrl+C` で停止し、`executor` サービスは `docker-compose down` で停止できます。

## 4. ディレクトリ構造

プロジェクトの主要なディレクトリとファイルの役割は以下の通りです。

```
.
├── docs/
│   └── OVERVIEW.md         # このドキュメント
├── executor/               # コード実行サービス
│   ├── Dockerfile          # executorサービス用のDockerイメージ定義
│   ├── ExecutionService.js # コードのコンパイル、実行、評価処理のコアロジック
│   ├── language_definitions.js # 対応言語の実行・コンパイルコマンド定義
│   ├── server.js           # executorサービスのExpressサーバー (APIエンドポイント)
│   ├── package.json        # executorサービスの依存関係
│   └── ...                 # その他関連ファイル (Procfile, run.shなど)
├── next-app/               # Next.js フロントエンドアプリケーション
│   ├── pages/              # Next.js のページコンポーネントとAPIルート
│   │   ├── api/            # バックエンドAPIエンドポイント (提出処理など)
│   │   │   ├── submit.js   # 提出処理のメインロジック
│   │   │   └── execute.js  # (もしあれば)コードの簡易実行API
│   │   ├── problems/       # 問題一覧や個別問題表示ページ
│   │   │   └── [id].js     # 個別問題表示ページ (動的ルーティング)
│   │   └── index.js        # トップページ
│   ├── problems/           # 問題データ格納ディレクトリ (ルートではなくnext-app内)
│   │   ├── problem1/       # 個別問題のディレクトリ例
│   │   │   ├── meta.json   # 問題のメタデータ (設定ファイル)
│   │   │   ├── statement.md # 問題文マークダウン
│   │   │   ├── explanation.md # 解説マークダウン
│   │   │   ├── tests/      # (標準評価用)テストケースの入力・出力ファイル群
│   │   │   └── evaluator_script.py # (カスタム/インタラクティブ評価用)評価スクリプト
│   │   └── ...             # 他の問題ディレクトリ
│   ├── public/             # 静的ファイル (画像など)
│   ├── styles/             # グローバルスタイル (もしあれば)
│   ├── components/         # Reactコンポーネント (もしあれば)
│   ├── package.json        # Next.jsアプリの依存関係
│   └── next.config.mjs     # Next.js の設定ファイル
├── .gitignore              # Gitの無視ファイル設定
├── docker-compose.yml      # Docker Compose 設定ファイル (主にexecutorサービス用)
├── package.json            # プロジェクトルートのpackage.json (主にNext.jsアプリ用)
└── README.md               # プロジェクトの基本的なREADME
```

**補足:**

*   `next-app/problems/` ディレクトリ: 問題ごとのサブディレクトリを持ち、各サブディレクトリには問題設定ファイル (`meta.json`)、問題文 (`statement.md`)、解説 (`explanation.md`)、テストケースデータ、評価用スクリプトなどが含まれます。
*   `executor/` ディレクトリ: 外部から隔離されたコード実行環境を提供します。`ExecutionService.js` が中心となり、ユーザーコードの安全性とリソース管理を担保します。

## 5. 問題の管理

新しい問題の追加や既存問題の編集は、主に `next-app/problems/` ディレクトリ内のファイルを操作することで行います。

### 5.1. 問題作成・追加の手順

1.  **問題ディレクトリの作成**:
    *   `next-app/problems/` 内に、新しい問題のためのユニークなIDを持つディレクトリを作成します (例: `problem_new_unique_id`)。このIDはURLなどにも使用される可能性があります。

2.  **必須ファイルの配置**:
    *   作成した問題ディレクトリ内に、以下のファイルを配置します。
        *   `meta.json`: 問題の設定ファイル (詳細は後述)。
        *   `statement.md`: 問題文を記述するマークダウンファイル。
        *   `explanation.md`: (任意) 解法や解説を記述するマークダウンファイル。

3.  **テストケースと評価スクリプトの配置**:
    *   評価モードに応じて、必要なテストケースデータや評価スクリプトを配置します。
        *   **Standard Evaluation**: `tests/` サブディレクトリを作成し、入力ファイル (`*.in`) と期待される出力ファイル (`*.out`) のペアを配置します。
        *   **Custom Evaluator**: 評価スクリプト (例: `evaluator.py`) を問題ディレクトリに配置します。テストデータファイルも同様に配置します。
        *   **Interactive Evaluation**: インタラクティブ評価スクリプト (例: `interactive_evaluator.py`) を問題ディレクトリに配置します。

### 5.2. `meta.json` の構造

`meta.json` は各問題の設定を定義する最も重要なファイルです。以下に主要なフィールドと、評価モードごとの設定について解説します。

```json
{
  "problem_id": "unique_problem_identifier", // 問題ディレクトリ名と一致させるのが望ましい
  "title": "問題のタイトル",
  "statement_md_path": "statement.md", // 問題文ファイルへの相対パス
  "explanation_md_path": "explanation.md", // 解説ファイルへの相対パス (任意)
  "evaluation_mode": "standard", // "standard", "custom_evaluator", または "interactive"
  "time_limit_ms": 2000, // ユーザープログラムの実行時間制限 (ミリ秒)
  "memory_limit_kb": 256000, // ユーザープログラムのメモリ使用量制限 (KB)
  "total_max_points": 100, // この問題の満点 (任意、test_casesの合計と一致させるのが望ましい)

  // Standard Evaluation の場合
  "test_case_categories": [
    {
      "category_name": "基本ケース",
      "points": 30,
      "test_cases": [
        { "input": "tests/case1.in", "output": "tests/case1.out" },
        { "input": "tests/case2.in", "output": "tests/case2.out" }
      ]
    },
    {
      "category_name": "大規模ケース",
      "points": 70,
      "test_cases": [
        { "input": "tests/large_case1.in", "output": "tests/large_case1.out" }
      ]
    }
  ],

  // Custom Evaluator の場合
  "custom_evaluator_options": {
    "evaluator_script": "evaluator.py", // 問題ディレクトリからの相対パス
    "evaluator_language": "python", // language_definitions.js で定義されている言語
    "evaluator_time_limit_ms": 10000 // 評価スクリプト自体の実行時間制限 (任意)
  },
  "test_cases": [ // Custom Evaluator 用のテストケース定義
    {
      "id": "custom_test_1",
      "name": "カスタムテストケース1",
      "points": 50,
      "data_file": "test_data/custom_data1.txt" // 評価スクリプトが参照するデータファイル
    },
    {
      "id": "custom_test_2",
      "name": "カスタムテストケース2",
      "points": 50,
      "data_file": "test_data/custom_data2.txt"
    }
  ],

  // Interactive Evaluation の場合
  "interactive_evaluator_options": {
    "evaluator_script_relative_path": "interactive_evaluator.py", // 問題ディレクトリからの相対パス
    "evaluator_language": "python" // language_definitions.js で定義されている言語
  },
  "test_cases": [ // Interactive Evaluation 用のテストセッション定義
    {
      "id": "interactive_session_1",
      "name": "インタラクティブセッション1",
      "points": 100,
      "evaluator_params": { // このセッションの評価スクリプトに渡されるパラメータ
        "N": 100,
        "max_guesses": 7
      }
    }
  ]
}
```

**主要フィールド解説:**

*   `problem_id`: システム内で問題を一意に識別するためのID。
*   `title`: 問題一覧などで表示されるタイトル。
*   `statement_md_path`, `explanation_md_path`: 問題文と解説のマークダウンファイルへのパス。問題ディレクトリからの相対パスです。
*   `evaluation_mode`: 評価方法を指定します。
    *   `standard`: ユーザーの出力と期待される出力を単純比較します。
    *   `custom_evaluator`: 独自に作成した評価スクリプトで採点します。
    *   `interactive`: ユーザープログラムと評価スクリプトが対話的に動作します。
*   `time_limit_ms`: ユーザープログラムの実行時間制限 (ミリ秒単位)。
*   `memory_limit_kb`: ユーザープログラムのメモリ使用量制限 (キロバイト単位)。
*   `total_max_points`: 問題全体の満点。フロントエンドでの表示や集計に使われることがあります。

**評価モード別設定:**

*   **`standard` モード:**
    *   `test_case_categories`: テストケースをカテゴリ分けして管理できます。各カテゴリはポイントを持ち、複数のテストケースを含みます。
    *   `test_cases` (カテゴリ内): 各テストケースは入力ファイル (`input`) と期待される出力ファイル (`output`) のパスを指定します。パスは問題ディレクトリからの相対パスです。

*   **`custom_evaluator` モード:**
    *   `custom_evaluator_options`:
        *   `evaluator_script`: カスタム評価スクリプトのファイル名 (問題ディレクトリからの相対パス)。
        *   `evaluator_language`: 評価スクリプトの言語 (`language_definitions.js` で定義されているもの)。
        *   `evaluator_time_limit_ms`: (任意) 評価スクリプト自体の実行時間制限。
    *   `test_cases` (ルートレベル): カスタム評価用のテストケース定義。
        *   `id`: テストケースの一意なID。
        *   `name`: テストケースの説明。
        *   `points`: このテストケースの配点。
        *   `data_file`: 評価スクリプトがこのテストケースの評価に使用するデータファイルへのパス (問題ディレクトリからの相対パス)。評価スクリプトは、このファイルパスを引数として受け取ります。

*   **`interactive` モード:**
    *   `interactive_evaluator_options`:
        *   `evaluator_script_relative_path`: インタラクティブ評価スクリプトのファイル名 (問題ディレクトリからの相対パス)。
        *   `evaluator_language`: 評価スクリプトの言語。
    *   `test_cases` (ルートレベル): インタラクティブ評価用のテストセッション定義。
        *   `id`: セッションの一意なID。
        *   `name`: セッションの説明。
        *   `points`: このセッションの配点。
        *   `evaluator_params`: このインタラクティブセッションを実行する際に、評価スクリプトに渡されるパラメータオブジェクト。評価スクリプトは通常、環境変数などを介してこのJSON文字列を受け取りパースして使用します。

### 5.3. テストケースと評価スクリプトの配置

*   **標準評価のテストケース**:
    *   問題ディレクトリ内に `tests` というサブディレクトリを作成し、その中に `case1.in`, `case1.out`, `case2.in`, `case2.out` のように配置するのが一般的です。`meta.json` のパス指定もこれに合わせます。
*   **カスタム評価/インタラクティブ評価のスクリプト**:
    *   `meta.json` と同じ問題ディレクトリ内に配置するのが基本です。
    *   `evaluator_script` や `evaluator_script_relative_path` で指定した名前と一致させてください。
*   **カスタム評価のデータファイル**:
    *   テストケースごとに異なるデータファイルを使用する場合、問題ディレクトリ内に例えば `test_data` のようなサブディレクトリを作り、そこにまとめて配置し、`meta.json` の `data_file` で指定するのが整理しやすいでしょう。

```

## 6. 評価ロジック詳解

コードの評価は `executor` サービス内の `ExecutionService.js` が中心となって行われます。このサービスは、提出されたコードを安全に実行し、定義された評価モードに基づいて採点します。

### 6.1. `ExecutionService.js` の役割

*   **コードのコンパイル**: 必要に応じて、提出されたソースコードをコンパイルします (例: C++, Java)。
*   **コードの実行**: コンパイルされた実行可能ファイルまたはスクリプトを実行します。実行時には、`ulimit` コマンド (Linux/macOS) やプロセス監視を通じて、時間制限 (TLE) およびメモリ制限 (MLE) を厳格に適用します。
*   **標準入出力の処理**: 標準入力 (`stdin`) をユーザープログラムに渡し、標準出力 (`stdout`) および標準エラー出力 (`stderr`) をキャプチャします。
*   **評価モードの分岐**: `meta.json` の `evaluation_mode` に基づいて、評価フローを切り替えます。

### 6.2. 標準評価 (Standard Evaluation)

*   **流れ**:
    1.  `next-app/pages/api/submit.js` は、`meta.json` に定義された各テストケースカテゴリおよびテストケースを順に処理します。
    2.  各テストケースについて、入力ファイルの内容を `stdin` として `executor` サービスの `/execute` エンドポイントに送信し、ユーザーコードを実行させます。
    3.  `ExecutionService.js` はユーザーコードを実行し、その `stdout` を取得します。
    4.  `submit.js` は、得られた `stdout` と、テストケースに対応する期待される出力ファイルの内容を比較します。
    5.  完全に一致すれば `Accepted`、そうでなければ `Wrong Answer` となります。TLE、MLE、Runtime Error などもここで判定されます。
*   **関連ファイル**:
    *   `meta.json`: `evaluation_mode: "standard"`、`test_case_categories` とその中の `test_cases` (input/outputファイルパス)。
    *   `next-app/problems/<problem_id>/tests/`: テストケースファイル群。

### 6.3. カスタム評価 (Custom Evaluator)

*   **流れ**:
    1.  `next-app/pages/api/submit.js` は、まずユーザーコードを実行するために `executor` サービスの `/execute` エンドポイントを呼び出します (この際、テストケース固有の入力は通常ありませんが、問題設計による)。ユーザーコードの `stdout` を取得します。
    2.  次に、`submit.js` は `executor` サービスの `/evaluate` エンドポイントを呼び出します。この際、以下の情報を渡します。
        *   `evaluator_script_host_path`: 評価スクリプトへのホストOS上での絶対パス。
        *   `user_solution_content`: ユーザーコードの `stdout`。
        *   `test_data_host_path`: `meta.json` の `test_cases[i].data_file` で指定された、このテストケース評価用のデータファイルへのホストOS上での絶対パス。
        *   `max_points`: このテストケースの最大得点。
        *   `evaluator_language`: 評価スクリプトの言語。
    3.  `ExecutionService.js` (`evaluateCode` メソッド) は、指定された評価スクリプトを実行します。評価スクリプトは、上記の引数 (ユーザー解答内容ファイルパス、テストデータファイルパス、最大得点) をコマンドライン引数として受け取ります。
    4.  評価スクリプトは、独自のロジックで採点を行い、結果をJSON形式で自身の標準出力に出力します。JSONには通常、獲得点数 (`score`) とメッセージ (`message`) が含まれます。
        ```json
        // 評価スクリプトが出力するJSONの例
        {
          "score": 50, // 獲得点数
          "message": "部分的に正解です" // 結果メッセージ
        }
        ```
    5.  `ExecutionService.js` はこのJSONをパースし、結果を `submit.js` に返します。
*   **関連ファイル**:
    *   `meta.json`: `evaluation_mode: "custom_evaluator"`、`custom_evaluator_options` (評価スクリプト名、言語)、`test_cases` (各テストケースの `data_file`、ポイント)。
    *   `next-app/problems/<problem_id>/<evaluator_script>`: 評価スクリプト本体。
    *   `next-app/problems/<problem_id>/<data_file>`: 評価用データファイル。

### 6.4. インタラクティブ評価 (Interactive Evaluation)

*   **流れ**:
    1.  `next-app/pages/api/submit.js` は、`executor` サービスの `/execute_interactive` エンドポイントを呼び出します。この際、以下の情報を渡します。
        *   ユーザーコード、言語。
        *   `evaluator_script_host_path`: インタラクティブ評価スクリプトへのホストOS上での絶対パス。
        *   `evaluator_language`: 評価スクリプトの言語。
        *   `evaluator_startup_data`: `meta.json` の `test_cases[i].evaluator_params` をJSON文字列化したもの。評価スクリプトがセッションの初期設定に使用します。
        *   実行時間・メモリ制限。
    2.  `ExecutionService.js` (`startInteractiveSession` メソッド) は、ユーザープログラムと評価スクリプトを同時に起動し、両者の標準入出力を相互にパイプで接続します (ユーザーstdout -> 評価stdin, 評価stdout -> ユーザーstdin)。
    3.  評価スクリプトは、`evaluator_startup_data` (環境変数 `EVALUATOR_PARAMS` 経由で渡される想定) を読み込み、セッションの準備をします (例: 秘密の数字Nを決定)。
    4.  評価スクリプトは、ユーザープログラムに最初のメッセージを送るか、ユーザープログラムからの最初の入力を待ちます (問題仕様による)。
    5.  ユーザープログラムと評価スクリプトが対話を行います。
        *   ユーザープログラムは自身の標準出力に解答や問い合わせを出力します。
        *   評価スクリプトはそれを自身の標準入力で受け取り、処理し、フィードバックや次の情報を自身の標準出力に出力します。
    6.  評価スクリプトは、対話の終了条件 (正解、不正解、規定回数超過など) を判断した際に、特定のシグナル文字列 (例: `__AC__
メッセージ` や `__WA__
メッセージ`) を自身の標準出力の末尾に出力し、終了します。
    7.  `ExecutionService.js` はこのシグナル文字列を検出し、インタラクションの最終結果 (Accepted, WrongAnswerなど) を判断します。全体のインタラクションログも収集します。
*   **関連ファイル**:
    *   `meta.json`: `evaluation_mode: "interactive"`、`interactive_evaluator_options` (評価スクリプト名、言語)、`test_cases` (各セッションの `evaluator_params`、ポイント)。
    *   `next-app/problems/<problem_id>/<evaluator_script>`: インタラクティブ評価スクリプト本体。

### 6.5. 対応言語と追加 (`language_definitions.js`)

*   `executor/language_definitions.js` ファイルは、サポートされているプログラミング言語ごとに、コンパイルコマンド (`get_compilation_command`) と実行コマンド (`get_execution_command`) を定義しています。
*   新しい言語をサポートに追加するには、このファイルに適切な定義を追加し、対応する実行環境が `executor` の Docker イメージ (`executor/Dockerfile`) に含まれていることを確認する必要があります。

## 7. APIエンドポイント

システムは、Next.jsアプリケーション内のAPIルートと、独立した`executor`サービスのAPIエンドポイントの2層構造でAPIを提供しています。

### 7.1. Next.js APIルート (`next-app/pages/api/`)

これらは主にフロントエンドからのリクエストを処理し、必要に応じて `executor` サービスを呼び出します。

*   **`POST /api/submit`**:
    *   役割: コード提出処理のメインエンドポイント。
    *   リクエストボディ:
        *   `problemId` (string): 問題ID。
        *   `language` (string): 提出言語。
        *   `code` (string): 提出されたソースコード。
    *   レスポンス: Server-Sent Events (SSE) ストリーム。評価の進捗 (`test_case_result`, `interactive_turn` など) や最終結果 (`final_result`) をリアルタイムでクライアントに送信します。
    *   内部処理:
        *   問題の `meta.json` を読み込み、評価モードを判別。
        *   評価モードに応じて `executor` サービスの適切なエンドポイントを呼び出します。
        *   `executor` からの応答を整形し、SSEとしてクライアントに中継します。

*   **`POST /api/execute`**: (もし `next-app/pages/api/execute.js` が存在し、汎用的な実行機能を提供している場合)
    *   役割: コードの単純実行リクエストを処理 (主にテストやデバッグ用)。
    *   リクエストボディ:
        *   `language` (string): 言語。
        *   `code` (string): ソースコード。
        *   `stdin` (string, optional): 標準入力。
    *   レスポンス: JSONオブジェクト。
        *   `result` (string): 実行結果の標準出力またはエラーメッセージ。
    *   注: このエンドポイントは `docker run` を直接使用しており、`executor` サービスを経由しない簡易的なものです。リソース制限などは限定的です。

### 7.2. Executorサービス APIエンドポイント (`executor/server.js`)

これらはコードの実際のコンパイル、実行、評価を担当します。通常、Next.jsのバックエンドAPIから呼び出されます。

*   **`POST /execute`**:
    *   役割: 単一のコード実行リクエストを処理。
    *   リクエストボディ:
        *   `language` (string): 言語。
        *   `code` (string): ソースコード。
        *   `stdin` (string, optional): 標準入力。
        *   `time_limit_ms` (number, optional): 実行時間制限。
        *   `memory_limit_kb` (number, optional): メモリ制限。
    *   レスポンス: JSONオブジェクト。実行結果、リソース使用量、エラー情報など。
        ```json
        // 成功時 (例)
        {
          "stdout": "Hello World
",
          "stderr": "",
          "exitCode": 0,
          "signal": null,
          "durationMs": 15,
          "memoryKb": 8000,
          "errorType": null
        }
        // エラー時 (例: TLE)
        {
          "stdout": "...",
          "stderr": "...",
          "exitCode": null, // or non-zero
          "signal": "SIGKILL", // or other
          "durationMs": 2050,
          "memoryKb": 9000,
          "errorType": "timeout",
          "message": "Execution timed out."
        }
        ```

*   **`POST /evaluate`**:
    *   役割: カスタム評価スクリプトを用いた評価を実行。
    *   リクエストボディ:
        *   `evaluator_script_host_path` (string): 評価スクリプトのホストOS上の絶対パス。
        *   `user_solution_content` (string): ユーザーコードの標準出力。
        *   `test_data_host_path` (string): テストデータファイルのホストOS上の絶対パス。
        *   `max_points` (number): このテストケースの最大得点。
        *   `evaluator_language` (string): 評価スクリプトの言語。
        *   `timeout` (number, optional): 評価スクリプト自体の実行時間制限。
    *   レスポンス: JSONオブジェクト。評価結果 (評価スクリプトの出力JSONを含む)。
        ```json
        // 成功時 (例)
        {
          "success": true,
          "evaluation_result": { "score": 10, "message": "Correct" },
          "stderr": "", // evaluator script's stderr
          "durationMs": 120
        }
        // 失敗時 (例: evaluator script error)
        {
          "success": false,
          "error_type": "evaluator_runtime_error",
          "message": "Evaluator exited with code 1.",
          "stdout": "...", // evaluator script's stdout
          "stderr": "Error in evaluator...",
          "durationMs": 90
        }
        ```

*   **`POST /execute_interactive`**:
    *   役割: インタラクティブ評価セッションを実行。
    *   リクエストボディ:
        *   `language` (string): ユーザーコードの言語。
        *   `code` (string): ユーザーコードのソース。
        *   `evaluator_script_host_path` (string): 評価スクリプトのホストOS上の絶対パス。
        *   `evaluator_language` (string): 評価スクリプトの言語。
        *   `evaluator_startup_data` (string, optional): 評価スクリプトへの初期化データ (JSON文字列など)。
        *   `time_limit_ms` (number): ユーザーコードの実行時間制限。
        *   `memory_limit_kb` (number): ユーザーコードのメモリ制限。
    *   レスポンス: JSONオブジェクト。インタラクションの最終結果、ログ、リソース使用量など。
        ```json
        // 終了時 (例: Accepted)
        {
          "status": "Accepted",
          "message": "Correct guess!",
          "interaction_log": [
            { "source": "evaluator", "data": "100
", "timestamp": ... },
            { "source": "user", "data": "50
", "timestamp": ... },
            { "source": "evaluator", "data": "lower
", "timestamp": ... },
            // ...
          ],
          "durationMs": 55,
          "memoryKb": 8500,
          "user_stderr": "",
          "evaluator_stderr": "Evaluator log line 1
"
        }
        ```
```

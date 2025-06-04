# Evaluator Scripts

このディレクトリには問題ごとのカスタム評価スクリプトを配置します。
各スクリプトは標準入力からユーザプログラムの出力を受け取り、評価結果を
数値で標準出力の最後の行に出力する形式を想定しています。

`meta.json` の `custom_evaluator_options` で以下の項目を設定すると、任意の
評価スクリプトを Docker コンテナ内で実行できます。

- `evaluator_script` : このディレクトリ以下に置いた評価スクリプトへのパス
- `test_case_data_path_template` : 各テストケースで読み込むデータファイルのパス
- `docker_image` : 評価スクリプトを実行する Docker イメージ (省略時は `python:3.11-slim`)
- `command_template` : コンテナ内で実行するコマンド文字列。
  `{evaluator_path}`、`{testcase_path}`、`{user_output_path}` を置き換えます。

`tsp_evaluator.py` や `knapsack_evaluator.py` が Python 製スクリプトの例です。
他の言語で評価ロジックを実装する場合は、上記オプションを調整してください。

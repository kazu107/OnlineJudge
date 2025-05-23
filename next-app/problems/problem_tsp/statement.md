# 巡回セールスマン問題 (TSP)

## 問題概要
与えられた都市のリストと各都市間の距離（または座標）に基づき、すべての都市を一度ずつ訪れて出発点に戻る最短の経路を見つけてください。

## 入力
この問題では、ユーザーコードへの直接の標準入力はありません。各テストケースの都市データは、評価プログラムが内部で読み込みます。

## 出力
発見した最短経路の都市の訪問順序を、都市IDをスペース区切りで1行に出力してください。経路は出発点と同じ都市で終わる必要があります。
例: `A B D C A`

## 評価
提出された解答（都市の訪問順序）は、各テストケース専用の評価プログラムによって評価されます。
- 提出された経路が有効であるか（すべての都市を訪問しているか、始点と終点が一致しているかなど）がチェックされます。
- 有効な経路の場合、その総移動距離が計算されます。
- 総移動距離と、あらかじめ設定された基準距離（または最適距離）とを比較して点数が決定されます。距離が短いほど高得点となります。
- 各テストケースの評価結果（得点と総移動距離）がフィードバックされます。

## テストケースの例
- **tsp_5_cities**: 5都市のインスタンス。
- **tsp_10_cities**: 10都市のインスタンス。
- **tsp_challenge_15_cities**: より挑戦的な15都市のインスタンス。

都市の座標は、各テストケースのデータファイルにJSON形式で定義されています。

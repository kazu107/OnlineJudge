# 問題: 巡回セールスマン問題 解説

巡回セールスマン問題 (Traveling Salesperson Problem, TSP) は、与えられた都市の集合を全て一度ずつ訪れて出発点に戻ってくる際の最短経路を求める組み合わせ最適化問題です。

### 解法アプローチ
都市の数が少ない場合 (Nが10程度まで) は、全ての可能な経路を試し（順列を列挙し）、それぞれの経路長を計算して最小のものを見つけるブルートフォース（全探索）アプローチが考えられます。

都市iから都市jへの距離は、ユークリッド距離 `sqrt((x_i - x_j)^2 + (y_i - y_j)^2)` で計算できます。

例えば、N=3の場合、都市1を始点と終点とすると、考えられる経路は以下の2つです（対称な経路を除く）。
1. 1 -> 2 -> 3 -> 1
2. 1 -> 3 -> 2 -> 1

これらの経路長を計算し、短い方を選択します。

より大きなNに対しては、動的計画法（Held-Karpアルゴリズムなど）や、近似アルゴリズム（最近傍法、2-opt法など）、ヒューリスティクス（遺伝的アルゴリズム、焼きなまし法など）が用いられます。

この問題の制約 (N <= 10) では、全探索で十分間に合います。具体的には、都市1を除く (N-1)! 通りの順列を試し、それぞれの経路長を計算します。
```
---

### 解答例 (Python)

以下は、都市の数が少ない場合にブルートフォース（全探索）で最短経路と経路を出力するPythonのコード例です。
このコードは、始点（都市1）から他の全ての都市を一度ずつ訪れて始点に戻る全ての順列を試し、総距離が最短となる経路を見つけます。
そして、その経路（都市のインデックスのリスト、1-indexed）を標準出力に1行ずつ出力します。

```python
import math
from itertools import permutations

def calculate_total_distance(path_indices, cities_coords):
    # 指定された経路(0-indexedの都市座標リストインデックス)の総距離を計算する
    total_dist = 0
    for i in range(len(path_indices) - 1):
        p1_coords = cities_coords[path_indices[i]]
        p2_coords = cities_coords[path_indices[i+1]]
        total_dist += math.sqrt((p1_coords[0] - p2_coords[0])**2 + (p1_coords[1] - p2_coords[1])**2)
    return total_dist

def solve_tsp():
    N = int(input())
    cities_coords = [] # 0-indexedで都市の座標を格納 (x, y)
    for _ in range(N):
        x, y = map(int, input().split())
        cities_coords.append((x, y))

    if N == 0:
        return
    if N == 1:
        print(1) # 都市1を訪問して終了 (評価スクリプトは経路を期待)
        return

    # 都市0 (問題文の都市1) を除く、他の都市のインデックス (0-indexed)
    other_city_indices_0_indexed = list(range(1, N))

    min_overall_distance = float('inf')
    best_path_for_evaluator = [] # 1-indexed の都市番号リスト

    # 都市0 (都市1) を始点および終点とする
    start_node_0_indexed = 0

    for p in permutations(other_city_indices_0_indexed):
        current_path_0_indexed = [start_node_0_indexed] + list(p) + [start_node_0_indexed]
        
        current_total_distance = calculate_total_distance(current_path_0_indexed, cities_coords)

        if current_total_distance < min_overall_distance:
            min_overall_distance = current_total_distance
            # 評価スクリプト用に1-indexedの都市番号リストを作成
            best_path_for_evaluator = [idx + 1 for idx in current_path_0_indexed]

    # 最短経路(都市の番号リスト)を1行ずつ出力
    if best_path_for_evaluator:
        print(*(best_path_for_evaluator))
    # Fallback for N=0 or N=1 if not handled, though N=1 is handled.

if __name__ == "__main__":
    solve_tsp()
```

このコードは、`evaluators/tsp_evaluator.py` が標準入力から都市の訪問順（1-indexed）を読み込むことを想定しています。
また、都市の座標は0-indexedで処理し、最終的な出力時（および`calculate_total_distance`関数内での座標アクセス時）に注意しています。
`calculate_total_distance`関数は、経路が都市の座標リストに対する0-indexedのインデックスリストとして渡されることを想定しています。
`solve_tsp`関数内で、`permutations`で得られた0-indexedの都市リスト `p` をもとに、始点と終点（都市0）を含む0-indexedの経路 `current_path_0_indexed` を作成し、距離計算後、評価スクリプトへの出力用に1-indexedの `best_path_for_evaluator` を作成・更新します。
```

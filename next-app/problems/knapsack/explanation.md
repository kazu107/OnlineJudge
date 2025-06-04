# ナップサック問題 解説

ナップサック問題は重さの制約下で価値を最大化する組み合わせ最適化問題です。ここでは $O(NW)$ の動的計画法による解法を紹介します。

以下のコードは、与えられた品物を使って最適な価値を計算し、どの品物を選ぶかを復元して番号を出力する例です。

```python
def solve():
    import sys
    input = sys.stdin.readline
    N, W = map(int, input().split())
    items = [tuple(map(int, input().split())) for _ in range(N)]
    dp = [[0]*(W+1) for _ in range(N+1)]
    take = [[False]*(W+1) for _ in range(N+1)]
    for i, (w, v) in enumerate(items, start=1):
        for j in range(W+1):
            dp[i][j] = dp[i-1][j]
            if j >= w and dp[i-1][j-w] + v > dp[i][j]:
                dp[i][j] = dp[i-1][j-w] + v
                take[i][j] = True
    j = W
    res = []
    for i in range(N, 0, -1):
        if take[i][j]:
            res.append(i)
            j -= items[i-1][0]
    print(' '.join(map(str, reversed(res))))

if __name__ == '__main__':
    solve()
```

このジャッジでは `custom_evaluator_options` を利用して、`evaluators/knapsack_evaluator.py` により出力された品物の価値が最適解とどれだけ離れているかを評価します。

import sys
def parse_case(path):
    with open(path) as f:
        lines = [line.strip() for line in f if line.strip()]
    n, W = map(int, lines[0].split())
    items = [tuple(map(int, line.split())) for line in lines[1:n+1]]
    return n, W, items


def compute_optimal(n, W, items):
    dp = [0]*(W+1)
    for w, v in items:
        for j in range(W, w-1, -1):
            if dp[j-w] + v > dp[j]:
                dp[j] = dp[j-w] + v
    return max(dp)


def main():
    if len(sys.argv) < 2:
        print("-1")
        return
    case_path = sys.argv[1]
    try:
        n, W, items = parse_case(case_path)
        opt = compute_optimal(n, W, items)
    except Exception:
        print("-1")
        return

    line = sys.stdin.readline().strip()
    if line:
        try:
            indices = list(map(int, line.split()))
        except ValueError:
            print("-1")
            return
    else:
        indices = []

    if any(i < 1 or i > n for i in indices) or len(set(indices)) != len(indices):
        print("-1")
        return

    total_w = sum(items[i-1][0] for i in indices)
    total_v = sum(items[i-1][1] for i in indices)
    if total_w > W:
        print("-1")
        return

    diff = opt - total_v
    if diff < 0:
        diff = 0
    print(f"{diff}")


if __name__ == "__main__":
    main()

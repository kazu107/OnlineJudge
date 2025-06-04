import sys
import math

def calculate_distance(p1, p2):
    return math.sqrt((p1[0] - p2[0])**2 + (p1[1] - p2[1])**2)

def main():
    if len(sys.argv) < 2:
        print("Error: Test case file path not provided.", file=sys.stderr)
        print("-1.0") 
        return

    test_case_file = sys.argv[1]
    
    try:
        # --- 変更箇所 ---
        user_path_str_list = sys.stdin.readline().strip().split()
        user_path_indices = []

        if not user_path_str_list or not user_path_str_list[0]: # 入力が空(または最初の要素が空文字列)の場合
            print("Error: User output path is empty.", file=sys.stderr)
            print("-1.0")
            return

        for s_idx in user_path_str_list:
            try:
                city_index = int(s_idx)
                user_path_indices.append(city_index)
            except ValueError:
                print(f"Error: Invalid city index in user output: '{s_idx}'", file=sys.stderr)
                print("-1.0")
                return
        # --- 変更箇所ここまで ---

        cities = []
        with open(test_case_file, 'r') as f:
            num_cities = int(f.readline().strip())
            for _ in range(num_cities):
                x, y = map(int, f.readline().split())
                cities.append((x, y))

        if not user_path_indices: # このチェックは上の空リストチェックでカバーされるが念のため
            print("Error: User output path parsed as empty.", file=sys.stderr)
            print("-1.0")
            return
        
        # Path validation logic (変更なし、user_path_indices をそのまま使用)
        path_to_validate = []
        returns_to_start_explicitly = False

        if len(user_path_indices) == num_cities:
            if user_path_indices[0] != 1:
                print(f"Error: Path must start from city 1. Got: {user_path_indices[0]}", file=sys.stderr)
                print("-1.0")
                return
            path_to_validate = user_path_indices
        elif len(user_path_indices) == num_cities + 1:
            if user_path_indices[0] != 1 or user_path_indices[-1] != 1:
                print(f"Error: Path of length N+1 must start and end with city 1. Got start: {user_path_indices[0]}, end: {user_path_indices[-1]}", file=sys.stderr)
                print("-1.0")
                return
            path_to_validate = user_path_indices[:-1] 
            returns_to_start_explicitly = True
        else:
            print(f"Error: Path must contain {num_cities} (implicitly returning to start) or {num_cities + 1} (explicitly returning to start) cities, but got {len(user_path_indices)}.", file=sys.stderr)
            print("-1.0")
            return

        if len(set(path_to_validate)) != num_cities:
            print(f"Error: Path must visit all {num_cities} cities exactly once. Visited set: {sorted(list(set(path_to_validate)))}", file=sys.stderr)
            print("-1.0")
            return
        
        for i in range(1, num_cities + 1):
            if i not in path_to_validate: 
                print(f"Error: City {i} was not visited in the main path.", file=sys.stderr)
                print("-1.0")
                return

        # Distance calculation logic (変更なし)
        total_distance = 0.0
        for i in range(len(path_to_validate) - 1):
            city1_idx = path_to_validate[i]
            city2_idx = path_to_validate[i+1]
            total_distance += calculate_distance(cities[city1_idx-1], cities[city2_idx-1])
        
        last_city_in_sequence_idx = path_to_validate[-1]
        start_city_idx = path_to_validate[0] 

        total_distance += calculate_distance(cities[last_city_in_sequence_idx-1], cities[start_city_idx-1] if returns_to_start_explicitly else cities[0])

        print(f"{total_distance:.8f}")

    except FileNotFoundError:
        print(f"Error: Test case file not found at {test_case_file}", file=sys.stderr)
        print("-1.0")
    except Exception as e:
        print(f"An unexpected error occurred: {str(e)}", file=sys.stderr)
        print("-1.0")

if __name__ == "__main__":
    main()
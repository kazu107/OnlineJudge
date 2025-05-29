import sys
import math

def calculate_distance(p1, p2):
    return math.sqrt((p1[0] - p2[0])**2 + (p1[1] - p2[1])**2)

def main():
    if len(sys.argv) < 2:
        print("Error: Test case file path not provided.", file=sys.stderr)
        print("-1.0") # Indicate error with a score
        return

    test_case_file = sys.argv[1]
    
    try:
        user_path_indices = []
        for line in sys.stdin:
            try:
                city_index = int(line.strip())
                user_path_indices.append(city_index)
            except ValueError:
                print(f"Error: Invalid city index in user output: {line.strip()}", file=sys.stderr)
                print("-1.0")
                return

        cities = []
        with open(test_case_file, 'r') as f:
            num_cities = int(f.readline().strip())
            for _ in range(num_cities):
                x, y = map(int, f.readline().split())
                cities.append((x, y))

        if not user_path_indices:
            print("Error: User output is empty.", file=sys.stderr)
            print("-1.0")
            return

        # Validate path
        # Path should represent visiting N unique cities, starting and ending at city 1.
        # User can provide N cities (1, 2, 3 for N=3, implies 1->2->3->1)
        # Or N+1 cities (1, 2, 3, 1 for N=3)

        path_to_validate = []
        returns_to_start_explicitly = False

        if len(user_path_indices) == num_cities:
            # Assumes the path is N distinct cities, starting with city 1.
            # The return to city 1 is implicit.
            if user_path_indices[0] != 1:
                print(f"Error: Path must start from city 1. Got: {user_path_indices[0]}", file=sys.stderr)
                print("-1.0")
                return
            path_to_validate = user_path_indices
        elif len(user_path_indices) == num_cities + 1:
            # Assumes path is N+1 cities, starting and ending with city 1.
            if user_path_indices[0] != 1 or user_path_indices[-1] != 1:
                print(f"Error: Path of length N+1 must start and end with city 1. Got start: {user_path_indices[0]}, end: {user_path_indices[-1]}", file=sys.stderr)
                print("-1.0")
                return
            path_to_validate = user_path_indices[:-1] # Validate the N unique cities part
            returns_to_start_explicitly = True
        else:
            print(f"Error: Path must contain {num_cities} (implicitly returning to start) or {num_cities + 1} (explicitly returning to start) cities, but got {len(user_path_indices)}.", file=sys.stderr)
            print("-1.0")
            return

        # Check if all N cities are visited exactly once in the path_to_validate
        if len(set(path_to_validate)) != num_cities:
            print(f"Error: Path must visit all {num_cities} cities exactly once. Visited set: {sorted(list(set(path_to_validate)))}", file=sys.stderr)
            print("-1.0")
            return
        
        for i in range(1, num_cities + 1):
            if i not in path_to_validate: # Check against the (potentially N) unique cities
                print(f"Error: City {i} was not visited in the main path.", file=sys.stderr)
                print("-1.0")
                return

        # Calculate total distance
        total_distance = 0.0
        
        # Iterate through the path_to_validate (which is 1-indexed city numbers)
        for i in range(len(path_to_validate) - 1):
            city1_idx = path_to_validate[i]
            city2_idx = path_to_validate[i+1]
            total_distance += calculate_distance(cities[city1_idx-1], cities[city2_idx-1])
        
        # Add distance from the last city in path_to_validate back to the starting city (city 1)
        last_city_in_sequence_idx = path_to_validate[-1]
        start_city_idx = path_to_validate[0] # Should be 1

        # If the user provided N cities, or N+1 and the explicit return was already handled by loop
        # This connects the end of the sequence back to the actual start (city 1 / cities[0])
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

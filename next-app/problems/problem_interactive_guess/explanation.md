# Explanation for Interactive Guessing Game

This problem tests your ability to communicate with an interactive evaluator and implement a binary search algorithm (or a similar efficient guessing strategy).

## Key Concepts:
- **Interactive Problems:** Your program needs to read input from the evaluator and print output to it in a loop. Remember to flush your output buffer.
- **Binary Search:** For a sorted range of numbers, binary search is an efficient way to find a target number. In each step, you guess the middle element and the evaluator tells you if the target is higher or lower, effectively halving the search space.

## Evaluator Logic:
The evaluator will:
1. Receive `N` (the upper bound for the secret number) and `max_guesses` from the `evaluator_params` in `meta.json` (passed as `evaluator_startup_data`).
2. Pick a secret number between 1 and `N`.
3. Read your guess.
4. Compare it to the secret number and print "HIGHER", "LOWER", or "CORRECT".
5. If you exceed `max_guesses` or make an invalid guess (e.g., non-numeric), it will terminate the interaction, likely resulting in a "WRONG_ANSWER".

## Example Interaction (N=10, max_guesses=4, secret=7):
User: 5 (flush)
Evaluator: HIGHER
User: 8 (flush)
Evaluator: LOWER
User: 7 (flush)
Evaluator: CORRECT

If the user then makes another guess or doesn't stop, the evaluator might consider it a protocol violation. Once "CORRECT" is received, your program should typically exit gracefully.

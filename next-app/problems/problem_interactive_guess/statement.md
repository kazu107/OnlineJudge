# Interactive Guessing Game

The goal of this game is to guess a secret number chosen by the evaluator.
The range of the number and the maximum number of guesses allowed will be given at the start of each game.

You need to print your guess, and the evaluator will respond with:
- "HIGHER" if your guess is too low.
- "LOWER" if your guess is too high.
- "CORRECT" if your guess is correct.
- "WRONG_ANSWER" or other messages if you exceed the maximum number of guesses or make an invalid move.

Make sure to flush your output after each guess. For example, in Python, use `print(guess, flush=True)`. In C++, use `std::cout << guess << std::endl;`. In Java, use `System.out.println(guess);` followed by `System.out.flush();`.

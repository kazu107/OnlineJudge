import sys
import json
import os
import random

def log_message(message):
    # Evaluator stderr can be used for logging/debugging by the judge system
    print(message, file=sys.stderr, flush=True)

def send_to_user_program(message):
    print(message, flush=True) # Output to user program (via stdout)
    log_message(f"Evaluator sent: {message}")

def read_from_user_program():
    line = sys.stdin.readline().strip()
    log_message(f"Evaluator received: {line}")
    return line

if __name__ == "__main__":
    log_message("Evaluator script started.")

    params_str = os.environ.get("EVALUATOR_PARAMS")
    if not params_str:
        log_message("Error: EVALUATOR_PARAMS environment variable not set.")
        send_to_user_program("__WA__\nError: Missing evaluator parameters.")
        sys.exit(1)

    try:
        params = json.loads(params_str)
        N = int(params.get("N", 100))
        max_guesses = int(params.get("max_guesses", 7))
        # For a real judge, the target might be fixed or derived from a seed for this specific test run.
        # For this example, we'll generate it randomly based on N.
        target_number = random.randint(1, N) 
        log_message(f"Parameters loaded: N={N}, max_guesses={max_guesses}. Target is {target_number}")

    except Exception as e:
        log_message(f"Error parsing EVALUATOR_PARAMS: {e}")
        send_to_user_program(f"__WA__\nError: Invalid evaluator parameters: {e}")
        sys.exit(1)
    
    # Initial message to user program: send N.
    send_to_user_program(str(N))

    guesses_made = 0
    correct_guess = False

    for _ in range(max_guesses):
        guesses_made += 1
        log_message(f"Waiting for guess {guesses_made}/{max_guesses}...")
        
        try:
            user_guess_str = read_from_user_program()
            if not user_guess_str: # Handle EOF or empty line if user program exits
                log_message("User program exited or sent empty line.")
                send_to_user_program("__WA__\nUser program exited prematurely or sent empty input.")
                sys.exit(0) # Exit 0 because WA is a valid test outcome reported by the evaluator

            user_guess = int(user_guess_str)
        
        except ValueError:
            log_message(f"Invalid guess format: {user_guess_str}")
            send_to_user_program("__WA__\nInvalid guess format. Send an integer.")
            sys.exit(0) # Exit 0, WA reported
        except Exception as e: # Catch other potential errors during read
            log_message(f"Error reading from user program: {e}")
            send_to_user_program(f"__WA__\nError reading your guess: {e}")
            sys.exit(0)


        if user_guess == target_number:
            log_message("Correct guess!")
            send_to_user_program("correct") # Send feedback to user
            send_to_user_program(f"__AC__\nCorrect guess!") # Signal Acceptance
            correct_guess = True
            break
        elif user_guess < target_number:
            log_message("Guess is too low.")
            send_to_user_program("lower")
        else: # user_guess > target_number
            log_message("Guess is too high.")
            send_to_user_program("higher")
    
    if not correct_guess:
        log_message("User failed to guess the number within limits.")
        # The last "lower" or "higher" is already sent.
        # If the loop finishes due to max_guesses, it's a WA.
        send_to_user_program(f"__WA__\nExceeded maximum guesses. The number was {target_number}.")
    
    log_message("Evaluator script finished.")
    sys.exit(0) # Evaluator itself exits cleanly after signaling AC/WA.

#!/bin/bash
LANGUAGE=$1
CODEFILE=$2

# 開始時刻をミリ秒単位で取得
start=$(date +%s%3N)

case "$LANGUAGE" in
  python)
    if [ -f /code/input.txt ]; then
      output=$( { /usr/bin/time -f "MEM:%M" python3 "$CODEFILE" < /code/input.txt; } 2>&1 )
    else
      output=$( { /usr/bin/time -f "MEM:%M" python3 "$CODEFILE"; } 2>&1 )
    fi
    ;;
  cpp)
    if [ "$EXECUTE_ONLY" = "true" ]; then
      if [ ! -f /code/a.out ]; then
        echo "Error: /code/a.out not found in execute-only mode." >&2
        exit 1
      fi
      # Execute pre-compiled file
      if [ -f /code/input.txt ]; then
        output=$( { /usr/bin/time -f "MEM:%M" /code/a.out < /code/input.txt; } 2>&1 )
      else
        output=$( { /usr/bin/time -f "MEM:%M" /code/a.out; } 2>&1 )
      fi
    else
      # Compile and execute
      g++ "$CODEFILE" -o /code/a.out
      if [ $? -ne 0 ]; then
        # Capture g++'s error output (which goes to stderr, and will be part of 'output' if time/memusg wraps this whole block)
        # For now, just signal failure clearly and exit.
        # The current script structure captures stderr of the entire command block into 'output'.
        # If g++ fails, its stderr will be in 'output'. The script should then ideally not try to execute.
        # A simple way is to exit.
        echo "Error: C++ compilation failed." >&2 # This specific message might be overwritten if output is captured.
        exit 1 # Exit if compilation fails
      fi
      # Execute compiled file
      if [ -f /code/input.txt ]; then
        output=$( { /usr/bin/time -f "MEM:%M" /code/a.out < /code/input.txt; } 2>&1 )
      else
        output=$( { /usr/bin/time -f "MEM:%M" /code/a.out; } 2>&1 )
      fi
    fi
    ;;
  javascript)
    if [ -f /code/input.txt ]; then
      output=$( { /usr/bin/time -f "MEM:%M" node "$CODEFILE" < /code/input.txt; } 2>&1 )
    else
      output=$( { /usr/bin/time -f "MEM:%M" node "$CODEFILE"; } 2>&1 )
    fi
    ;;
  ruby)
    if [ -f /code/input.txt ]; then
      output=$( { /usr/bin/time -f "MEM:%M" ruby "$CODEFILE" < /code/input.txt; } 2>&1 )
    else
      output=$( { /usr/bin/time -f "MEM:%M" ruby "$CODEFILE"; } 2>&1 )
    fi
    ;;
  java)
    if [ "$EXECUTE_ONLY" = "true" ]; then
      if [ ! -f /code/Main.class ]; then
        echo "Error: /code/Main.class not found in execute-only mode." >&2
        exit 1
      fi
      # Execute pre-compiled class
      if [ -f /code/input.txt ]; then
        output=$( { /usr/bin/time -f "MEM:%M" java -cp /code Main < /code/input.txt; } 2>&1 )
      else
        output=$( { /usr/bin/time -f "MEM:%M" java -cp /code Main; } 2>&1 )
      fi
    else
      # Compile and execute
      javac -d /code "$CODEFILE"
      if [ $? -ne 0 ]; then
        echo "Error: Java compilation failed." >&2
        exit 1 # Exit if compilation fails
      fi
      # Execute compiled class
      if [ -f /code/input.txt ]; then
        output=$( { /usr/bin/time -f "MEM:%M" java -cp /code Main < /code/input.txt; } 2>&1 )
      else
        output=$( { /usr/bin/time -f "MEM:%M" java -cp /code Main; } 2>&1 )
      fi
    fi
    ;;
  *)
    echo "Unsupported language"
    exit 1
    ;;
esac

# 終了時刻をミリ秒単位で取得
end=$(date +%s%3N)
elapsed_ms=$((end - start))

# 出力全体を行単位に分割
IFS=$'\n' read -rd '' -a lines <<< "$output"

# 最終行は "MEM:<値>" としてメモリ使用量情報
mem_line="${lines[-1]}"
unset 'lines[-1]'
program_output=$(printf "%s\n" "${lines[@]}")

# MEM: の部分から数値を抽出
mem_usage=$(echo "$mem_line" | sed -e 's/^MEM://')

# 結果を出力（プログラムの出力の後に TIME_MS と MEM を表示）
echo "$program_output"
echo "TIME_MS:${elapsed_ms} MEM:${mem_usage}"
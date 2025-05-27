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
    g++ "$CODEFILE" -o a.out
    if [ -f /code/input.txt ]; then
      output=$( { /usr/bin/time -f "MEM:%M" ./a.out < /code/input.txt; } 2>&1 )
    else
      output=$( { /usr/bin/time -f "MEM:%M" ./a.out; } 2>&1 )
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
    javac "$CODEFILE"
    if [ -f /code/input.txt ]; then
      output=$( { /usr/bin/time -f "MEM:%M" java Main < /code/input.txt; } 2>&1 )
    else
      output=$( { /usr/bin/time -f "MEM:%M" java Main; } 2>&1 )
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
FROM ubuntu:20.04

ENV DEBIAN_FRONTEND=noninteractive

# build-essential, python, nodejs, ruby, java, time コマンドをインストール
RUN apt-get update && \
    apt-get install -y build-essential python3 nodejs ruby default-jdk time && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /code

# run.sh をコンテナのルートにコピー
COPY run.sh /run.sh
RUN chmod +x /run.sh
# CRLF → LF に変換
RUN sed -i 's/\r$//' /run.sh

# ENTRYPOINT を /run.sh に設定
ENTRYPOINT ["/run.sh"]
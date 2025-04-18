# executor/Dockerfile
FROM ubuntu:20.04

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && \
    apt-get install -y build-essential python3 nodejs ruby default-jdk time && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /code

COPY run.sh /run.sh
RUN chmod +x /run.sh

ENTRYPOINT ["/run.sh"]

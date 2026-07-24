# Network-enabled dependency bootstrap for the matching pinned Debian platform.
ARG DEBIAN_BASE
FROM ${DEBIAN_BASE}
ARG DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      build-essential bison ca-certificates curl file binutils libc-bin libevent-dev \
      libevent-2.1-7 libncurses-dev libncursesw6 pkg-config procps util-linux \
 && rm -rf /var/lib/apt/lists/*

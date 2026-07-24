# syntax=docker/dockerfile:1
ARG RUST_ALPINE_AMD64=rust:1.96.1-alpine@sha256:f5c84c3751de59f0f318acfbed8b2d04693a12d9171f15835d9c11c9ddcf52db
FROM --platform=linux/amd64 ${RUST_ALPINE_AMD64} AS rust-amd64

ARG RUST_ALPINE_ARM64=rust:1.96.1-alpine@sha256:ccba3c5d98fc76a5ac6eade9bcbbb946635657457c3d269982396633a66da08d
FROM --platform=linux/arm64 ${RUST_ALPINE_ARM64} AS rust-arm64

ARG TARGETARCH
FROM rust-${TARGETARCH} AS build

# Build the tmux runtime against the same pinned Debian release as the final image.
FROM debian:bookworm-slim@sha256:7b140f374b289a7c2befc338f42ebe6441b7ea838a042bbd5acbfca6ec875818 AS runtime-files
ARG DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      build-essential ca-certificates curl file binutils libc-bin libevent-dev \
      libevent-2.1-7 libncurses-dev libncursesw6 pkg-config procps util-linux \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /build
RUN curl --fail --location --silent --show-error --output tmux-3.6.tar.gz \
      https://github.com/tmux/tmux/releases/download/3.6/tmux-3.6.tar.gz \
 && echo '136db80cfbfba617a103401f52874e7c64927986b65b1b700350b6058ad69607  tmux-3.6.tar.gz' | sha256sum -c - \
 && tar -xzf tmux-3.6.tar.gz \
 && cd tmux-3.6 \
 && ./configure --prefix=/usr/local \
 && make -j"$(nproc)" \
 && make install

# The final image is assembled solely from the exact base and prepared files;
# it performs no package-index or network operation at runtime-image build time.
FROM debian:bookworm-slim@sha256:7b140f374b289a7c2befc338f42ebe6441b7ea838a042bbd5acbfca6ec875818
COPY --from=runtime-files /usr /usr
COPY --from=runtime-files /lib /lib
COPY --from=runtime-files /lib64 /lib64
ENTRYPOINT ["/bin/sh"]

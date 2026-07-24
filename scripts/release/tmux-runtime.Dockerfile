# Build the tmux runtime against the target platform manifest resolved from the pinned index.
ARG DEBIAN_BASE
FROM ${DEBIAN_BASE} AS runtime-files
ARG DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      build-essential bison ca-certificates curl file binutils libc-bin libevent-dev \
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
FROM ${DEBIAN_BASE}
COPY --from=runtime-files /usr /usr
COPY --from=runtime-files /lib /lib
ENTRYPOINT ["/bin/sh"]

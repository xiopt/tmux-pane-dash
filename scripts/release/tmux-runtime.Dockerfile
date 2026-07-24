# Compile the verified tmux source with the separately-built, pinned bootstrap image.
ARG DEBIAN_BASE
ARG BOOTSTRAP_IMAGE
FROM ${BOOTSTRAP_IMAGE} AS runtime-files
WORKDIR /build
COPY tmux-3.6.tar.gz .
RUN tar -xzf tmux-3.6.tar.gz \
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

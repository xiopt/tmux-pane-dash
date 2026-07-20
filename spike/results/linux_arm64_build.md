# tmux compatibility build provenance — Linux arm64

- OS/arch: Linux aarch64 (Docker `linux/arm64`)
- Base image: `debian:bookworm-slim@sha256:7b140f374b289a7c2befc338f42ebe6441b7ea838a042bbd5acbfca6ec875818`
- Rebuilt image: `tmux-pane-dash-compat:linux-arm64-repro`, image ID `sha256:de86b03d30af8c7831dca25993cfd6414deb0462ac52b7150d469e8442c65108`
- Compiler/linker: Debian GCC 12.2.0 (`12.2.0-14+deb12u1`); GNU ld 2.40
- Make/pkg-config: GNU Make 4.3; pkg-config 1.8.1
- Packages: `bison=2:3.8.2+dfsg-1+b1`, `build-essential=12.9`,
  `libevent-dev=2.1.12-stable-8`, `libncurses-dev=6.4-4`,
  `pkg-config=1.8.1-1`

The temporary Docker build context (outside git) used this source-build loop:

```sh
for ver in 3.2 3.4 3.6; do
  curl --fail --location --retry 3 --output /tmp/tmux-$ver.tar.gz \
    https://github.com/tmux/tmux/releases/download/$ver/tmux-$ver.tar.gz
  tar -xzf /tmp/tmux-$ver.tar.gz -C /tmp
  mkdir /tmp/build-$ver && cd /tmp/build-$ver
  /tmp/tmux-$ver/configure --disable-utf8proc --prefix=/opt/tmux/$ver
  make -j"$(nproc)"
  make install
done
```

The image was rebuilt without a PTY wrapper using:

```sh
docker build --no-cache --platform linux/arm64 \
  --tag tmux-pane-dash-compat:linux-arm64-repro \
  /tmp/tmux-pane-dash-compat-linux-arm64
```

| tmux | Official tarball | Observed SHA-256 | Installed binary |
|---|---|---|---|
| 3.2 | `https://github.com/tmux/tmux/releases/download/3.2/tmux-3.2.tar.gz` | `664d345338c11cbe429d7ff939b92a5191e231a7c1ef42f381cebacb1e08a399` | `/opt/tmux/3.2/bin/tmux` (`tmux 3.2`) |
| 3.4 | `https://github.com/tmux/tmux/releases/download/3.4/tmux-3.4.tar.gz` | `551ab8dea0bf505c0ad6b7bb35ef567cdde0ccb84357df142c254f35a23e19aa` | `/opt/tmux/3.4/bin/tmux` (`tmux 3.4`) |
| 3.6 | `https://github.com/tmux/tmux/releases/download/3.6/tmux-3.6.tar.gz` | `136db80cfbfba617a103401f52874e7c64927986b65b1b700350b6058ad69607` | `/opt/tmux/3.6/bin/tmux` (`tmux 3.6`) |

The committed helper was exercised by this run command; the source checkout
was copied inside the container, and results were copied to a host-owned bind
mount:

```sh
docker run --rm --platform linux/arm64 \
  -e "HOST_UID=$(id -u)" -e "HOST_GID=$(id -g)" \
  -v "$PWD:/source:ro" \
  -v "$PWD/spike/results/linux_arm64:/out" \
  -v /tmp/tmux-pane-dash-compat-linux-arm64/run-gate.sh:/run-gate.sh:ro \
  tmux-pane-dash-compat:linux-arm64-repro bash /run-gate.sh
```

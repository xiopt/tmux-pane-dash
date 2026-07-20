# tmux compatibility build provenance — macOS arm64

- OS/arch: Darwin arm64
- Build cache (outside git): `/tmp/tmux-pane-dash-compat-macos-arm64`
- Compiler: Apple clang 17.0.0 (`clang-1700.6.3.2`)
- Linker: `ld-1230.1`
- Make: GNU Make 3.81
- pkg-config: 2.5.1 (`pkgconf` 2.5.1)
- Homebrew dependencies: `libevent` 2.1.13; `ncurses` 6.6

For each version, the official source was obtained and verified with:

```sh
curl --fail --location --retry 3 --output "$tarball" \
  "https://github.com/tmux/tmux/releases/download/$ver/tmux-$ver.tar.gz"
shasum -a 256 "$tarball"
```

| tmux | Official tarball | Observed SHA-256 | Configure flags | Installed binary |
|---|---|---|---|---|
| 3.2 | `https://github.com/tmux/tmux/releases/download/3.2/tmux-3.2.tar.gz` | `664d345338c11cbe429d7ff939b92a5191e231a7c1ef42f381cebacb1e08a399` | `--prefix=/tmp/tmux-pane-dash-compat-macos-arm64/build/tmux-3.2/install` | `/tmp/tmux-pane-dash-compat-macos-arm64/build/tmux-3.2/install/bin/tmux` (`tmux 3.2`) |
| 3.4 | `https://github.com/tmux/tmux/releases/download/3.4/tmux-3.4.tar.gz` | `551ab8dea0bf505c0ad6b7bb35ef567cdde0ccb84357df142c254f35a23e19aa` | `--disable-utf8proc --prefix=/tmp/tmux-pane-dash-compat-macos-arm64/build/tmux-3.4/install` | `/tmp/tmux-pane-dash-compat-macos-arm64/build/tmux-3.4/install/bin/tmux` (`tmux 3.4`) |
| 3.6 | `https://github.com/tmux/tmux/releases/download/3.6/tmux-3.6.tar.gz` | `136db80cfbfba617a103401f52874e7c64927986b65b1b700350b6058ad69607` | `--disable-utf8proc --prefix=/tmp/tmux-pane-dash-compat-macos-arm64/build/tmux-3.6/install` | `/tmp/tmux-pane-dash-compat-macos-arm64/build/tmux-3.6/install/bin/tmux` (`tmux 3.6`) |

Each configure invocation was executed from its corresponding
`/tmp/tmux-pane-dash-compat-macos-arm64/build/tmux-$ver` directory with:

```sh
PKG_CONFIG_PATH="$(brew --prefix libevent)/lib/pkgconfig:$(brew --prefix ncurses)/lib/pkgconfig" \
CPPFLAGS="-I$(brew --prefix libevent)/include -I$(brew --prefix ncurses)/include" \
LDFLAGS="-L$(brew --prefix libevent)/lib -L$(brew --prefix ncurses)/lib" \
"$source_dir/configure" [flags from the table]
make -j"$(sysctl -n hw.ncpu)"
make install
```

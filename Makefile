CARGO ?= cargo
INSTALL ?= install
PREFIX ?= $(HOME)/.local
BINDIR ?= $(PREFIX)/bin
DESTDIR ?=

.PHONY: build install uninstall clean help

build:
	@set -eu; \
	cargo=$${CARGO-cargo}; install=$${INSTALL-install}; \
	"$$cargo" build --locked --release --manifest-path pane-dash/Cargo.toml; \
	mkdir -p "bin"; \
	temporary="bin/.pane-dash.tmp.$$$$"; \
	cleanup() { rm -f "$$temporary"; }; \
	trap cleanup 0; trap 'exit 129' HUP; trap 'exit 130' INT; trap 'exit 143' TERM; \
	"$$install" -m 0755 "pane-dash/target/release/pane-dash" "$$temporary"; \
	mv -f "$$temporary" "bin/pane-dash"; \
	trap - 0 HUP INT TERM

install: build
	@set -eu; \
	install=$${INSTALL-install}; prefix=$${PREFIX-$$HOME/.local}; bindir=$${BINDIR-$$prefix/bin}; destdir=$${DESTDIR-}; \
	directory="$$destdir$$bindir"; \
	mkdir -p "$$directory"; \
	temporary="$$directory/.pane-dash.tmp.$$$$"; \
	cleanup() { rm -f "$$temporary"; }; \
	trap cleanup 0; trap 'exit 129' HUP; trap 'exit 130' INT; trap 'exit 143' TERM; \
	"$$install" -m 0755 "bin/pane-dash" "$$temporary"; \
	mv -f "$$temporary" "$$directory/pane-dash"; \
	trap - 0 HUP INT TERM

uninstall:
	@prefix=$${PREFIX-$$HOME/.local}; bindir=$${BINDIR-$$prefix/bin}; destdir=$${DESTDIR-}; \
	rm -f "$$destdir$$bindir/pane-dash"

clean:
	@cargo=$${CARGO-cargo}; "$$cargo" clean --manifest-path pane-dash/Cargo.toml
	rm -f "bin/pane-dash"
	rmdir "bin" 2>/dev/null || :

help:
	@printf '%s\n' \
		'Targets:' \
		'  build      Build pane-dash locally.' \
		'  install    Build and install pane-dash.' \
		'  uninstall  Remove the installed pane-dash binary.' \
		'  clean      Remove local build outputs.' \
		'' \
		'Variables:' \
		'  CARGO      Cargo command (default: cargo).' \
		'  INSTALL    Install executable (default: install; no embedded arguments).' \
		'  PREFIX     Installation prefix (default: $$(HOME)/.local).' \
		'  BINDIR     Binary directory (default: $$(PREFIX)/bin).' \
		'  DESTDIR    Staging prefix (default: empty).' \
		'' \
		'Install destination: $$(DESTDIR)$$(BINDIR)/pane-dash' \
		'Examples:' \
		'  make install' \
		'  make install PREFIX=/usr/local' \
		'  make install DESTDIR=/tmp/package PREFIX=/usr/local'

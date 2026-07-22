CARGO ?= cargo
INSTALL ?= install
PREFIX ?= $(HOME)/.local
BINDIR ?= $(PREFIX)/bin
DESTDIR ?=

export CARGO INSTALL PREFIX BINDIR DESTDIR

.PHONY: build install uninstall clean help

build:
	@set -eu; \
	"$$CARGO" build --locked --release --manifest-path pane-dash/Cargo.toml; \
	mkdir -p "bin"; \
	temporary="bin/.pane-dash.$$$$"; \
	trap 'rm -f "$$temporary"' 0 HUP INT TERM; \
	"$$INSTALL" -m 0755 "pane-dash/target/release/pane-dash" "$$temporary"; \
	mv -f "$$temporary" "bin/pane-dash"; \
	trap - 0 HUP INT TERM

install: build
	@set -eu; \
	directory="$$DESTDIR$$BINDIR"; \
	mkdir -p "$$directory"; \
	temporary="$$directory/.pane-dash.$$$$"; \
	trap 'rm -f "$$temporary"' 0 HUP INT TERM; \
	"$$INSTALL" -m 0755 "bin/pane-dash" "$$temporary"; \
	mv -f "$$temporary" "$$directory/pane-dash"; \
	trap - 0 HUP INT TERM

uninstall:
	rm -f "$$DESTDIR$$BINDIR/pane-dash"

clean:
	"$$CARGO" clean --manifest-path pane-dash/Cargo.toml
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
		'  INSTALL    Install command (default: install).' \
		'  PREFIX     Installation prefix (default: $$(HOME)/.local).' \
		'  BINDIR     Binary directory (default: $$(PREFIX)/bin).' \
		'  DESTDIR    Staging prefix (default: empty).' \
		'' \
		'Install destination: $$(DESTDIR)$$(BINDIR)/pane-dash' \
		'Examples:' \
		'  make install' \
		'  make install PREFIX=/usr/local' \
		'  make install DESTDIR=/tmp/package PREFIX=/usr/local'

.PHONY: build clean

build:
	cargo build --release --manifest-path pane-dash/Cargo.toml
	mkdir -p bin
	cp pane-dash/target/release/pane-dash bin/pane-dash

clean:
	cargo clean --manifest-path pane-dash/Cargo.toml
	rm -f bin/pane-dash

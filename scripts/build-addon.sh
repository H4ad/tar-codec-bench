#!/usr/bin/env bash
# Builds the napi addon and drops it next to the benchmark scripts.
set -euo pipefail
cd "$(dirname "$0")/.."

cargo build --release --manifest-path rust/Cargo.toml

case "$(uname -s)" in
  Darwin) built=rust/target/release/libtarcodec_node.dylib ;;
  MINGW*|MSYS*|CYGWIN*) built=rust/target/release/tarcodec_node.dll ;;
  *) built=rust/target/release/libtarcodec_node.so ;;
esac

cp "$built" tarcodec.node
echo "wrote tarcodec.node from $built"

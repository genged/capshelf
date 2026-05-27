#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

version="${VERSION:-$(bun -e 'const pkg = await Bun.file("package.json").json(); process.stdout.write(pkg.version);')}"

if [[ ! "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  printf 'invalid package version: %s\n' "$version" >&2
  exit 1
fi

out_dir="$ROOT/dist/homebrew"
build_dir="$ROOT/dist/homebrew-build"
rm -rf "$out_dir" "$build_dir"
mkdir -p "$out_dir" "$build_dir"

targets=(
  "darwin-arm64:bun-darwin-arm64"
  "darwin-x64:bun-darwin-x64"
  "linux-arm64:bun-linux-arm64"
  "linux-x64:bun-linux-x64"
)

for target in "${targets[@]}"; do
  platform="${target%%:*}"
  bun_target="${target##*:}"
  binary="$build_dir/capshelf-$platform"
  package_dir="$build_dir/capshelf-$version-$platform"
  tarball="$out_dir/capshelf-$version-$platform.tar.gz"

  bun build --compile --minify --target="$bun_target" ./src/cli.ts --outfile="$binary"
  mkdir -p "$package_dir"
  cp "$binary" "$package_dir/capshelf"
  chmod +x "$package_dir/capshelf"
  tar -C "$package_dir" -czf "$tarball" capshelf
done

(
  cd "$out_dir"
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "capshelf-$version-"*.tar.gz > "capshelf-$version.sha256"
  else
    sha256sum "capshelf-$version-"*.tar.gz > "capshelf-$version.sha256"
  fi
)

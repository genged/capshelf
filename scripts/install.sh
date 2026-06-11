#!/bin/sh
# Install the latest capshelf release binary from GitHub releases.
#
#   curl -fsSL https://raw.githubusercontent.com/genged/capshelf/main/scripts/install.sh | sh
#
# Homebrew (brew install genged/tap/capshelf) remains the primary install
# path; this script is for hosts without Homebrew. Release artifacts are
# capshelf-<version>-<os>-<arch>.tar.gz plus a capshelf-<version>.sha256
# checksum manifest, both published by .github/workflows/release.yml.
#
# Environment overrides:
#   CAPSHELF_VERSION  release tag to install (for example v0.3.0); defaults to latest
#   CAPSHELF_BIN_DIR  install directory; defaults to ~/.local/bin
set -eu

REPO="genged/capshelf"
BIN_DIR="${CAPSHELF_BIN_DIR:-$HOME/.local/bin}"

fail() {
  printf '✗ %s\n' "$1" >&2
  exit 1
}

command -v curl >/dev/null 2>&1 || fail "curl is required"
command -v tar >/dev/null 2>&1 || fail "tar is required"

os="$(uname -s)"
case "$os" in
  Darwin) platform_os="darwin" ;;
  Linux) platform_os="linux" ;;
  *) fail "unsupported OS: $os (use: brew install genged/tap/capshelf, or build from source)" ;;
esac

arch="$(uname -m)"
case "$arch" in
  arm64 | aarch64) platform_arch="arm64" ;;
  x86_64 | amd64) platform_arch="x64" ;;
  *) fail "unsupported architecture: $arch" ;;
esac
platform="$platform_os-$platform_arch"

tag="${CAPSHELF_VERSION:-}"
if [ -z "$tag" ]; then
  tag="$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" |
    sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' |
    head -n 1)"
fi
[ -n "$tag" ] || fail "could not determine the latest release tag"
# Accept CAPSHELF_VERSION with or without the leading v.
tag="v${tag#v}"
version="${tag#v}"

tarball="capshelf-$version-$platform.tar.gz"
manifest="capshelf-$version.sha256"
base_url="https://github.com/$REPO/releases/download/$tag"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT INT TERM

printf 'downloading capshelf %s (%s)...\n' "$version" "$platform"
curl -fsSL -o "$tmp/$tarball" "$base_url/$tarball" ||
  fail "download failed: $base_url/$tarball"
curl -fsSL -o "$tmp/$manifest" "$base_url/$manifest" ||
  fail "download failed: $base_url/$manifest"

expected="$(awk -v file="$tarball" '$2 == file { print $1 }' "$tmp/$manifest")"
[ -n "$expected" ] || fail "no checksum for $tarball in $manifest"

if command -v sha256sum >/dev/null 2>&1; then
  actual="$(sha256sum "$tmp/$tarball" | awk '{ print $1 }')"
elif command -v shasum >/dev/null 2>&1; then
  actual="$(shasum -a 256 "$tmp/$tarball" | awk '{ print $1 }')"
else
  fail "sha256sum or shasum is required to verify the download"
fi
[ "$actual" = "$expected" ] ||
  fail "checksum mismatch for $tarball (expected $expected, got $actual)"

tar -xzf "$tmp/$tarball" -C "$tmp" capshelf
mkdir -p "$BIN_DIR"
cp "$tmp/capshelf" "$BIN_DIR/capshelf"
chmod +x "$BIN_DIR/capshelf"

printf '✓ installed capshelf %s -> %s/capshelf\n' "$version" "$BIN_DIR"
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) printf '  add %s to your PATH\n' "$BIN_DIR" ;;
esac

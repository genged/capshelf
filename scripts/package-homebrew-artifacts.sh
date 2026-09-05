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

# The one list of release platforms. The release workflow builds its
# validation matrix from the same file, so an archive cannot be produced
# without a native runner to prove it works.
platforms_file="$ROOT/scripts/release-platforms.json"

declared_count="$(bun -e '
  const platforms = await Bun.file(process.argv[1]).json();
  process.stdout.write(String(platforms.length));
' "$platforms_file")"

# `read` returns non-zero on a final line with no newline, so the `|| [ -n ... ]`
# keeps the last platform. Without it the loop drops it and the release ships a
# short manifest while the validation matrix still expects the archive.
targets=()
while IFS= read -r target || [ -n "$target" ]; do
  [ -n "$target" ] && targets+=("$target")
done < <(bun -e '
  const file = process.argv[1];
  const platforms = await Bun.file(file).json();
  process.stdout.write(
    platforms.map((p) => `${p.platform}:${p.bunTarget}`).join("\n"),
  );
' "$platforms_file")

if [ "${#targets[@]}" -eq 0 ]; then
  printf 'no release platforms declared in %s\n' "$platforms_file" >&2
  exit 1
fi

if [ "${#targets[@]}" -ne "$declared_count" ]; then
  printf 'read %s of the %s platforms declared in %s\n' \
    "${#targets[@]}" "$declared_count" "$platforms_file" >&2
  exit 1
fi

# The web UI is inlined into every binary, so it is built once, before
# the per-platform compiles.
bun run build:ui

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

# The release workflow greps this manifest for one line per platform in its
# matrix. A short manifest only surfaces there, as a validation job that cannot
# find its candidate, so prove the count here instead.
manifest_count="$(grep -c . "$out_dir/capshelf-$version.sha256")"
if [ "$manifest_count" -ne "$declared_count" ]; then
  printf 'checksum manifest lists %s of the %s declared platforms\n' \
    "$manifest_count" "$declared_count" >&2
  exit 1
fi

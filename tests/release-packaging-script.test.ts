import { describe, expect, test } from "bun:test";
import {
  chmod,
  copyFile,
  mkdir,
  readFile,
  readdir,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { tempDir } from "./cli-fixtures";

const SCRIPTS = join(import.meta.dir, "..", "scripts");
const SCRIPT = "package-homebrew-artifacts.sh";

/**
 * A stand-in for `bun` that stubs only `bun build --compile` — the slow part —
 * and the web UI bundle it inlines, and delegates every other call to the
 * real binary. The script reads its platform list through `bun -e`, so
 * stubbing that too would leave the part that decides which platforms ship
 * untested.
 */
const BUN_STUB = `#!/usr/bin/env bash
set -euo pipefail
if [ "\${1:-}" = "run" ] && [ "\${2:-}" = "build:ui" ]; then
  exit 0
fi
if [ "\${1:-}" = "build" ]; then
  outfile=""
  for arg in "$@"; do
    case "$arg" in --outfile=*) outfile="\${arg#--outfile=}" ;; esac
  done
  if [ -z "$outfile" ]; then
    printf 'bun stub: no --outfile in: %s\\n' "$*" >&2
    exit 1
  fi
  printf 'stub binary\\n' > "$outfile"
  printf '%s\\n' "$*" >> "$BUILD_ARGS_LOG"
  exit 0
fi
exec "$REAL_BUN" "$@"
`;

interface Result {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * The script derives its root from its own location, so a copy in a temp
 * `scripts/` directory keeps the run away from the repository's `dist/`.
 */
async function run(
  platforms: PlatformRow[],
  version = "9.9.9",
): Promise<Result & { root: string }> {
  const root = await tempDir("capshelf-packaging-");
  const bin = join(root, "bin");
  await mkdir(join(root, "scripts"), { recursive: true });
  await mkdir(bin, { recursive: true });

  await copyFile(join(SCRIPTS, SCRIPT), join(root, "scripts", SCRIPT));
  await writeFile(
    join(root, "scripts", "release-platforms.json"),
    JSON.stringify(platforms),
  );
  await writeFile(join(bin, "bun"), BUN_STUB);
  await chmod(join(bin, "bun"), 0o755);

  const result = Bun.spawnSync({
    cmd: ["bash", join(root, "scripts", SCRIPT)],
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      REAL_BUN: Bun.which("bun") ?? "bun",
      VERSION: version,
      BUILD_ARGS_LOG: join(root, "build-args.log"),
    },
    stdout: "pipe",
    stderr: "pipe",
  });

  return {
    root,
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

interface PlatformRow {
  platform: string;
  bunTarget: string;
  runner: string;
}

/** The flags of one `bun build` call, without the per-call target and output. */
function sharedBuildFlags(argv: string): string[] {
  return argv
    .split(/\s+/)
    .filter(
      (arg) =>
        arg.startsWith("--") &&
        !arg.startsWith("--target=") &&
        !arg.startsWith("--outfile="),
    )
    .toSorted();
}

function platform(name: string): PlatformRow {
  return { platform: name, bunTarget: `bun-${name}`, runner: `runner-${name}` };
}

describe("package-homebrew-artifacts.sh", () => {
  test("packages every declared platform, including the last one", async () => {
    // The release workflow derives its validation matrix from the whole file,
    // so a platform dropped here becomes a validation job with no candidate.
    const names = ["linux-x64", "linux-arm64", "darwin-arm64", "darwin-x64"];
    const { root, exitCode, stderr } = await run(names.map(platform));

    expect(stderr).toBe("");
    expect(exitCode).toBe(0);

    const produced = await readdir(join(root, "dist", "homebrew"));
    expect(produced.toSorted()).toEqual(
      [
        ...names.map((name) => `capshelf-9.9.9-${name}.tar.gz`),
        "capshelf-9.9.9.sha256",
      ].toSorted(),
    );

    const manifest = await readFile(
      join(root, "dist", "homebrew", "capshelf-9.9.9.sha256"),
      "utf8",
    );
    for (const name of names) {
      expect(manifest).toContain(`  capshelf-9.9.9-${name}.tar.gz`);
    }
  });

  test("compiles each release binary with the flags of the build script", async () => {
    // Release binaries and `bun run build` must start the same way. Bytecode
    // in particular changes only startup time, so no other test notices drift.
    const { root, exitCode } = await run([platform("linux-x64")]);
    expect(exitCode).toBe(0);

    const pkg = z
      .object({ scripts: z.object({ build: z.string() }) })
      .parse(
        JSON.parse(await readFile(join(SCRIPTS, "..", "package.json"), "utf8")),
      );
    const buildScript = pkg.scripts.build.split("&&").at(-1) ?? "";
    expect(buildScript).toContain("bun build --compile");
    const expected = sharedBuildFlags(buildScript);
    expect(expected).toContain("--bytecode");

    const calls = (await readFile(join(root, "build-args.log"), "utf8"))
      .split("\n")
      .filter((line) => line.length > 0);
    expect(calls.length).toBe(1);
    expect(sharedBuildFlags(calls[0]!)).toEqual(expected);
  });

  test("refuses an empty platform list", async () => {
    const { exitCode, stderr } = await run([]);

    expect(exitCode).toBe(1);
    expect(stderr).toContain("no release platforms declared");
  });

  test("refuses a version that is not three numbers", async () => {
    const { exitCode, stderr } = await run([platform("linux-x64")], "0.10");

    expect(exitCode).toBe(1);
    expect(stderr).toContain("invalid package version");
  });
});

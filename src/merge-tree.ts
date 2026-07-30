import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, normalize, relative, sep } from "node:path";
import { tmpdir } from "node:os";
import { gitBuffer, gitText, gitTry } from "./git";

export type GitFileMode = "100644" | "100755";

export interface NamedFile {
  path: string;
  content: Buffer;
  mode: GitFileMode;
}

export type MergeTreeResult =
  | { ok: true; files: NamedFile[] }
  | { ok: false; conflicts: string[] };

export interface MergeTreeOptions {
  temporaryParent?: string;
}

const gitConfigArgs = [
  "-c",
  "core.autocrlf=false",
  "-c",
  "core.filemode=true",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "commit.gpgSign=false",
  "-c",
  "merge.autoStash=false",
];

export async function mergeNamedTrees(
  base: NamedFile[],
  local: NamedFile[],
  upstream: NamedFile[],
  options: MergeTreeOptions = {},
): Promise<MergeTreeResult> {
  const workspace = await mkdtemp(
    join(options.temporaryParent ?? tmpdir(), "capshelf-merge-"),
  );
  const repo = join(workspace, "repo");
  const template = join(workspace, "template");
  const config = join(workspace, "global-config");
  const xdg = join(workspace, "xdg");
  const hooks = join(workspace, "hooks");
  const env = isolatedGitEnv(config, xdg);

  try {
    await Promise.all([
      mkdir(repo),
      mkdir(template),
      mkdir(xdg),
      mkdir(hooks),
      writeFile(config, ""),
    ]);
    await gitBuffer(
      null,
      [
        ...gitConfigArgs,
        "init",
        "--quiet",
        `--template=${template}`,
        "--initial-branch=base",
        repo,
      ],
      { env },
    );
    await gitBuffer(
      repo,
      [...gitConfigArgs, "config", "core.hooksPath", hooks],
      { env },
    );
    await writeNamedTree(repo, base);
    await gitBuffer(repo, [...gitConfigArgs, "add", "-A"], { env });
    await gitBuffer(
      repo,
      [...gitConfigArgs, "commit", "--quiet", "--allow-empty", "-m", "base"],
      { env },
    );

    await gitBuffer(
      repo,
      [...gitConfigArgs, "checkout", "--quiet", "-b", "local"],
      { env },
    );
    await writeNamedTree(repo, local);
    await gitBuffer(repo, [...gitConfigArgs, "add", "-A"], { env });
    await gitBuffer(
      repo,
      [...gitConfigArgs, "commit", "--quiet", "--allow-empty", "-m", "local"],
      { env },
    );

    await gitBuffer(repo, [...gitConfigArgs, "checkout", "--quiet", "base"], {
      env,
    });
    await gitBuffer(
      repo,
      [...gitConfigArgs, "checkout", "--quiet", "-b", "upstream"],
      { env },
    );
    await writeNamedTree(repo, upstream);
    await gitBuffer(repo, [...gitConfigArgs, "add", "-A"], { env });
    await gitBuffer(
      repo,
      [
        ...gitConfigArgs,
        "commit",
        "--quiet",
        "--allow-empty",
        "-m",
        "upstream",
      ],
      { env },
    );
    await gitBuffer(repo, [...gitConfigArgs, "checkout", "--quiet", "local"], {
      env,
    });

    const merged = await gitTry(
      repo,
      [
        ...gitConfigArgs,
        "merge",
        "--no-commit",
        "--no-ff",
        "--no-edit",
        "upstream",
      ],
      { env },
    );
    if (merged.exitCode === 1) {
      const conflicts = (
        await gitText(
          repo,
          [...gitConfigArgs, "diff", "--name-only", "--diff-filter=U", "-z"],
          { env },
        )
      )
        .split("\0")
        .filter((path) => path.length > 0)
        .sort();
      if (conflicts.length > 0) return { ok: false, conflicts };
    }
    if (merged.exitCode !== 0) {
      throw new Error(
        merged.stderr || `isolated git merge exited ${merged.exitCode}`,
      );
    }
    return { ok: true, files: await readNamedTree(repo, env) };
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

export function namedFilesEqual(a: NamedFile[], b: NamedFile[]): boolean {
  if (a.length !== b.length) return false;
  const left = [...a].sort((x, y) => x.path.localeCompare(y.path));
  const right = [...b].sort((x, y) => x.path.localeCompare(y.path));
  return left.every(
    (file, index) =>
      file.path === right[index]?.path &&
      file.mode === right[index]?.mode &&
      file.content.equals(right[index]!.content),
  );
}

async function writeNamedTree(repo: string, files: NamedFile[]): Promise<void> {
  validateNamedFiles(files);
  for (const entry of await readdir(repo)) {
    if (entry !== ".git") {
      await rm(join(repo, entry), { recursive: true, force: true });
    }
  }
  for (const file of files) {
    const path = join(repo, ...file.path.split("/"));
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, file.content);
    await chmod(path, file.mode === "100755" ? 0o755 : 0o644);
  }
}

async function readNamedTree(
  repo: string,
  env: Record<string, string>,
): Promise<NamedFile[]> {
  const output = await gitText(
    repo,
    [...gitConfigArgs, "ls-files", "-s", "-z"],
    { env },
  );
  const files: NamedFile[] = [];
  for (const record of output.split("\0").filter(Boolean)) {
    const match = /^(\d{6}) [0-9a-f]+ 0\t([\s\S]+)$/.exec(record);
    if (!match) {
      throw new Error(`unexpected isolated git index entry: ${record}`);
    }
    const path = match[2]!;
    const statMode = match[1] === "100755" ? "100755" : "100644";
    files.push({
      path,
      content: await readFile(join(repo, ...path.split("/"))),
      mode: statMode,
    });
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

function validateNamedFiles(files: NamedFile[]): void {
  const seen = new Set<string>();
  for (const file of files) {
    const normalized = normalize(file.path);
    if (
      file.path.length === 0 ||
      isAbsolute(file.path) ||
      normalized === ".." ||
      normalized.startsWith(`..${sep}`) ||
      relative(".", normalized).startsWith(`..${sep}`) ||
      file.path.includes("\\") ||
      seen.has(file.path)
    ) {
      throw new Error(`invalid item-relative path: ${file.path}`);
    }
    seen.add(file.path);
  }
}

function isolatedGitEnv(
  globalConfig: string,
  xdgConfigHome: string,
): Record<string, string> {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: globalConfig,
    GIT_ATTR_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_AUTHOR_NAME: "capshelf",
    GIT_AUTHOR_EMAIL: "capshelf@invalid",
    GIT_COMMITTER_NAME: "capshelf",
    GIT_COMMITTER_EMAIL: "capshelf@invalid",
    XDG_CONFIG_HOME: xdgConfigHome,
    LANG: "C",
    LC_ALL: "C",
  };
  for (const key of ["SYSTEMROOT", "WINDIR", "TMP", "TEMP"]) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { PreconditionError } from "./errors";
import {
  diffFileSets,
  publishDirectoryAtomically,
  readFilesBelow,
} from "./marketplace-files";
import {
  type ProjectionFile,
  validateProjectionFiles,
} from "./plugin-projection";
import { assertRealPathOutsideRoot } from "./path-safety";

export const COWORK_MAX_FILES = 5000;
export const COWORK_MAX_BYTES = 200 * 1024 * 1024;

export interface PackageStats {
  contentSha256: string;
  archiveSha256: string | null;
  files: number;
  uncompressedBytes: number;
}

export function packageStats(files: ProjectionFile[]): PackageStats {
  validateProjectionFiles(files);
  const hash = createHash("sha256");
  let bytes = 0;
  for (const file of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
    hash.update(`${file.path}\0${file.executable ? "x" : "-"}\0`);
    hash.update(file.bytes);
    hash.update("\0");
    bytes += file.bytes.length;
  }
  return {
    contentSha256: hash.digest("hex"),
    archiveSha256: null,
    files: files.length,
    uncompressedBytes: bytes,
  };
}

export function encodeDeterministicZip(files: ProjectionFile[]): Buffer {
  validateProjectionFiles(files);
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const file of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
    const name = Buffer.from(file.path);
    const crc = crc32(file.bytes);
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0x800, 6);
    localHeader.writeUInt16LE(0, 8);
    localHeader.writeUInt16LE(0, 10);
    localHeader.writeUInt16LE(0x21, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(file.bytes.length, 18);
    localHeader.writeUInt32LE(file.bytes.length, 22);
    localHeader.writeUInt16LE(name.length, 26);
    localHeader.writeUInt16LE(0, 28);
    local.push(localHeader, name, file.bytes);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(0x0314, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0x800, 8);
    centralHeader.writeUInt16LE(0, 10);
    centralHeader.writeUInt16LE(0, 12);
    centralHeader.writeUInt16LE(0x21, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(file.bytes.length, 20);
    centralHeader.writeUInt32LE(file.bytes.length, 24);
    centralHeader.writeUInt16LE(name.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(
      ((file.executable ? 0o100755 : 0o100644) << 16) >>> 0,
      38,
    );
    centralHeader.writeUInt32LE(offset, 42);
    central.push(centralHeader, name);
    offset += localHeader.length + name.length + file.bytes.length;
  }
  const centralBytes = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBytes.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, centralBytes, end]);
}

export function decodeStoredZip(archive: Buffer): ProjectionFile[] {
  const files: ProjectionFile[] = [];
  let offset = 0;
  while (
    offset + 4 <= archive.length &&
    archive.readUInt32LE(offset) === 0x04034b50
  ) {
    const method = archive.readUInt16LE(offset + 8);
    if (method !== 0) throw new Error("unsupported ZIP compression");
    const size = archive.readUInt32LE(offset + 18);
    const nameLength = archive.readUInt16LE(offset + 26);
    const extraLength = archive.readUInt16LE(offset + 28);
    const nameStart = offset + 30;
    const dataStart = nameStart + nameLength + extraLength;
    const path = archive.subarray(nameStart, nameStart + nameLength).toString();
    files.push({
      path,
      bytes: archive.subarray(dataStart, dataStart + size),
      executable: false,
    });
    offset = dataStart + size;
  }
  return files;
}

export async function publishClaudePackage(
  dataRepo: string,
  output: string,
  files: ProjectionFile[],
  dryRun = false,
): Promise<{
  action: "built" | "already-built" | "planned";
  stats: PackageStats;
}> {
  await assertOutputOutsideDataRepo(dataRepo, output);
  if (!output.endsWith(".plugin")) {
    throw new PreconditionError("Claude package output must end in .plugin");
  }
  const filtered = files.filter(
    (file) => file.path !== "setup" && !file.path.startsWith("setup/"),
  );
  const stats = packageStats(filtered);
  if (
    stats.files > COWORK_MAX_FILES ||
    stats.uncompressedBytes > COWORK_MAX_BYTES
  ) {
    throw new PreconditionError(
      `Claude package exceeds Cowork limits (${COWORK_MAX_FILES} files, ${COWORK_MAX_BYTES} bytes)`,
    );
  }
  const archive = encodeDeterministicZip(filtered);
  const decoded = decodeStoredZip(archive);
  const decodedDiff = diffFileSets(
    filtered.map((file) => ({ ...file, executable: false })),
    decoded,
  );
  if (
    decodedDiff.created.length ||
    decodedDiff.updated.length ||
    decodedDiff.deleted.length
  ) {
    throw new Error("constructed .plugin archive failed verification");
  }
  stats.archiveSha256 = createHash("sha256").update(archive).digest("hex");
  const existing = await lstatOrNull(output);
  if (existing) {
    if (!existing.isFile())
      throw new PreconditionError(`${output} is not a file`);
    if ((await readFile(output)).equals(archive)) {
      return { action: "already-built", stats };
    }
    throw new PreconditionError(
      `${output} already exists with different content`,
    );
  }
  if (dryRun) return { action: "planned", stats };
  await mkdir(dirname(output), { recursive: true });
  const temporaryRoot = await mkdtemp(
    join(dirname(output), `.${basename(output)}.tmp-`),
  );
  const temporary = join(temporaryRoot, basename(output));
  await writeFile(temporary, archive);
  try {
    await rename(temporary, output);
    await rm(temporaryRoot, { recursive: true, force: true });
  } catch (error) {
    await rm(temporaryRoot, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
  return { action: "built", stats };
}

export async function publishCodexPackage(
  dataRepo: string,
  output: string,
  files: ProjectionFile[],
  dryRun = false,
): Promise<{
  action: "built" | "already-built" | "planned";
  stats: PackageStats;
}> {
  await assertOutputOutsideDataRepo(dataRepo, output);
  if (output.endsWith(".plugin")) {
    throw new PreconditionError("Codex package output must be a directory");
  }
  const stats = packageStats(files);
  const existing = await lstatOrNull(output);
  if (existing) {
    if (!existing.isDirectory()) {
      throw new PreconditionError(`${output} is not a directory`);
    }
    const current = await readFilesBelow(output, ["."]);
    const normalized = current.map((file) => ({
      ...file,
      path: file.path === "." ? file.path : file.path.replace(/^\.\//, ""),
    }));
    const diff = diffFileSets(normalized, files);
    if (!diff.created.length && !diff.updated.length && !diff.deleted.length) {
      return { action: "already-built", stats };
    }
    throw new PreconditionError(
      `${output} already exists with different content`,
    );
  }
  if (dryRun) return { action: "planned", stats };
  await publishDirectoryAtomically(output, files);
  return { action: "built", stats };
}

async function assertOutputOutsideDataRepo(
  dataRepo: string,
  output: string,
): Promise<void> {
  await assertRealPathOutsideRoot(
    dataRepo,
    output,
    "package output must be outside the data repo",
  );
}

async function lstatOrNull(
  path: string,
): Promise<Awaited<ReturnType<typeof lstat>> | null> {
  try {
    return await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

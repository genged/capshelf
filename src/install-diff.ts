import type { GitFileMode } from "./merge-tree";

/**
 * Cause (person vs checkout) is not decidable from bytes, e.g. deliberate CRLF
 * is identical to a checkout's, so classification only labels the consent
 * prompt and never suppresses it.
 */

export type InstallDifferenceKind =
  | "missing"
  | "unsupported-type"
  | "unreadable"
  | "untouched"
  | "mode"
  | "line-endings"
  | "encoding"
  | "ident"
  | "filter-artifact"
  | "content-edit"
  | "name-fold"
  | "visible-extra"
  | "ignored-extra";

export interface InstallDifference {
  path: string;
  kind: InstallDifferenceKind;
  modeChanged?: boolean;
}

/**
 * Best-effort explanations, not a taxonomy: transformations can compose and
 * coincide with a mode change, so results carry a primary kind plus secondary
 * facts.
 */
export function classifyInstalledFile(input: {
  path: string;
  installed: Buffer;
  pinned: Buffer;
  installedMode: GitFileMode;
  pinnedMode: GitFileMode;
}): InstallDifference {
  const modeChanged = input.installedMode !== input.pinnedMode;
  const secondary = modeChanged ? { modeChanged: true as const } : {};
  if (input.installed.equals(input.pinned)) {
    return {
      path: input.path,
      kind: modeChanged ? "mode" : "untouched",
      ...secondary,
    };
  }
  if (isLfsPointer(input.installed) !== isLfsPointer(input.pinned)) {
    return { path: input.path, kind: "filter-artifact", ...secondary };
  }
  if (
    stripCarriageReturns(input.installed).equals(
      stripCarriageReturns(input.pinned),
    )
  ) {
    return { path: input.path, kind: "line-endings", ...secondary };
  }
  const transcoded = transcodeUtf16(input.installed);
  if (transcoded?.equals(input.pinned)) {
    return { path: input.path, kind: "encoding", ...secondary };
  }
  if (collapseIdent(input.installed).equals(collapseIdent(input.pinned))) {
    return { path: input.path, kind: "ident", ...secondary };
  }
  return { path: input.path, kind: "content-edit", ...secondary };
}

/**
 * Where a checkout is a plausible cause, say so as a possibility, never a
 * finding.
 */
export function installDifferenceLabel(
  difference: InstallDifference,
): string | null {
  switch (difference.kind) {
    case "mode":
      return "executable bit differs";
    case "line-endings":
      return "line endings differ — a checkout may have rewritten this file";
    case "encoding":
      return "text encoding differs — a checkout may have rewritten this file";
    case "ident":
      return "a git $Id$ keyword differs — git expands this on checkout";
    case "filter-artifact":
      return "one side is a git-lfs pointer — the content is not portable";
    case "content-edit":
      return difference.modeChanged === true
        ? "content edit, and the executable bit differs"
        : "content edit";
    case "name-fold":
      return "the destination folded this name onto another pinned path";
    case "visible-extra":
      return "not part of the item — reconciliation removes it";
    case "unsupported-type":
      return "not a regular file — capshelf will not overwrite it";
    case "unreadable":
      return "could not be read — capshelf will not overwrite it";
    default:
      return null;
  }
}

/**
 * Only kinds that replace or delete bytes need consent; writing an absent file
 * or leaving a preserved one destroys nothing.
 */
export function isDestructiveDifference(kind: InstallDifferenceKind): boolean {
  switch (kind) {
    case "missing":
    case "untouched":
    case "ignored-extra":
      return false;
    default:
      return true;
  }
}

function stripCarriageReturns(bytes: Buffer): Buffer {
  const out = Buffer.allocUnsafe(bytes.length);
  let length = 0;
  for (let index = 0; index < bytes.length; index += 1) {
    if (bytes[index] === 0x0d && bytes[index + 1] === 0x0a) continue;
    out[length] = bytes[index]!;
    length += 1;
  }
  return out.subarray(0, length);
}

function transcodeUtf16(bytes: Buffer): Buffer | null {
  if (bytes.length < 2) return null;
  const littleEndian = bytes[0] === 0xff && bytes[1] === 0xfe;
  const bigEndian = bytes[0] === 0xfe && bytes[1] === 0xff;
  if (!littleEndian && !bigEndian) return null;
  const body = bytes.subarray(2);
  if (body.length % 2 !== 0) return null;
  const swapped = bigEndian ? Buffer.from(body).swap16() : body;
  return Buffer.from(swapped.toString("utf16le"), "utf-8");
}

function collapseIdent(bytes: Buffer): Buffer {
  const text = bytes.toString("latin1");
  if (!text.includes("$Id")) return bytes;
  return Buffer.from(text.replace(/\$Id:[^$]*\$/g, "$Id$"), "latin1");
}

const LFS_POINTER_PREFIX = "version https://git-lfs.github.com/spec/";

function isLfsPointer(bytes: Buffer): boolean {
  if (bytes.length > 1024) return false;
  return bytes.toString("utf-8").startsWith(LFS_POINTER_PREFIX);
}

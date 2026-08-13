import type { GitFileMode } from "./merge-tree";

/*
 * PIN-6: comparing an install to its pin answers three questions, and
 * conflating them is what made earlier drafts of this design look complete:
 *
 *   Q1  does the installed content differ from the pin?   bytes  — decidable
 *   Q2  what kind of difference is it?                    bytes  — decidable
 *   Q3  did a person or a checkout cause it?              intent — NOT decidable
 *
 * Q1 is answered by blob ids alone (`installedPinDigest`), with zero object
 * reads. Q2 is answered here, and only for paths already known to differ.
 *
 * Q3 is left unanswered on purpose. A user who deliberately converts a file to
 * CRLF for a Windows tool produces bytes indistinguishable from a checkout that
 * did it, so classifying by heuristic and repairing silently would destroy that
 * deliberate change. PIN-7 is the consequence: a classification labels the
 * consent prompt and never suppresses it.
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
  /** A secondary fact, not a second classification. */
  modeChanged?: boolean;
}

/**
 * The transformation rows are a closed set because Git's checkout
 * transformations are a closed set; each row is the inverse of one of them.
 * They are best-effort *explanations*, not an exhaustive taxonomy: two
 * transformations can compose, and a content edit can coincide with a mode
 * change. So a result carries a primary kind plus secondary facts rather than
 * forcing one label.
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
 * The one-line explanation that goes on the consent prompt. It says what the
 * bytes show and, where a checkout is a plausible cause, says so as a
 * possibility — never as a finding.
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
 * PIN-7's gate. `missing` and `ignored-extra` are not destructive: writing an
 * absent file destroys nothing, and a preserved local file is not touched.
 * Every other kind replaces or deletes bytes on disk and reaches consent,
 * whatever the classification suggests about its cause.
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
    // Only a CR immediately before an LF is a line ending; a bare CR is data.
    if (bytes[index] === 0x0d && bytes[index + 1] === 0x0a) continue;
    out[length] = bytes[index]!;
    length += 1;
  }
  return out.subarray(0, length);
}

/** UTF-16 (either endianness, BOM-marked) decoded to UTF-8, or null. */
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

/** `$Id: <anything>$` collapses to `$Id$`, which is what Git stores. */
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

/**
 * Classification of the positional argument `capshelf add` receives when it is
 * a URL rather than a shelf item ref.
 *
 * This is the trust boundary for every later path: the repository it names is
 * cloned, the ref it names reaches a git argv, and the subpath it names becomes
 * an item root and a pathspec. Nothing here touches the network or the
 * filesystem.
 */
import { assertSafeItemRoot, isSafeGitRef, isSafeItemRoot } from "./assert";
import { isRemoteDataUrl } from "./data-bootstrap";
import { PreconditionError } from "./errors";
import { normalizeRemoteUrl } from "./git";
import { PRODUCT_NAME } from "./identity";
import { isItemKind } from "./master";

export interface RemoteSkillUrl {
  /** The clone URL, exactly as given, with any /tree/ suffix removed. */
  cloneUrl: string;
  /** The normalized identity used for the cache path and for comparison. */
  upstream: string;
  /** The ref the URL names, or null when it named none. */
  ref: string | null;
  /** The item root the URL names, or null when it named none. */
  subpath: string | null;
  /** The repository name, used as a default item name for a root skill. */
  repoName: string;
}

/**
 * The browser shapes, split off the raw string before any URL parsing.
 *
 * `new URL()` resolves `..` inside a pathname, so parsing first would turn
 * `…/tree/main/../../etc` into a different repository silently instead of a
 * refusal. The split therefore works on the literal text.
 *
 * Only `http(s)` carries these shapes: they come from an address bar. An
 * `ssh://`, `git@`, or `file://` URL names a repository and nothing else, and a
 * `tree` directory inside one of those is a real path.
 */
const HTTP_URL = /^(https?:\/\/[^/?#]+)(\/[^?#]*)?(?:[?#].*)?$/i;

interface BrowserSplit {
  cloneUrl: string;
  ref: string | null;
  subpath: string | null;
}

/** Parse a supported URL, or throw a PreconditionError naming the failure. */
export function parseRemoteSkillUrl(input: string): RemoteSkillUrl {
  const raw = input.trim();
  if (raw.length === 0) {
    throw new PreconditionError("a repository URL is required", {
      hint: `for example: ${PRODUCT_NAME} add https://github.com/owner/repo`,
    });
  }

  const split = splitBrowserUrl(raw);
  if (!isRemoteDataUrl(split.cloneUrl)) {
    const shorthand = ownerRepoShorthandHint(raw);
    throw new PreconditionError(`not a supported repository URL: ${input}`, {
      hint: (
        shorthand ?? [
          `pass a full URL: ${PRODUCT_NAME} add https://github.com/owner/repo`,
        ]
      ).join("\n  "),
    });
  }

  const upstream = normalizeRemoteUrl(split.cloneUrl, { allowFileUrls: true });
  if (upstream === null) {
    throw new PreconditionError(`not a supported repository URL: ${input}`, {
      hint: "supported forms: https://host/owner/repo, ssh://git@host/owner/repo, git@host:owner/repo, file:///path/to/repo.git",
    });
  }

  if (split.ref !== null && !isSafeGitRef(split.ref)) {
    throw new PreconditionError(
      `the URL names a ref capshelf will not pass to git: ${split.ref}`,
    );
  }
  if (split.subpath !== null && !isSafeItemRoot(split.subpath)) {
    throw new PreconditionError(
      `the URL's subpath leaves the repository: ${split.subpath}`,
      { hint: "name a directory inside the repository, without `..`" },
    );
  }

  return {
    cloneUrl: split.cloneUrl,
    upstream,
    ref: split.ref,
    subpath: split.subpath,
    repoName: repoNameOf(upstream),
  };
}

/** True when the input is shaped like a URL this command accepts. */
export function isRemoteSkillUrl(input: string): boolean {
  // The same classifier `init --data` uses, deliberately: one answer to "is
  // this a URL or a local name" across the CLI.
  return isRemoteDataUrl(input.trim());
}

/**
 * The two extra lines the shorthand refusal prints, or null when the input is
 * not `owner/repo` shorthand.
 */
export function ownerRepoShorthandHint(input: string): string[] | null {
  const raw = input.trim();
  if (raw.includes(":") || /\s/u.test(raw)) return null;
  const parts = raw.split("/");
  if (parts.length !== 2) return null;
  const [owner, repo] = parts;
  if (!owner || !repo) return null;
  // `skills/pdf` is a shelf item ref, not a repository. Only a first segment
  // that is not an item kind can be an owner.
  if (isItemKind(owner)) return null;
  return [
    "owner/repo shorthand is ambiguous with kind/name here",
    `pass the full URL: ${PRODUCT_NAME} add https://github.com/${owner}/${repo}`,
  ];
}

function splitBrowserUrl(raw: string): BrowserSplit {
  const match = HTTP_URL.exec(raw);
  if (!match) return { cloneUrl: raw, ref: null, subpath: null };
  const origin = match[1]!;
  const segments = (match[2] ?? "").split("/").filter(Boolean);
  const marker = segments.findIndex(
    (segment, index) =>
      index >= 2 && (segment === "tree" || segment === "blob"),
  );
  if (marker === -1) return { cloneUrl: raw, ref: null, subpath: null };

  const ref = segments[marker + 1];
  if (ref === undefined) {
    throw new PreconditionError(
      `a /${segments[marker]!}/ URL must name a branch, tag, or commit: ${raw}`,
    );
  }
  // GitLab separates the repository from the view with a `-` segment.
  const repoEnd = segments[marker - 1] === "-" ? marker - 1 : marker;
  const rest = segments.slice(marker + 2).map(decodeSegment);
  // A blob URL names the file; the item is the directory that holds it.
  const itemSegments = segments[marker] === "blob" ? rest.slice(0, -1) : rest;
  return {
    cloneUrl: `${origin}/${segments.slice(0, repoEnd).join("/")}`,
    ref: decodeSegment(ref),
    subpath: itemSegments.length === 0 ? "." : itemSegments.join("/"),
  };
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    // A lone `%` is not an escape. Keep the literal text so the safety check
    // below sees what the user actually wrote.
    return segment;
  }
}

/**
 * The default item name for a repository that is itself one skill. A bare
 * clone directory keeps its `.git` suffix in the normalized identity, and that
 * suffix is not part of the repository's name.
 */
function repoNameOf(upstream: string): string {
  const segments = new URL(upstream).pathname.split("/").filter(Boolean);
  const last = segments.at(-1) ?? "";
  const name = last.replace(/\.git$/, "");
  assertSafeItemRoot(name, `repository name in ${upstream}`);
  return name;
}

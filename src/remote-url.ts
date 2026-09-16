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
  /**
   * Every way the segments after `/tree/` could split into a ref and an item
   * root, longest ref first.
   *
   * A browser URL gives no delimiter between a branch name and the path inside
   * it, so `…/tree/feature/login/skills/pdf` is `feature` + `login/skills/pdf`
   * and `feature/login` + `skills/pdf` and more, all equally well-formed. No
   * parse can choose; the cache can, by asking which refs exist. `ref` and
   * `subpath` above hold the first candidate, which is what a caller that
   * cannot resolve should use.
   */
  refCandidates: BrowserRefCandidate[];
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

export interface BrowserRefCandidate {
  ref: string;
  subpath: string;
}

interface BrowserSplit {
  cloneUrl: string;
  ref: string | null;
  subpath: string | null;
  candidates: BrowserRefCandidate[];
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

  assertNoEmbeddedCredential(split.cloneUrl, input);

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

  // A candidate whose ref or item root capshelf would refuse is dropped rather
  // than refused: the first candidate is validated above and is what the
  // command falls back to, so a later split being unusable is not an error.
  const refCandidates = split.candidates.filter(
    (candidate) =>
      isSafeGitRef(candidate.ref) && isSafeItemRoot(candidate.subpath),
  );
  return {
    cloneUrl: split.cloneUrl,
    upstream,
    ref: split.ref,
    subpath: split.subpath,
    refCandidates,
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

/**
 * Refuse a URL that carries a credential.
 *
 * `upstream` is normalized and drops userinfo, but the clone URL is handed to
 * `git clone` exactly as given — and git writes it into the cache clone's
 * `.git/config` as `origin`, where it stays. It is also in the process argv
 * while the clone runs, which is readable by other users on a shared machine.
 * A token pasted on the command line would therefore be persisted on disk by
 * capshelf, which `docs/security.md` promises it never does.
 *
 * An SSH *username* is not a credential and is how `git@host` addressing works,
 * so only a password component is refused there. Any userinfo at all is refused
 * over http(s), because that is the shape a token takes.
 */
function assertNoEmbeddedCredential(cloneUrl: string, input: string): void {
  const refuse = (): never => {
    throw new PreconditionError(
      `the URL carries a credential: ${redactUserinfo(input)}`,
      {
        hint:
          "git would write it into the cache clone's .git/config and show it in the process list\n" +
          "  remove it from the URL and let your git credential helper supply it",
      },
    );
  };
  let parsed: URL;
  try {
    parsed = new URL(cloneUrl);
  } catch {
    // scp-like `git@host:path` is not a URL. It carries a username and has no
    // syntax for a password, so there is nothing to refuse.
    return;
  }
  if (parsed.protocol === "http:" || parsed.protocol === "https:") {
    if (parsed.username !== "" || parsed.password !== "") refuse();
    return;
  }
  if (parsed.password !== "") refuse();
}

/** The URL with any userinfo replaced, so a refusal never echoes the secret. */
function redactUserinfo(input: string): string {
  return input.replace(/(^[a-z0-9+.-]+:\/\/)[^/@]*@/i, "$1***@");
}

function splitBrowserUrl(raw: string): BrowserSplit {
  const match = HTTP_URL.exec(raw);
  if (!match) {
    return { cloneUrl: raw, ref: null, subpath: null, candidates: [] };
  }
  const origin = match[1]!;
  const segments = (match[2] ?? "").split("/").filter(Boolean);
  const marker = segments.findIndex(
    (segment, index) =>
      index >= 2 && (segment === "tree" || segment === "blob"),
  );
  if (marker === -1) {
    return { cloneUrl: raw, ref: null, subpath: null, candidates: [] };
  }

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
  const tail = [decodeSegment(ref), ...itemSegments];
  // Longest ref first: a branch named `feature/login` beats a branch named
  // `feature` when both exist, because the URL that produced this was written
  // against the longer one. The one-segment split stays last, and it is the
  // `ref`/`subpath` pair a caller uses when it cannot ask the repository.
  const candidates: BrowserRefCandidate[] = [];
  for (let refLength = tail.length; refLength >= 1; refLength--) {
    const item = tail.slice(refLength);
    candidates.push({
      ref: tail.slice(0, refLength).join("/"),
      subpath: item.length === 0 ? "." : item.join("/"),
    });
  }
  return {
    cloneUrl: `${origin}/${segments.slice(0, repoEnd).join("/")}`,
    ref: decodeSegment(ref),
    subpath: itemSegments.length === 0 ? "." : itemSegments.join("/"),
    candidates,
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

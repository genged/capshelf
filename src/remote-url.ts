/**
 * Trust boundary: the repository the URL names is cloned, its ref reaches a git
 * argv, and its subpath becomes an item root and pathspec. The ref, the
 * subpath, and embedded credentials are checked here. Nothing here touches the
 * network or filesystem.
 */
import { assertSafeItemRoot, isSafeGitRef, isSafeItemRoot } from "./assert";
import { isRemoteDataUrl } from "./data-bootstrap";
import { PreconditionError } from "./errors";
import { normalizeRemoteUrl } from "./git";
import { PRODUCT_NAME } from "./identity";
import { isItemKind } from "./master";

export interface RemoteSkillUrl {
  cloneUrl: string;
  upstream: string;
  ref: string | null;
  subpath: string | null;
  /**
   * Browser URLs do not delimit branch names from paths, so the cache resolves
   * candidates against existing refs. `ref` and `subpath` hold the one-segment
   * candidate, the fallback.
   */
  refCandidates: BrowserRefCandidate[];
  repoName: string;
}

/**
 * Split the raw string before URL parsing: `new URL()` resolves `..` and would
 * silently turn `…/tree/main/../../etc` into a different repository. Only
 * http(s) has these shapes; a `tree` directory in ssh/file URLs is a real path.
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

  // Invalid alternative splits are dropped because the one-segment fallback
  // has already passed validation.
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

export function isRemoteSkillUrl(input: string): boolean {
  // Shares the `init --data` classifier so the CLI has one answer to "URL or
  // local name".
  return isRemoteDataUrl(input.trim());
}

export function ownerRepoShorthandHint(input: string): string[] | null {
  const raw = input.trim();
  if (raw.includes(":") || /\s/u.test(raw)) return null;
  const parts = raw.split("/");
  if (parts.length !== 2) return null;
  const [owner, repo] = parts;
  if (!owner || !repo) return null;
  // `skills/pdf` is a shelf item ref, so a first segment that is an item kind
  // cannot be an owner.
  if (isItemKind(owner)) return null;
  return [
    "owner/repo shorthand is ambiguous with kind/name here",
    `pass the full URL: ${PRODUCT_NAME} add https://github.com/${owner}/${repo}`,
  ];
}

/**
 * Refuse credentials in the URL: git writes the clone URL into the cache's
 * `.git/config` and exposes it in argv, which would persist a token on disk
 * against `docs/security.md`. SSH usernames are fine; only an SSH password or
 * any http(s) userinfo is refused.
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
  const itemSegments = segments[marker] === "blob" ? rest.slice(0, -1) : rest;
  const tail = [decodeSegment(ref), ...itemSegments];
  // Longest ref first, since a URL written against `feature/login` should beat
  // `feature`; the one-segment split stays last as the fallback pair.
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
    // A lone `%` is kept literal so the later safety check sees what the user
    // wrote.
    return segment;
  }
}

function repoNameOf(upstream: string): string {
  const segments = new URL(upstream).pathname.split("/").filter(Boolean);
  const last = segments.at(-1) ?? "";
  const name = last.replace(/\.git$/, "");
  assertSafeItemRoot(name, `repository name in ${upstream}`);
  return name;
}

// Where a skill comes from: `owner/repo[/path]@ref`, or a plain git URL.
//
// Pure, and its own file because the grammar has two traps that are only
// findable by staring at them, and a table test is the way to hold them still.
//
// **The ref splits at the *last* `@`.** `git@host:team/skills.git@v1.2.0` has
// two of them, and splitting at the first mangles every SSH address there is.
// That in turn makes the no-ref case ambiguous — `git@host:team/skills.git`'s
// only `@` is the SSH user's — so what follows the last one has to be checked
// against what a ref may look like before it is believed. A candidate holding a
// `:` is a host, not a tag.
//
// **`@ref` is mandatory**, which is not a convenience being withheld. #373
// decided vendoring over fetching on the argument that the copy in the
// operator's git *is* the lock, and #569's provenance lines are that argument
// written into the file. An address with no ref would be a supported way to
// vendor something nobody can name again.
//
// **A plain URL carrying a sub-path is ambiguous and stays that way.**
// `https://host/team/skills/skills/pdf` is a repository at `team/skills` with
// `skills/pdf` inside it, or a repository at `team/skills/skills/pdf`, and
// nothing in the string distinguishes them. So the rule is `.git`: the
// repository ends at the last segment spelled with the suffix, and without one
// the whole URL is the repository. Stated in the usage, and repeated as a
// remedy on the failure it actually causes — "no SKILL.md at the root" — which
// is where an operator meets it.
//
// Nothing here runs git or touches the filesystem. It throws `UsageError`, so
// every refusal in this file costs exit 2 and no subprocess.

import { SkillName } from "@getlibero/schema";
import { UsageError } from "./io.js";

export interface SkillAddress {
  /** What `git ls-remote` and `git fetch` are pointed at. */
  readonly remote: string;
  /** The skill's directory inside the repository; `""` is the root. */
  readonly path: string;
  /** The ref as the operator wrote it — a tag, a branch, or a 40-hex commit. */
  readonly ref: string;
  /** The address without its `@ref`, recorded as `libero-source`. */
  readonly source: string;
  /** The directory this is published as, and the name its frontmatter must carry. */
  readonly name: string;
}

/** A 40-character commit, which needs no resolving. */
export const COMMIT_SHA = /^[0-9a-f]{40}$/;

/**
 * What may follow the last `@`.
 *
 * Deliberately admits `/`, because `refs/tags/v1` and `feature/x` are both
 * refs somebody will write, and a "a ref has no slash" rule would refuse them.
 * What it excludes is what tells a ref from the tail of an SSH address: a `:`.
 */
const REF = /^[A-Za-z0-9._\/-]+$/;

/** `owner/repo`, then anything. The first two segments admit no `:` and no `/`. */
const SHORTHAND = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+(?:\/.+)?$/;

/** `host:path` or `user@host:path` — a colon before the first slash. */
const SCP_LIKE = /^(?:[^@/]+@)?[A-Za-z0-9._-]+:(?!\/)/;

export function parseSkillAddress(spec: string, skill?: string): SkillAddress {
  // Before anything else, so a hostile-looking address cannot become an argv
  // element to `git`. Every git call in ./git.ts passes an array rather than a
  // shell string, so this is belt and braces — but an address beginning with a
  // dash is a mistake in every reading, and saying so beats being clever.
  if (spec.startsWith("-")) {
    throw new UsageError(`libero: not a skill address: ${spec}`);
  }
  if (spec.trim() === "") {
    throw new UsageError("libero: skill vendor needs an address");
  }

  const { base, ref } = splitRef(spec);
  const { remote, path } = isUrl(base) ? splitUrl(base) : splitShorthand(base, spec);

  const name = skill ?? lastSegment(path) ?? repoBasename(remote);
  if (!SkillName.safeParse(name).success) {
    throw new UsageError(
      `libero: not a skill name: ${name} — lowercase words joined by single ` +
        "dashes, letters and digits only, up to 64 characters\n" +
        "libero:   This refuses rather than folding, because a name that parses is " +
        "already canonical and nothing here has a second spelling to drift from. " +
        "Give one: --skill <name>"
    );
  }

  return { remote, path, ref, source: base, name };
}

/**
 * The base and its ref, split at the last `@`.
 *
 * A candidate that cannot be a ref means there was no `@ref` at all — the `@`
 * belonged to an SSH address — so this reports the missing pin rather than
 * inventing a repository called `git`.
 */
function splitRef(spec: string): { base: string; ref: string } {
  const at = spec.lastIndexOf("@");
  const candidate = at === -1 ? "" : spec.slice(at + 1);

  if (at > 0 && REF.test(candidate) && !candidate.startsWith("/") && !candidate.endsWith("/") && !candidate.includes("..")) {
    return { base: spec.slice(0, at), ref: candidate };
  }

  throw new UsageError(
    `libero: no ref in ${spec} — a vendored skill is pinned to one commit\n` +
      `libero:   Add a tag, a branch or a 40-character sha: ${spec}@v1.2.0`
  );
}

function isUrl(base: string): boolean {
  return base.includes("://") || SCP_LIKE.test(base);
}

/**
 * A URL's repository and the path inside it, split at the last `.git`.
 *
 * Without a `.git` the whole URL is the repository, which is right far more
 * often than the alternative and is the half an operator can correct.
 */
function splitUrl(base: string): { remote: string; path: string } {
  const parts = base.split("/");
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    if ((parts[index] ?? "").endsWith(".git")) {
      return { remote: parts.slice(0, index + 1).join("/"), path: parts.slice(index + 1).join("/") };
    }
  }
  return { remote: base, path: "" };
}

/** `owner/repo[/path]`, which is GitHub unless it is spelled as a URL. */
function splitShorthand(base: string, spec: string): { remote: string; path: string } {
  if (!SHORTHAND.test(base)) {
    throw new UsageError(
      `libero: not a skill address: ${spec}\n` +
        "libero:   Either owner/repo/path@ref, or a git URL: " +
        "git@host:team/skills.git/path@ref"
    );
  }
  const [owner, repo, ...rest] = base.split("/");
  return {
    remote: `https://github.com/${owner as string}/${repo as string}.git`,
    path: rest.join("/")
  };
}

function lastSegment(path: string): string | undefined {
  if (path === "") return undefined;
  return path.split("/").at(-1);
}

function repoBasename(remote: string): string {
  return (remote.split("/").at(-1) ?? remote).replace(/\.git$/, "");
}

// The egress allowlist: which hosts a channel's traffic may reach, and the
// matcher that decides.
//
// **What this list is for.** It governs destinations the sheet does not already
// pin — the code-execution sandbox today, URL-taking tools later. It does *not*
// govern the `[[mcp_server]]` upstreams the proxy dials: those are declared in
// the sheet by an admin, in the same block that carries the tool allowlist and
// the credential name, and declaring a destination there *is* the authorization.
// Team sheets authorize; restating a destination under `[egress]` would add no
// boundary, only a way to get it wrong.
//
// Keeping the two apart is not just tidiness — merging them widens both grants.
// Listing `api.github.com` so a GitHub MCP server can be reached would also let
// sandboxed code reach the GitHub API directly, around the tool allowlist that
// is the whole reason for going through an MCP server. Listing the MCP server's
// own host so the proxy can dial it would let sandboxed code dial the sidecar.
// Neither is the grant an operator was making.
//
// This file is pure — no I/O, no clock, no network — for the reason
// packages/proxy/src/enforce.ts gives about itself: the matcher *is* the
// security value here, and a function that cannot reach anything is a function
// nothing can influence. It lives in the schema package because `EgressPattern`
// is a team-sheet field and this is the only code that knows what `*.` means in
// one; splitting the syntax from its meaning is how the two drift.

import { z } from "zod";

/** The wildcard label, permitted only as the whole leftmost label. */
const WILDCARD_PREFIX = "*.";

/**
 * Host characters, matching `DestinationHost` in ./names.ts.
 *
 * The two are compared against each other, so they take the same alphabet. A
 * pattern that could express something a destination cannot would be a pattern
 * that never matches.
 */
const HOST_CHARS = "[A-Za-z0-9.:_-]+";

/**
 * An entry in `egress.allow`: a host, or `*.` and a host.
 *
 * Validated rather than left as a free string so a malformed entry is rejected
 * at load, where the operator is looking. The matcher below still fails closed
 * on anything it does not recognise, but a silently-inert allowlist entry is a
 * grant someone believes they made — the loud version is better.
 *
 * **There is no allow-all pattern.** A bare `*` is rejected. That follows from
 * default deny: a list whose point is to enumerate destinations should not have
 * a way to say "any", and an operator who wants one is better served writing
 * the hosts down.
 */
export const EgressPattern = z
  .string()
  .min(1)
  .max(255)
  .regex(
    new RegExp(`^(\\*\\.)?${HOST_CHARS}$`),
    "must be a host, optionally prefixed with '*.' — no bare '*', and no wildcard inside a label"
  );

export type EgressPattern = z.infer<typeof EgressPattern>;

/**
 * A host in the one form both sides of a comparison are held to.
 *
 * Case is folded because DNS is case-insensitive and a list written
 * `API.GitHub.com` should match a call to `api.github.com`. A single trailing
 * dot — the explicit root — is stripped, because `example.com.` and
 * `example.com` name the same host and an allowlist that distinguished them
 * would be bypassable by typing a dot.
 *
 * Unicode is deliberately *not* normalized here, and that is the point rather
 * than an omission. Destinations arrive from `new URL().hostname`, which has
 * already punycoded any IDN, so a real destination is ASCII. Running allowlist
 * entries through the same function means a pattern typed in unicode stays
 * unicode and simply never matches — a lookalike label cannot become the ASCII
 * host it imitates. Returns `null` for anything left empty, which fails closed
 * at every call site.
 */
export function normalizeHost(host: string): string | null {
  const trimmed = host.endsWith(".") ? host.slice(0, -1) : host;
  if (trimmed.length === 0) return null;
  return trimmed.toLowerCase();
}

/** Whether a host is an IPv4 literal or a bracketed IPv6 one. */
function isIpLiteral(host: string): boolean {
  if (host.startsWith("[")) return true;
  const labels = host.split(".");
  return labels.length === 4 && labels.every(label => /^\d{1,3}$/.test(label));
}

/**
 * Whether one entry admits one host. Both already normalized.
 *
 * The wildcard matches one or more subdomain labels of its suffix and nothing
 * else. Three near-misses are what the rule is written to exclude, and each is
 * excluded by a specific clause rather than by luck:
 *
 * - `evil-internal.example.com` against `*.internal.example.com`. Excluded by
 *   requiring the character before the suffix to be the dot from the pattern,
 *   which a plain `endsWith(suffix)` would not.
 * - `internal.example.com.attacker.com`. Excluded by anchoring at the end.
 * - `internal.example.com` itself. Excluded because the wildcard stands for at
 *   least one label; a list granting a subtree does not thereby grant its root.
 *
 * An IP literal never matches a wildcard. `*.0.1` is not a plausible entry, but
 * the address space is small enough that a pattern which could reach into it by
 * accident is worth closing rather than reasoning about.
 */
function admits(pattern: string, host: string): boolean {
  if (!pattern.startsWith(WILDCARD_PREFIX)) return pattern === host;

  const suffix = pattern.slice(WILDCARD_PREFIX.length);
  // A pattern the schema would have rejected. The matcher is reachable from
  // tests and from any future caller that has not parsed its input, so it
  // decides rather than assuming: anything malformed matches nothing.
  if (suffix.length === 0 || suffix.startsWith(".") || suffix.includes("*")) return false;
  if (isIpLiteral(host)) return false;

  // The leading dot is what makes this a label boundary rather than a suffix.
  return host.endsWith(`.${suffix}`) && host.length > suffix.length + 1;
}

/**
 * Whether the allowlist admits this destination. Default deny.
 *
 * An empty or absent list matches nothing — a channel that has not said where
 * its traffic may go has not permitted any. That is the whole disposition of
 * this file: every path that cannot answer "yes" for a stated reason answers
 * "no", including a host that will not normalize and a pattern that does not
 * parse.
 */
export function isEgressAllowed(host: string, allow: readonly string[]): boolean {
  const destination = normalizeHost(host);
  if (destination === null) return false;

  return allow.some(entry => {
    const pattern = normalizeHost(entry);
    return pattern !== null && admits(pattern, destination);
  });
}

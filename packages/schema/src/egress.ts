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
//
// **Who calls this, and why it is not a call site.** #393 decided the shape and
// #219 built it, and it is worth having here because the obvious reading of
// `isEgressAllowed` — a check somewhere on the way out, like the one
// ../../proxy/src/outbound.ts explains it does not make — is wrong for the
// caller this list was built for.
//
// The caller is `apps/runner/src/hop-server.ts`, a CONNECT proxy that runs one
// container per sandbox run and imports this function rather than restating it.
// Sandboxed code opens sockets nobody declared, so there is no line to put a
// check on. Enforcement is topological instead: the sandbox runs on a network
// with no route out, whose only other member is a CONNECT hop that calls this
// function once per host. Code that ignores `HTTP_PROXY`, or dials a raw
// address, reaches nothing — not because it was checked and refused, but because
// there is nowhere for the packet to go. A sheet with no `[egress]` block at all
// gets no hop and no network.
//
// Three consequences that belong with the matcher rather than with the hop:
//
// - **The hop resolves names; the sandbox resolves nothing.** Not a tidiness
//   point — DNS is itself an exfiltration channel, and a query for
//   `<payload>.attacker.com` has already leaked whether or not the connection is
//   ever allowed. A resolver with a route out defeats the whole arrangement. It
//   also keeps the check honest in the one direction that works: the hop matches
//   the name an operator wrote and then dials the name it matched, rather than
//   being handed an address and reverse-mapping it.
// - **A raw address is checked as one.** `CONNECT 1.2.3.4:443` goes through
//   `admits` as an IP literal, which never matches a wildcard, so dialling by
//   address is denied unless an operator literally wrote that address down. That
//   is how `169.254.169.254` dies to default deny. The hop denies loopback and
//   link-local ahead of this function regardless, because a listed name that
//   *resolves* to the metadata address is a rebinding an allowlist over names
//   structurally cannot see — and it stops there rather than denying RFC1918,
//   because `*.internal.example.com` is the worked example this list ships with.
// - **The list grants HTTP and HTTPS, and nothing else.** A CONNECT hop reads a
//   host and a port and never the payload, which is why it is an allowlist check
//   and not a second redaction point. It also means `git://`, postgres, ssh and
//   bare TCP have no route at all. An operator writing `allow =
//   ["api.github.com"]` is making a narrower grant than that line looks like:
//   `git clone https://…` works and `git clone git://…` does not.
//
// A caller that expresses this list in some other syntax — an off-the-shelf
// proxy's ACL file being the tempting one — is the review failure #219 named,
// and the reason is that the near-miss behaviour below is the security
// deliverable. It is cheaper to write a CONNECT hop that imports this function
// than to prove someone else's matcher agrees with it. See
// packages/proxy/README.md under "Enforcing [egress]" for the rest.

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

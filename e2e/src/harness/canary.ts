// The planted secret, and every surface it must not reach.
//
// The suite's whole leak claim rests on one string: a credential that exists
// only in the vault file the proxy reads, is resolved only inside
// `callUpstream`, and should appear on exactly one wire — the request to the
// upstream — and on no surface the agent process can see.
//
// **The positive control is not optional.** A run where the credential was
// never resolved at all passes every negative assertion here, and passes it for
// the worst possible reason. `expectCanaryReachedUpstream` is what makes the
// negative results mean something, and every case that calls `expectNoCanary`
// should call it too.

import type { FakeMcpServer } from "@getlibero/proxy";

/**
 * Long, unique, and fixed in source so a failure is greppable.
 *
 * It must appear nowhere else in the repository. If a search for it ever
 * returns a second hit outside this file, the suite is asserting against a
 * string that something else can produce.
 */
export const CANARY = "libero-e2e-canary-a3f9c17d84be2065fb7e19c4d0a85b32";

/** The credential name the team sheet refers to. Names travel; values do not. */
export const CANARY_CREDENTIAL = "e2e_canary";

/**
 * The positive control: the canary really did leave the proxy, on this method.
 *
 * Every negative assertion in this suite passes on a run where no credential
 * was ever resolved — a sheet naming no credential, a vault that failed to
 * open, a call that never went out. This is what rules that out, and it is why
 * the file's header tells every case that calls `expectNoCanary` to call this
 * too.
 *
 * `method` is a parameter rather than a constant because the credential goes
 * out on more than one kind of request: a case attacking the *listing* path is
 * controlled by `tools/list`, and one attacking the legacy handshake by
 * `initialize`. Defaulting to `tools/call` keeps the common case a bare call.
 *
 * A type-only import, so this module keeps the shape its header describes: the
 * planted string and the scan over it, with nothing to stand up.
 */
export function expectCanaryReachedUpstream(upstream: FakeMcpServer, method = "tools/call"): void {
  const requests = upstream.callsTo(method);
  if (requests.some(request => request.authorization === `Bearer ${CANARY}`)) return;
  throw new Error(
    `e2e: the canary never reached the upstream as \`Bearer <canary>\` on ${method} — ` +
      `${String(requests.length)} request(s) to it carried ${JSON.stringify(
        requests.map(request => request.authorization)
      )}. Every "the credential did not leak" assertion below would pass for the wrong reason.`
  );
}

/** One place the canary could have surfaced, named for the failure message. */
export interface Surface {
  readonly what: string;
  readonly text: string;
}

/**
 * Renders anything to a string the scan can search.
 *
 * `JSON.stringify` rather than a structured walk on purpose: the question is
 * whether the bytes are present anywhere in a value the model or a Slack reader
 * could observe, and a walk would have to know every shape to be sure it looked
 * everywhere. A scan that over-reads is the safe direction.
 */
export function surface(what: string, value: unknown): Surface {
  return { what, text: typeof value === "string" ? value : JSON.stringify(value) ?? "" };
}

/**
 * Throws naming the surface, if the canary is on any of them.
 *
 * The message carries the surrounding text rather than the canary alone,
 * because "it leaked" is not the useful half — "it leaked into the tool result
 * the model then summarised" is.
 */
export function expectNoCanary(surfaces: readonly Surface[]): void {
  const hits = surfaces.filter(s => s.text.includes(CANARY));
  if (hits.length === 0) return;
  const detail = hits
    .map(hit => {
      const at = hit.text.indexOf(CANARY);
      const from = Math.max(0, at - 120);
      return `  ${hit.what}: …${hit.text.slice(from, at + CANARY.length + 120)}…`;
    })
    .join("\n");
  throw new Error(`e2e: the credential reached ${hits.length} agent-visible surface(s):\n${detail}`);
}

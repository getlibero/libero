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

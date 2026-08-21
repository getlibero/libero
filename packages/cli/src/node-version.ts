// Enforcing the floor `engines` only advises.
//
// npm treats `engines` as a warning unless the operator has set
// `engine-strict`, and `npx` runs the package anyway — so a CLI published as
// `>=24` will start on Node 22, work for a while, and fail somewhere further in
// with a message about whatever API was missing rather than about the runtime.
// This turns that into one sentence at the top.
//
// The floor is substituted by ../build.mjs from this package's own `engines`,
// so there is one place it is written down. The fallback keeps the source
// runnable under plain tsc output, which is what the tests run against and where
// nothing defines it.

declare const __LIBERO_NODE_FLOOR__: string;

export const NODE_FLOOR = typeof __LIBERO_NODE_FLOOR__ === "string" ? __LIBERO_NODE_FLOOR__ : ">=24.0.0";

/**
 * The complaint to print, or `null` if the runtime is new enough.
 *
 * Only the major is compared. `engines` here is a `>=X.Y.Z` floor whose minor
 * and patch have never been the point — the reason the floor is 24 is Node's
 * release lines, not one API added in a patch — and a comparison that pretended
 * otherwise would reject 24.0.0 for a floor written 24.13.3.
 */
export function nodeTooOld(version: string, floor: string = NODE_FLOOR): string | null {
  const running = major(version);
  const required = major(floor);
  if (running === null || required === null || running >= required) return null;
  return (
    `libero: needs Node ${required} or newer, and this is ${version}. ` +
    "The two services carry their own runtime in their containers; this is about the host."
  );
}

function major(text: string): number | null {
  const found = /(\d+)/.exec(text);
  if (found === null) return null;
  return Number(found[1]);
}

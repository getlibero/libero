// The reconnect policy, as arithmetic with no clock and no socket in it.
//
// Socket Mode connections drop as a matter of routine — Slack recycles the pod
// holding one every few hours and says so on the wire. So the policy has to
// distinguish a recycle from an outage, and it does it the only way a client
// can: by how long the last connection stayed up. A connection that held is
// evidence the credentials and the network are fine, so the next attempt starts
// from zero. A connection that dropped immediately is evidence of neither, so
// the delay grows.
//
// Full jitter rather than a fixed schedule. Every gateway pointed at a workspace
// sees the same Slack outage end at the same instant, and a fleet that all
// retries on the same 1s, 2s, 4s ladder reconnects in a thundering herd.

export interface BackoffPolicy {
  /** First delay, before jitter. */
  baseMs: number;
  /** Ceiling on the pre-jitter delay, so an outage settles into a steady retry. */
  maxMs: number;
  /** How long a connection must hold before the attempt counter resets. */
  resetAfterMs: number;
}

/**
 * Chosen against Slack's own numbers: the SDK's default server-ping timeout is
 * 30s, so a `maxMs` above that would leave the socket down longer than it takes
 * to notice it is down. `resetAfterMs` is a minute — longer than any handshake,
 * shorter than any healthy connection.
 */
export const DEFAULT_BACKOFF: BackoffPolicy = {
  baseMs: 1_000,
  maxMs: 30_000,
  resetAfterMs: 60_000
};

/**
 * Full jitter: `random() * min(maxMs, baseMs * 2^attempt)`.
 *
 * `attempt` is zero-based, so the first retry after a drop waits somewhere in
 * `[0, baseMs)` — a recycle reconnects almost at once, which is the common case
 * and the one worth optimizing. `random` is injected so a test can pin the
 * bounds instead of asserting on a range.
 */
export function nextDelayMs(policy: BackoffPolicy, attempt: number, random: () => number): number {
  // 2^attempt overflows to Infinity long before it matters; Math.min pins it to
  // maxMs either way, and clamping the exponent keeps that obvious.
  const exponent = Math.min(attempt, 31);
  const ceiling = Math.min(policy.maxMs, policy.baseMs * 2 ** exponent);
  return Math.floor(random() * ceiling);
}

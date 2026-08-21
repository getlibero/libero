// The sandbox's wire shapes: what the proxy asks the runner for, and what comes
// back (#368, #395).
//
// These cross a process boundary, so unlike ./audit.ts they are zod objects with
// a `.parse()` on both ends. That is the same reason ./schedule-task.ts lives in
// this package rather than in the proxy: two processes have to agree on one
// definition, and a shape restated on each side is two shapes that drift.
//
// **The runner is a third service, and this is the only thing it shares with the
// other two.** It imports these names and nothing else — no proxy code, no
// gateway code — which is what keeps its image small and its dependency list a
// security property rather than an accident. `@getlibero/schema` is importable
// from anywhere for the reason CLAUDE.md gives about leaves: it is a package
// with nothing under it.
//
// ## What is deliberately not on the request
//
// **No image, and no command.** #393 put both in the runner's own environment,
// pinned by digest. A field here would let the process on the other end name
// what runs on the host, and the whole point of the narrow endpoint is that a
// compromised proxy can ask for a code run and nothing else. The request has no
// field that reaches the container spec's `Image`, `Binds`, `Privileged` or
// capability set, and that is checkable by reading this file.
//
// **No channel.** The runner has no idea which channel a run is for and should
// not: it enforces nothing about authorization, because everything authorization
// depends on was settled before the proxy dialled it. A channel id here would be
// a fact the runner could log, correlate, or leak, bought for nothing.
//
// ## The network grant, which arrived with #219
//
// `egressAllow` is the channel's `[egress] allow` list, resolved by the same
// `decide` that authorized the call. An **empty list is the common case and
// means no network at all** — `NetworkMode: none`, not a filtered one — so a
// sheet that says nothing cannot be read as saying "anything".
//
// It carries *patterns*, not resolved hosts, because `isEgressAllowed` is what
// decides and it takes the pattern the operator wrote. A caller that resolved
// them into addresses first would be reimplementing the matcher, which #219
// calls a review failure, and would have thrown away the wildcard.

import { z } from "zod";
import { EgressPattern } from "./egress.js";
import { DestinationHost } from "./names.js";

/**
 * The most source one run may carry.
 *
 * Restated here rather than imported from the proxy because this file is what
 * the runner parses against, and the runner must not trust the caller to have
 * checked. `packages/proxy/src/builtins.ts` bounds the same string on the way
 * in; a bound on only one side of a wire is a bound an attacker skips by
 * speaking to the other side.
 */
export const SANDBOX_CODE_MAX_CHARS = 65_536;

/**
 * The caps a channel's sheet set, resolved once by `decide` and carried here.
 *
 * Bounds on every field, matching `BuiltinEntry`'s. A sheet cannot exceed them
 * because it parses against the same numbers, and this parse exists for the case
 * where something other than a sheet reached the runner.
 */
export const SandboxCaps = z.object({
  cpus: z.number().positive().max(64),
  memoryMb: z.number().int().positive().max(65_536),
  timeoutSeconds: z.number().int().positive().max(3_600)
});

export type SandboxCaps = z.infer<typeof SandboxCaps>;

/** One run: the code, how much machine it may have, and where it may reach. */
export const SandboxRunRequest = z.object({
  code: z.string().min(1).max(SANDBOX_CODE_MAX_CHARS),
  caps: SandboxCaps,
  /**
   * The channel's `[egress] allow` patterns. Empty means no network.
   *
   * `EgressPattern` rather than a bare string, so a runner handed something the
   * matcher would fail closed on refuses it at the edge instead of building a
   * hop around a list that permits nothing. Defaulted so a proxy built before
   * this field existed still parses — the default is the safe direction.
   */
  egressAllow: z.array(EgressPattern).default([])
});

export type SandboxRunRequest = z.infer<typeof SandboxRunRequest>;

/**
 * How a run ended.
 *
 * `completed` means the container exited on its own, whatever it exited *with* —
 * a non-zero status is a program that failed, which is a normal answer to a
 * question and not an error of ours.
 *
 * `timed_out` means it outlived `timeoutSeconds` and was killed. #395 is
 * explicit that this **is not a refusal and not a `ProxyError`**: the request
 * was served, the caller gets whatever was printed before the kill, and the
 * result says plainly that it was cut off.
 *
 * `egress_denied` means the code dialled a host the channel's list does not
 * allow, and the run was killed for it (#219). It is the third member and the
 * only one that is a **governance decision** rather than a fact about resources
 * — which is why the proxy turns this one into `Dispatch.refused` and the other
 * two into `ran`. Keep the distinction: a timeout is a bounded run doing what
 * bounds do, and this is the sheet refusing.
 *
 * Terminal on the first denial, decided in #393. The consequence is the one that
 * makes `deniedHost` a single field rather than a list: there is at most one
 * denied destination per run, because the first one ends it.
 */
export const SandboxOutcome = z.enum(["completed", "timed_out", "egress_denied"]);

export type SandboxOutcome = z.infer<typeof SandboxOutcome>;

/**
 * The most output the runner will read back from one container.
 *
 * The runner's own bound, and not the channel's. `CallLimits.maxResultChars` is
 * what the *model* may see and is applied by the proxy after this; this one
 * exists so a program printing in a loop cannot make the runner buffer without
 * limit before anybody gets a chance to truncate. Two bounds owned by two
 * different people, which is the shape packages/proxy/README.md already
 * describes for MCP responses.
 */
export const SANDBOX_MAX_OUTPUT_BYTES = 1_048_576;

/**
 * What one run produced.
 *
 * `stdout` and `stderr` stay separate all the way here rather than being merged
 * into one transcript, because a program that printed an answer and a warning
 * should not make the caller guess which was which. The proxy is what renders
 * them into `ToolResult.content`.
 *
 * `exitCode` is null exactly when the container never reported one — which is
 * the timeout path, where it was killed rather than having exited. Null rather
 * than a sentinel like -1, because -1 is a number a caller can compare against
 * and get wrong.
 *
 * `truncated` says the runner's own bound cut the streams. It is separate from
 * the truncation notice the proxy appends for the channel's bound, and both can
 * be true: honest about which limit did what, per #151's rule that truncation
 * says what was dropped.
 */
export const SandboxRunResult = z.object({
  outcome: SandboxOutcome,
  stdout: z.string(),
  stderr: z.string(),
  exitCode: z.number().int().nullable(),
  truncated: z.boolean(),
  /**
   * The host that ended the run, and `null` on every other outcome.
   *
   * A `DestinationHost` because that is what the refusal carries and what the
   * audit row's column holds; a shape that parsed here but not there would be a
   * run the proxy could not describe. Optional so a runner built before #219
   * still satisfies this schema, which is the same direction `egressAllow`'s
   * default takes.
   */
  deniedHost: DestinationHost.nullable().default(null)
});

export type SandboxRunResult = z.infer<typeof SandboxRunResult>;

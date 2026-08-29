// A content-addressed cache for the material `scripts/dev-certs.sh` mints.
//
// ## What it is for
//
// Before this, every file in the suite paid a fixed cost in CI before asserting
// anything — around 2.7 seconds, whether it held one case or ten — and all of it
// was openssl. `dev-certs.sh` generates five RSA-2048 keys per call, which is
// 0.577s of its 0.62s total on a developer machine and rather more on a
// four-core runner.
//
// That cost is worth paying once. It was being paid eighty-one times. Logging
// every invocation across one run of `pnpm test` gives 111 calls, of which
// **81 are the same request**: `--channels C024BE91L,C7ZZZ9999`, the pair
// `startRig` mints when a case says nothing about channels. The remaining
// thirty are one-offs and rotations.
//
// The faster fix is P-256, which mints the same five keys in 0.023s. That is
// deliberately not what this does — the key algorithm in `dev-certs.sh` is an
// operator-facing security default, and #407 records the decision to leave it
// alone rather than have the next reader wonder whether it was considered.
//
// ## What is cached, and what is never
//
// Only the opening mint: the `--channels` / `--raw-cn` call that fills a fresh
// directory. `rotate` and `promote` always run the script for real, because
// producing key material that did not exist a moment ago is the whole point of
// a rotation — a cache that answered one would be asserting against a fixture
// instead of against the command an operator runs.
//
// ## Why a hit copies rather than shares
//
// A hit copies the entry into the caller's own directory and never hands the
// entry itself out. That is what keeps this invisible to the cases rather than
// a thing each of them has to know about: `rotate` writes into `agent/staged/`
// and `promote` moves it into place, so a shared directory would let one file's
// rotation silently change what another file's certificates mean — across
// worker processes, in a suite whose entire subject is identity. Copying about
// fifteen small files costs roughly a millisecond against the 600ms it saves.
//
// ## Why the key covers the script
//
// The digest is taken over `dev-certs.sh` itself as well as the arguments, so
// editing the script invalidates every entry. Without that, a change to how
// material is minted would be invisible to the suite that exists to exercise
// it — `certs.ts` states that the documented path runs on every CI run rather
// than rotting beside the code it describes, and a cache keyed only on
// arguments would quietly make that untrue.
//
// ## Why the key also carries a generation (#490)
//
// Material is not reused forever, and **where that bound lives is the whole of
// this module's one shipped bug.** It used to live in a check: `reusable`
// refused an entry whose marker had aged past a week. But `publish` only ever
// clears a *claim* — a directory with no marker — and treats a directory that
// has one as owned by another worker with the same request. So an entry that
// aged out could never be replaced: every call minted, no call could publish,
// and two calls in one test got different material. The cache wedged itself
// permanently, and only in a working tree older than the bound, which is why CI
// never saw it.
//
// So the bound is in the key instead. An entry name is `<digest>-<generation>`,
// where the generation is the week the material was minted in, and an aged-out
// entry is simply a key nothing looks up any more: the new generation's
// directory does not exist, `mkdirSync` succeeds, and the exclusive-`mkdir`
// mutex still does its job for whoever gets there first. `reusable` is left
// asking only whether an entry is *finished*, which is a question `publish`
// already answers correctly.
//
// **Nothing sweeps the superseded generations, deliberately.** Deleting a
// directory another worker may be copying *from* is the one thing this module
// does not do, and buying tidiness with that race would be the wrong trade for
// what it costs: an entry is about fifteen small files, the suite uses a handful
// of distinct keys, and a `pnpm install` drops the cache root entirely. A
// checkout left untouched for a year holds a few megabytes of certificates for
// requests nobody will make again.

import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * How long one generation of material is reused for.
 *
 * Not a renewal policy: `dev-certs.sh` mints client certificates for 365 days
 * (`CLIENT_DAYS`), so a week is nowhere near expiry. It is a bound on how stale
 * a reused fixture may be, cheap enough that the answer to "could this have come
 * from a tree I no longer have" is always no.
 *
 * It is part of the entry's *name* rather than a check against its age, for the
 * reason the header gives: a bound that only a reader enforced left the writer
 * unable to act on it. Exported so the case that pins that behaviour can cross
 * the boundary rather than restate the number.
 */
export const GENERATION_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * How long a claimed but unfinished entry is believed.
 *
 * Copying fifteen small files takes about a millisecond, so a claim still
 * standing after a minute belongs to a worker that died holding it. Without
 * this, one killed run would leave the busiest key permanently unpublishable
 * and every later call would mint — correct, but slow forever, which is a bad
 * failure for something whose only job is speed.
 */
const STALE_CLAIM_MS = 60 * 1000;

/** Under `node_modules` so it is gitignored, and dropped by a clean install. */
function cacheRoot(repoRoot: string): string {
  return join(repoRoot, "node_modules", ".cache", "libero-e2e-certs");
}

function entryKey(scriptPath: string, args: readonly string[], nowMs: number): string {
  const digest = createHash("sha256")
    .update(readFileSync(scriptPath))
    .update(" ")
    .update(args.join(" "))
    .digest("hex")
    .slice(0, 32);
  // Floor division rather than an mtime comparison, so two callers a
  // millisecond apart agree on which entry they are talking about — an entry
  // whose identity depended on when it was *read* is one no writer could
  // replace. A run straddling a boundary mints once more than it had to, which
  // is the entire cost.
  return `${digest}-${Math.floor(nowMs / GENERATION_MS)}`;
}

/**
 * An entry is finished when its marker exists, and never before.
 *
 * The marker is a sibling of the directory rather than a file inside it, so a
 * hit copies certificate material and nothing else — `dev-certs.sh` is handed
 * these directories afterwards and should find what it would have written.
 */
function marker(entry: string): string {
  return `${entry}.complete`;
}

/**
 * Finished, and that is now the only question.
 *
 * It used to also ask whether the entry had aged out, which is the bug #490
 * records: `publish` cannot replace a finished entry, so a reader refusing one
 * on age left a key that minted forever and published never. Age is the key's
 * business now, and what is left here is a question with an answer the writer
 * can act on — an entry this rejects is absent or unfinished, and `publish`
 * handles both.
 */
function reusable(entry: string): boolean {
  return existsSync(marker(entry));
}

/**
 * Publishes a freshly minted directory under its key.
 *
 * Two workers that miss at the same moment mint *different* key material, so an
 * interleaved copy would leave a directory holding one run's CA and another
 * run's client certificate — material that validates against nothing. The
 * exclusive `mkdir` is what prevents that: creating a directory that already
 * exists is `EEXIST`, atomically, so exactly one publisher proceeds and the
 * other simply keeps what it minted.
 *
 * A rename would be the more usual way to make a half-filled directory
 * invisible, and it is deliberately not used: #272 collapsed the durable-replace
 * recipe into `@getlibero/atomic-write` and pinned the tree at exactly one call
 * to the renaming syscall, asserted by a grep that cannot be routed around —
 * this comment says it in prose for that reason. That package replaces *files*;
 * this is a directory, so the completeness marker does the job the rename would
 * have: written last, checked first, and the only thing `reusable` believes.
 *
 * Nothing here throws. A cache that cannot write is a slow suite, not a broken
 * one.
 */
function publish(root: string, entry: string, dir: string): void {
  try {
    mkdirSync(root, { recursive: true });

    // A claim left by a worker that died mid-copy, old enough that nobody is
    // still filling it. Clearing it costs one re-copy; leaving it costs every
    // future call.
    if (existsSync(entry) && !existsSync(marker(entry))) {
      if (Date.now() - statSync(entry).mtimeMs < STALE_CLAIM_MS) return;
      rmSync(entry, { recursive: true, force: true });
    }

    mkdirSync(entry);
  } catch {
    // EEXIST: another worker owns this key. It has the same request, so
    // whatever it publishes is as good as what this one minted.
    return;
  }

  try {
    cpSync(dir, entry, { recursive: true });
    writeFileSync(marker(entry), "");
  } catch {
    // Leave nothing a later run would mistake for a finished entry.
    rmSync(entry, { recursive: true, force: true });
    rmSync(marker(entry), { force: true });
  }
}

/**
 * Fills `dir` with the material `args` describes, minting it only if no
 * equivalent directory is already cached.
 *
 * `mint` is the real `dev-certs.sh` call and must write into `dir`. `args` is
 * that call without `--out`, because the destination is exactly what differs
 * between two requests that are otherwise for the same material.
 *
 * `nowMs` picks the generation and defaults to the wall clock. Only the case
 * that crosses a generation boundary passes it: waiting a week for that
 * assertion is not an option, and the alternative — reaching in and backdating
 * a marker — would pin the mechanism this bug was caused by rather than the
 * behaviour.
 */
export function mintCached(
  repoRoot: string,
  scriptPath: string,
  args: readonly string[],
  dir: string,
  mint: () => void,
  nowMs: number = Date.now()
): void {
  const root = cacheRoot(repoRoot);
  const entry = join(root, entryKey(scriptPath, args, nowMs));

  if (reusable(entry)) {
    try {
      cpSync(entry, dir, { recursive: true });
      return;
    } catch {
      // Vanished or half-read between the check and the copy. Mint instead —
      // the cost of being wrong here is a second of openssl.
    }
  }

  mint();
  publish(root, entry, dir);
}

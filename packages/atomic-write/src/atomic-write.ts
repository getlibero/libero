// Replace a file's contents atomically, or not at all — and the one place in
// the tree that knows how.
//
// ## Why this is a package
//
// The recipe was extracted from the vault's writer when the token store arrived
// (#256), on the argument that the recipe *is* the guarantee and a guarantee
// implemented twice is one that eventually holds once. It was implemented three
// times regardless. `libero init` had written its own variant four hours earlier
// that same day and nothing reconciled the two, so the file carrying
// `PROXY_VAULT_KEY` — which has no second copy and no recovery — was renamed over
// with no fsync anywhere in it. `packages/memory` then made a knowing copy
// (#225), because it is a leaf that may import neither service and there was
// nothing else to import. #272 is that prediction collected, and this package is
// its answer.
//
// Three homes were considered and two were rejected on grounds worth keeping:
//
// - **`packages/memory`.** No new dependency edge — the proxy already imports it
//   — but the third caller is `packages/cli`, which publishes one esbuild-bundled
//   file declaring *no* dependencies. Importing the message store would pull
//   `sqlite-vec` into that bundle. And memory's own barrel refuses to export this
//   symbol (`src/index.ts`), because a caller holding it would be a caller
//   writing into a channel's directory itself; a package cannot both be an
//   address for it and refuse to hand it out.
// - **`@getlibero/schema`.** Pure by rule: no I/O, no clock, no network. A
//   function whose whole content is four syscalls in an order is the opposite of
//   what that package is.
//
// So: its own leaf, and **no dependencies at all** — that is the charter rather
// than a fact that happens to hold today. What has to be importable from both
// sides of the security boundary *and* inlineable into a binary an operator
// installs from npm can afford to carry nothing.
//
// **It is named for its function because the package is the function**, and not
// `fs` or `durable`: a package named for a recipe resists becoming a drawer,
// because the next function has to argue it is the same guarantee. The name also
// happens to keep `eslint.config.mjs`'s `**/atomic-write*` bans matching the new
// specifier — that is luck, and luck holding a security property is not a plan,
// so the specifier is listed there explicitly beside the glob.
//
// ## What this module does not know
//
// What the bytes are. Encryption, caps, and deciding whether an operation is
// legal at all belong to the store that owns the file — the vault's envelope, the
// token store's cap, `MEMORY.md`'s size rule, the env file's merge. A `Buffer`
// in, and no opinion about it.

import { closeSync, fsyncSync, openSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { basename, dirname, join } from "node:path";

/**
 * The sequence is the part worth reviewing:
 *
 * - The temporary file is opened `wx` — exclusive create — as a *sibling* of the
 *   target. Exclusive create fails rather than following a symlink someone
 *   planted at the temp name, and being in the same directory is what makes the
 *   rename a pointer swap rather than a copy across filesystems, which would not
 *   be atomic.
 * - Mode `0o600` is passed to `open`, never applied by a later `chmod`. A chmod
 *   after the fact is a window in which the file exists world-readable.
 * - `fsync` on the file before the rename and on the directory after it. The
 *   rename itself has to reach the disk, and that means fsyncing the directory
 *   rather than the file — without it a power loss can leave the directory entry
 *   unwritten and the new contents orphaned.
 *
 * **The temp name's shape is load-bearing**, which is why it is a function of
 * its own with a test of its own — see `temporaryNameFor` below.
 *
 * **What `0o600` means depends on the caller, and the difference is worth
 * stating.** For the vault it is load-bearing. For `MEMORY.md` it is hygiene:
 * both services run as `USER node`, so a mode that admits the owner admits the
 * proxy too, and what keeps the proxy out of that file is that it opens no such
 * file and has no code that could. The mode is uniform because a state directory
 * that is uniformly `0600` is one an operator can reason about.
 *
 * **`rename` over a symlinked *target* replaces the symlink** and leaves
 * whatever it pointed at untouched. For a vault that is plainly the right
 * outcome, and it is tested: a store path aimed at something else does not
 * overwrite it. For `MEMORY.md` it is worth knowing rather than assuming,
 * because that file is one the team is invited to read and edit — an operator
 * who symlinked it somewhere finds a regular file after the first curation.
 *
 * Concurrent writers are last-writer-wins. There is no lock, deliberately: a
 * lock file that outlives a killed process is a worse failure than the one it
 * would prevent. Each caller states its own answer to the race — the vault's is
 * "one admin, one command, one container"; the token store's is the mutex and
 * the priced residual in its package README; memory's is one synchronous writer
 * with no point at which a second operation could interleave.
 */
export function replaceFileAtomically(file: string, bytes: Buffer): void {
  const directory = dirname(file);
  const temp = temporaryNameFor(file);

  let handle: number | undefined;
  try {
    handle = openSync(temp, "wx", 0o600);
    writeSync(handle, bytes);
    fsyncSync(handle);
    closeSync(handle);
    handle = undefined;
    renameSync(temp, file);
  } catch (error) {
    if (handle !== undefined) closeSync(handle);
    try {
      unlinkSync(temp);
    } catch {
      // Already gone, or never created. Either way there is nothing to clean.
    }
    throw error;
  }

  syncDirectory(directory);
}

/**
 * Create a file that must not already exist, durably.
 *
 * The same fsync sequence with the rename taken out, because there is nothing to
 * replace. `wx` is applied to the *real path* rather than to a temporary, and
 * that placement is the whole point: `libero init` generating `PROXY_VAULT_KEY`
 * needs two racing runs to end with one of them saying the file already exists,
 * not with a key written over a key. A temp-and-rename would give the second
 * writer a clean win over the first — correct for a replace, catastrophic for
 * this.
 *
 * So the two functions differ on symlinks, and the difference falls the right
 * way in both cases. `replaceFileAtomically` renames over a symlinked target and
 * replaces the link. This one *fails* on one: `O_EXCL` refuses a symlink at the
 * path even when its referent does not exist, so a link planted where a master
 * key is about to be written is an error rather than a write through it.
 *
 * The directory is fsynced after the close for the reason the rename needs it:
 * the file's bytes reaching the disk and its name reaching the disk are two
 * different writes.
 *
 * **This is for a create that carries a secret, and not for every create.** The
 * mode is `0o600` and not negotiable, which is right for an env file holding a
 * master key and wrong for `packages/cli/src/channel-cli.ts`'s starter team
 * sheet: that file is not a secret, it is bind-mounted read-only into a
 * container running as another uid, and forcing it owner-only would be a way to
 * break `channel add` on a host whose uid does not match. A create that wants a
 * different mode wants a different function, and should say so rather than
 * parameterising this one.
 */
export function createFileExclusively(file: string, bytes: Buffer): void {
  const handle = openSync(file, "wx", 0o600);
  try {
    writeSync(handle, bytes);
    fsyncSync(handle);
  } finally {
    closeSync(handle);
  }

  syncDirectory(dirname(file));
}

/**
 * The name the replace writes under before it claims the target's.
 *
 * Exported so its own test can pin the shape, and for no other reason —
 * ./index.ts withholds it, because a caller holding it would be a caller
 * planting a temporary file the recipe did not plant. Three modules in
 * `packages/memory` depend on this spelling to keep a leftover out of a
 * directory listing, and `skill-file.test.ts` pins the literal
 * `.deploy.md.tmp-1234-abcd`; the two tests should be read together.
 *
 * The pid is in the name so that two processes writing one target do not have to
 * rely on twelve random hex characters to stay apart; a collision would fail the
 * exclusive create rather than corrupt anything, but a write that fails for no
 * reason is still a write that failed. The leading dot is there because the
 * window in which the file exists is a window in which somebody's directory
 * listing shows it.
 */
export function temporaryNameFor(file: string): string {
  return join(
    dirname(file),
    `.${basename(file)}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`
  );
}

/**
 * A rename and a create are both directory writes, and neither reaches the disk
 * because the file's own descriptor was fsynced. Shared rather than written
 * twice, in the module whose reason for existing is that it was written twice.
 */
function syncDirectory(directory: string): void {
  const handle = openSync(directory, "r");
  try {
    fsyncSync(handle);
  } finally {
    closeSync(handle);
  }
}

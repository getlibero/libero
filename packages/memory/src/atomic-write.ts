// Replace a file's contents atomically, or not at all.
//
// ## This is a second copy, and the original is `packages/proxy/src/atomic-write.ts`
//
// Same name, same signature, same procedure — deliberately, so that a `grep`
// for `replaceFileAtomically` finds every copy in the tree and so that #272,
// which unifies them, is a delete-and-import rather than a reconciliation.
//
// It is a copy because it cannot be an import. `packages/memory` is a leaf: both
// services open these files, so it may depend on neither, and an ESLint block on
// `packages/memory/**` enforces that rather than this comment asking for it. The
// hazard is concrete rather than tidy — an import across that line would put the
// proxy's dependency tree, MCP SDK and all, into a package the gateway also
// loads. `./log.ts` is the precedent and CLAUDE.md endorses it: this package
// already duplicates an interface for exactly this reason, and names the
// duplication as the visible cost of being a leaf.
//
// **#272 is this file's expiry date.** The recipe now exists three times — here,
// in the proxy, and inlined at `packages/cli/src/init-cli.ts`, which is the one
// that already drifted: it renames without fsyncing anything. That is the
// failure the proxy's header predicted when it was extracted at #256, so this
// copy ships with the issue that removes it.
//
// ## What this module does not know
//
// What the bytes are. Encryption, caps, and deciding whether an operation is
// legal at all belong to the store that owns the file — here that is
// `./memory-file.ts`, which knows the file is UTF-8 markdown and does the
// encoding itself. A `Buffer` in, and no opinion about it.

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
 * **The mode is hygiene here, and not a boundary.** In the vault's case `0o600`
 * is load-bearing. It is not here: both services run as `USER node`
 * (`apps/server/Dockerfile`, `apps/proxy-server/Dockerfile`), so a mode that
 * admits the owner admits the proxy too, and what actually keeps the proxy out
 * of `MEMORY.md` is that it opens no such file and has no code that could. The
 * mode is kept because it is the recipe's and because a state directory that is
 * uniformly `0600` is one an operator can reason about — not because it
 * separates two processes that share a uid.
 *
 * **`rename` over a symlinked *target* replaces the symlink** and leaves
 * whatever it pointed at untouched. For a vault that is plainly the right
 * outcome. For `MEMORY.md` it is worth knowing rather than assuming, because
 * that file is one the team is invited to read and edit: an operator who
 * symlinked it somewhere finds a regular file after the first curation. See the
 * README.
 *
 * Concurrent writers are last-writer-wins, and there is no lock — the reason is
 * the proxy's and is not re-litigated here: a lock file that outlives a killed
 * process is a worse failure than the one it would prevent. Each caller states
 * its own answer to the race, and `./memory-file.ts` states memory's: one
 * writer, synchronous, with no point at which a second operation could
 * interleave.
 */
export function replaceFileAtomically(file: string, bytes: Buffer): void {
  const directory = dirname(file);
  const temp = join(
    directory,
    `.${basename(file)}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`
  );

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

  // The rename itself has to reach the disk, which means fsyncing the
  // directory rather than the file.
  const directoryHandle = openSync(directory, "r");
  try {
    fsyncSync(directoryHandle);
  } finally {
    closeSync(directoryHandle);
  }
}

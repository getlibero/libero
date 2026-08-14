// Replace a file's contents atomically, or not at all.
//
// Extracted from ./vault-file.ts when the token store arrived (#256): the
// vault's writer and the token store's writer must share one recipe, because
// the recipe is the guarantee — a power loss leaves either the old file or the
// new one, never a half-written file under the real name — and a guarantee
// implemented twice is one that eventually holds once.
//
// What did *not* move is any notion of what the bytes are. This module writes
// what it is handed; encryption, caps, and entry validation belong to the
// store that owns the file.

import { closeSync, fsyncSync, openSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { basename, dirname, join } from "node:path";

/**
 * The sequence is the part worth reviewing:
 *
 * - The temporary file is opened `wx` — exclusive create — in the *same*
 *   directory as the target. Exclusive create fails rather than following a
 *   symlink someone planted at the temp name, and same-directory is what makes
 *   the rename atomic rather than a copy across filesystems.
 * - Mode `0o600` is passed to `open`, not applied by a later `chmod`. A chmod
 *   after the fact is a window in which the file exists world-readable.
 * - `fsync` on the file before the rename and on the directory after it, so a
 *   power loss leaves either the old file or the new one, never a
 *   half-written file under the real name.
 * - `rename` over a symlinked target path replaces the *symlink* and leaves
 *   whatever it pointed at untouched. That is the right outcome and it is
 *   tested: a store path aimed at something else does not overwrite it.
 *
 * Concurrent writers are last-writer-wins. There is no lock, deliberately: a
 * lock file that outlives a killed process is a worse failure than the one it
 * would prevent. Each caller states its own answer to the race — the vault's
 * is "one admin, one command, one container"; the token store's is the mutex
 * and the priced residual in the package README.
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

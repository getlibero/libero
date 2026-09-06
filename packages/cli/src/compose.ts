// Finding the file Docker Compose would read.
//
// Compose's rule, applied by hand rather than guessed at: with no
// `--project-directory`, the project directory is the directory holding the
// compose file, and the `.env` loaded automatically is the one there. In a
// checkout of this repository the compose file is `deploy/docker-compose.yml`,
// so the environment file is `deploy/.env` and an `.env` at the root is read by
// nothing.
//
// Shared by `init`, which writes that file, and `doctor`, which reads it back.
// One implementation because the two disagreeing would be the worst outcome
// available: a doctor that pronounces a deployment healthy by reading a
// different file from the one that configures it.
//
// Since #516 it also says how to *name* that file on a command line an operator
// is told to run. Same reason, one step further on: a search that accepts four
// filenames in two directories, paired with printed advice that always said
// `deploy/docker-compose.yml`, told the operator with their own `compose.yaml`
// to run a file that is not there.

import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { displayPath } from "./io.js";

/** `deploy/` first, because that is this repository's shape. */
const DIRS = ["deploy", "."] as const;

/** Compose's own precedence. */
const NAMES = ["compose.yaml", "compose.yml", "docker-compose.yaml", "docker-compose.yml"] as const;

export interface ComposeLocation {
  readonly composeFile: string;
  readonly envFile: string;
}

/** Where the compose file and its environment file are, or `null` if neither. */
export function findCompose(cwd: string): ComposeLocation | null {
  for (const dir of DIRS) {
    for (const name of NAMES) {
      const candidate = resolve(cwd, dir, name);
      if (existsSync(candidate)) {
        return { composeFile: candidate, envFile: join(dirname(candidate), ".env") };
      }
    }
  }
  return null;
}

/**
 * The compose file as prose names it, or a phrase when there is none to name.
 *
 * Every caller here used to write the literal `deploy/docker-compose.yml`,
 * which is this repository's shape and not the operator's (#516): `findCompose`
 * accepts `deploy/` or the working directory and any of four filenames, so a
 * homelab deployment with its own `compose.yaml` was told about a file it does
 * not have. The fallback is deliberately not that literal — a sentence saying
 * "the compose file" is true of every deployment, and a path that is not there
 * is true of none.
 */
export function composeShown(cwd: string, found: ComposeLocation | null): string {
  return found === null ? "the compose file" : displayPath(cwd, found.composeFile);
}

/**
 * A `docker compose` command line naming the file that was actually found.
 *
 * The `-f` is dropped in the two cases where it would be noise or a guess: when
 * the compose file is the working directory's own, because Compose finds it
 * there without being told, and when none was found at all, because a bare
 * `docker compose` is correct wherever the operator runs it from — which is
 * more than can be said for naming a path on their behalf.
 */
export function composeCommand(cwd: string, found: ComposeLocation | null, tail: string): string {
  if (found === null) return `docker compose ${tail}`;
  const shown = displayPath(cwd, found.composeFile);
  return dirname(shown) === "." ? `docker compose ${tail}` : `docker compose -f ${shown} ${tail}`;
}

export const NO_COMPOSE_FILE =
  "no compose file under deploy/ or in this directory, so there is nowhere an " +
  "environment file would be read from. Run this from a checkout of the " +
  "repository, or name the file with --file.";

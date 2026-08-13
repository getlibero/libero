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

import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

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

export const NO_COMPOSE_FILE =
  "no compose file under deploy/ or in this directory, so there is nowhere an " +
  "environment file would be read from. Run this from a checkout of the " +
  "repository, or name the file with --file.";

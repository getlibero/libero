// The operator's path into the credential vault.
//
// A second entrypoint of the proxy process rather than a command in the
// published `libero` CLI, and the reason is where the key lives. `libero` runs
// on the operator's host; the vault file is in a container volume and the
// master key is in the container's environment. A host-side editor would need
// both of those on the host, which moves the secret across the boundary the
// whole design exists to hold. This runs where the key already is:
//
//   docker compose run --rm proxy node dist/vault.js set github_service_account < token.txt
//
// **A value is read from stdin and never from argv.** `/proc/<pid>/cmdline` is
// world-readable on Linux, `ps` shows argv to every user on the box, and a
// shell writes it to history. The *name* on the command line is fine; a name is
// not a secret.
//
// **There is no `get`.** Nothing here prints a credential value, on any path,
// including a failure. Adding a command that does is the failure this file and
// ../../packages/proxy/src/vault.ts exist to prevent.
//
// Everything is injected — argv, env, stdin, both writers — so the behaviour is
// testable without a process. src/vault.ts is the six lines that supply the
// real ones.

import {
  MAX_SECRET_BYTES,
  VaultEntryError,
  VaultError,
  readVaultEntries,
  removeEntry,
  setEntry,
  writeVaultEntries
} from "@getlibero/proxy";
import { vaultFileFromEnv, vaultKeyFromEnv } from "./env.js";
import type { Env } from "./env.js";

export interface VaultCliIo {
  argv: readonly string[];
  env: Env;
  /** The whole of stdin, or `null` when it is a terminal. */
  readStdin: () => Promise<Buffer | null>;
  out: (line: string) => void;
  err: (line: string) => void;
}

/** 0 ok, 1 an operator error, 2 a usage error. Nothing else. */
export const EXIT_OK = 0;
export const EXIT_ERROR = 1;
export const EXIT_USAGE = 2;

const USAGE = [
  "usage: vault <command>",
  "",
  "  set <name>     read a credential value from stdin and store it",
  "  list           print the names this vault holds",
  "  remove <name>  delete a credential",
  "",
  "A value is read from stdin so it never appears in argv or shell history:",
  "  vault set github_service_account < token.txt",
  "",
  "There is no command that prints a value. The proxy reads the vault at",
  "startup, so a change takes effect when the proxy restarts.",
  "",
  "Reads PROXY_VAULT_FILE and PROXY_VAULT_KEY."
].join("\n");

export async function runVaultCommand(io: VaultCliIo): Promise<number> {
  const [command, ...rest] = io.argv;

  if (command === undefined || command === "--help" || command === "-h" || command === "help") {
    io.out(USAGE);
    return command === undefined ? EXIT_USAGE : EXIT_OK;
  }
  if (command !== "set" && command !== "list" && command !== "remove") {
    io.err(`vault: unknown command: ${command}`);
    io.err(USAGE);
    return EXIT_USAGE;
  }

  let file: string;
  let key: ReturnType<typeof vaultKeyFromEnv>;
  try {
    file = vaultFileFromEnv(io.env);
    key = vaultKeyFromEnv(io.env);
  } catch (error) {
    // These messages name the variable and the shape expected, and carry
    // nothing of what was set. See `vaultKeyFromEnv`.
    io.err(messageOf(error));
    return EXIT_ERROR;
  }

  try {
    switch (command) {
      case "set":
        return await runSet(io, file, key, rest);
      case "list":
        return runList(io, file, key);
      case "remove":
        return runRemove(io, file, key, rest);
    }
  } catch (error) {
    if (error instanceof VaultError || error instanceof VaultEntryError) {
      io.err(`vault: ${error.reason}`);
      return EXIT_ERROR;
    }
    // Anything else is a filesystem fault. The message can name a path, which
    // is not a secret; it cannot name a value, because no value has been
    // interpolated into anything on this path.
    io.err(`vault: ${messageOf(error)}`);
    return EXIT_ERROR;
  }
}

async function runSet(
  io: VaultCliIo,
  file: string,
  key: ReturnType<typeof vaultKeyFromEnv>,
  rest: readonly string[]
): Promise<number> {
  const name = rest[0];
  if (name === undefined || rest.length > 1) {
    io.err("vault: set takes one name, and reads the value from stdin");
    return EXIT_USAGE;
  }

  const stdin = await io.readStdin();
  if (stdin === null) {
    // Rather than blocking on a blank terminal until the operator works out
    // that it is waiting for them.
    io.err("vault: the value is read from stdin — try: vault set <name> < file");
    return EXIT_USAGE;
  }
  if (stdin.byteLength > MAX_SECRET_BYTES) {
    io.err("vault: value_too_large");
    return EXIT_ERROR;
  }

  const value = trimOneNewline(stdin.toString("utf8"));
  const entries = setEntry(readVaultEntries(file, key), name, value);
  writeVaultEntries(file, key, entries);
  io.out(`vault: set ${name}`);
  return EXIT_OK;
}

function runList(io: VaultCliIo, file: string, key: ReturnType<typeof vaultKeyFromEnv>): number {
  // Names only, sorted. No count and no lengths: a length narrows what kind of
  // token an entry holds.
  for (const name of [...readVaultEntries(file, key).keys()].sort()) {
    io.out(name);
  }
  return EXIT_OK;
}

function runRemove(
  io: VaultCliIo,
  file: string,
  key: ReturnType<typeof vaultKeyFromEnv>,
  rest: readonly string[]
): number {
  const name = rest[0];
  if (name === undefined || rest.length > 1) {
    io.err("vault: remove takes one name");
    return EXIT_USAGE;
  }

  const next = removeEntry(readVaultEntries(file, key), name);
  if (next === null) {
    io.err(`vault: no credential named ${name}`);
    return EXIT_ERROR;
  }
  writeVaultEntries(file, key, next);
  io.out(`vault: removed ${name}`);
  return EXIT_OK;
}

/**
 * Strip exactly one trailing newline, and nothing else.
 *
 * So `echo secret |` and `printf secret |` both store the same thing, and a PEM
 * key keeps its internal newlines and any leading whitespace it came with. A
 * general `.trim()` here would silently corrupt a credential whose value really
 * does start or end with a space.
 */
function trimOneNewline(value: string): string {
  if (value.endsWith("\r\n")) return value.slice(0, -2);
  if (value.endsWith("\n")) return value.slice(0, -1);
  return value;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "failed";
}

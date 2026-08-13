// What every `libero` command is handed, and the three ways one can end.
//
// The same shape the proxy's own entrypoints use — see
// apps/proxy-server/src/{vault,budget,audit}-cli.ts. Everything a command
// touches that is not the filesystem arrives here, so behaviour is testable
// without a process: ./index.ts is the handful of lines that supply the real
// argv, the real writers, and the real working directory.
//
// `cwd` is on the interface rather than read from `process` because this CLI
// resolves paths relative to where it was run, and a test that had to
// `process.chdir` to cover that would be a test that cannot run beside another.

export interface CliIo {
  readonly argv: readonly string[];
  /** Where paths resolve from. `process.cwd()` in the real thing. */
  readonly cwd: string;
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
}

/** 0 ok, 1 an operator error, 2 a usage error. Nothing else — as the proxy's. */
export const EXIT_OK = 0;
export const EXIT_ERROR = 1;
export const EXIT_USAGE = 2;

/**
 * A bad command line, thrown where it is found and caught by the command.
 *
 * Never escapes a `runXCommand`, which is what keeps "a usage error exits 2" a
 * property of one `catch` rather than of every validator.
 */
export class UsageError extends Error {}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "failed";
}

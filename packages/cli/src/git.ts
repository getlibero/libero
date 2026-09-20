// Running `git`, for `libero skill vendor` and nothing else yet.
//
// ./dev-certs.ts's twin, and the same argument in a different key: the script
// there is run rather than reimplemented because Node cannot sign a
// certificate, and git is run rather than replaced with an HTTP client because
// **the operator's git is the point**. Their credential helper, their SSH
// agent, their `url.insteadOf`, their enterprise host — #569 asks that "plain
// git URLs work for private hosts", and a GitHub contents client serves exactly
// one host, behind a rate limit, with a token this command would then have to
// learn about. Shelling out inherits all of it and holds no credential at all.
//
// **`GIT_TERMINAL_PROMPT=0`, and nothing else added to the environment.** The
// one thing a subprocess breaks here is the prompt: `spawnSync` pipes stdin, so
// git asking `Username for 'https://…'` writes into a pipe nobody reads and the
// command hangs with no output. Refusing the prompt turns that into an error
// the operator can read. An SSH key passphrase is unaffected — that prompt goes
// to /dev/tty and still works, exactly as their own `git clone` does.
//
// **Arguments are an array, never a shell string.** No address a user types
// becomes a word the shell splits; ./skill-address.ts refuses a leading dash on
// top of that.

import { spawnSync } from "node:child_process";

/**
 * The largest single file `skill vendor` will copy, and the `maxBuffer` its
 * `git cat-file` runs under.
 *
 * `spawnSync` defaults to one mebibyte and truncates past it with an error that
 * names neither the file nor the reason, so a figure has to be chosen here
 * whatever it is; `Infinity` would be a decision nobody made. A skill is text
 * and its sidecars, and a file past this is an artefact arriving in a directory
 * that #570 mounts into every sandbox container. Refused by name, never
 * truncated.
 */
export const VENDOR_FILE_MAX_BYTES = 8 * 1024 * 1024;

export interface GitRun {
  readonly code: number;
  /** stdout as bytes: `cat-file blob` is the reason nothing here decodes. */
  readonly out: Buffer;
  readonly err: string;
}

export type GitRunner = (args: readonly string[], cwd: string) => GitRun;

export function runGit(args: readonly string[], cwd: string): GitRun {
  const result = spawnSync("git", [...args], {
    cwd,
    maxBuffer: VENDOR_FILE_MAX_BYTES,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" }
  });

  if (result.error !== undefined) {
    const code = (result.error as NodeJS.ErrnoException).code;
    // The one failure worth translating, as ./dev-certs.ts translates the same
    // errno for `sh`: a host with no git says nothing about what is missing or
    // which commands still work without it.
    if (code === "ENOENT") {
      throw new Error(
        "skill vendor needs git on PATH, and git was not found.\n" +
          "libero:   init and doctor need neither git nor openssl. Install git, or copy the " +
          "skill directory into your shared skills root by hand."
      );
    }
    throw result.error;
  }

  return {
    code: result.status ?? 1,
    out: result.stdout ?? Buffer.alloc(0),
    err: (result.stderr ?? Buffer.alloc(0)).toString("utf8").trimEnd()
  };
}

/** stdout as text, for every call but `cat-file blob`. */
export function text(run: GitRun): string {
  return run.out.toString("utf8");
}

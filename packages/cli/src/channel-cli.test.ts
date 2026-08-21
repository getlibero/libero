import { X509Certificate } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseTeamSheet } from "@getlibero/schema";
import { after as afterAll, before as beforeAll, describe, it } from "node:test";
import { each } from "@getlibero/test-kit";
import { expect } from "expect";
import { EXIT_ERROR, EXIT_OK, EXIT_USAGE } from "./io.js";
import { fingerprintOf } from "./dev-certs.js";
import type { CertRun } from "./dev-certs.js";
import { runChannelCommand } from "./channel-cli.js";

/**
 * The script in the repository, not the copy `build.mjs` puts in `dist/`.
 *
 * The same thing `packages/proxy/src/server.test.ts` does with it, and for the
 * same reason: the documented path is exercised on every CI run rather than
 * rotting. CI separately asserts the two files are byte-identical.
 */
const SCRIPT = fileURLToPath(new URL("../../../scripts/dev-certs.sh", import.meta.url));

interface Run {
  code: number;
  out: string[];
  err: string[];
  text: string;
}

function run(argv: string[], cwd: string, script = SCRIPT): Run {
  const out: string[] = [];
  const err: string[] = [];
  const code = runChannelCommand(
    { argv: ["channel", ...argv], cwd, out: line => void out.push(line), err: line => void err.push(line) },
    argv,
    { script }
  );
  return { code, out, err, text: [...out, ...err].join("\n") };
}

/** A runner that mints nothing, for the cases that never get as far as openssl. */
function withRunner(argv: string[], cwd: string, result: CertRun): { run: Run; calls: string[][] } {
  const calls: string[][] = [];
  const out: string[] = [];
  const err: string[] = [];
  const code = runChannelCommand(
    { argv: ["channel", ...argv], cwd, out: line => void out.push(line), err: line => void err.push(line) },
    argv,
    {
      script: "/nowhere/dev-certs.sh",
      run: (_script, args) => {
        calls.push([...args]);
        return result;
      }
    }
  );
  return { run: { code, out, err, text: [...out, ...err].join("\n") }, calls };
}

const OK: CertRun = { code: 0, out: [], err: [] };

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "libero-cli-channel-"));
  // One CA and one proxy certificate for the whole file: RSA keygen is the
  // slow part, and every test below is isolated by channel id rather than by
  // tree. `add` of the first channel is what mints them.
  const first = run(["add", "SETUP"], dir);
  expect(first.code).toBe(EXIT_OK);
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("add", () => {
  it("writes a sheet pinning the certificate it just minted", () => {
    const result = run(["add", "C024BE91L", "--name", "engineering"], dir);

    expect(result.code).toBe(EXIT_OK);

    const sheet = join(dir, "channels", "C024BE91L", "channel.toml");
    const parsed = parseTeamSheet(readFileSync(sheet, "utf8"));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const pem = join(dir, "deploy", "certs", "agent", "client-C024BE91L.pem");
    expect(parsed.sheet.channel.certificate_sha256).toEqual([fingerprintOf(pem)]);
    expect(parsed.sheet.channel.name).toBe("engineering");
  });

  it("mints a certificate whose subject names the channel", () => {
    run(["add", "C0SUBJECT"], dir);

    // The channel id the proxy resolves comes from the CN and from nowhere
    // else, so this is the property of the minted material worth asserting.
    const pem = join(dir, "deploy", "certs", "agent", "client-C0SUBJECT.pem");
    const certificate = new X509Certificate(readFileSync(pem));

    expect(certificate.subject).toContain("CN=channel:C0SUBJECT");
  });

  it("names the channel when no --name is given", () => {
    run(["add", "C0NONAME"], dir);

    const parsed = parseTeamSheet(readFileSync(join(dir, "channels", "C0NONAME", "channel.toml"), "utf8"));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.sheet.channel.name).toBe("C0NONAME");
  });

  it("refuses a channel that already has a sheet, and changes nothing", () => {
    run(["add", "C0TWICE"], dir);
    const sheet = join(dir, "channels", "C0TWICE", "channel.toml");
    const before = readFileSync(sheet, "utf8");

    const again = run(["add", "C0TWICE"], dir);

    expect(again.code).toBe(EXIT_ERROR);
    expect(again.err.join("\n")).toContain("already has a team sheet");
    expect(readFileSync(sheet, "utf8")).toBe(before);
  });

  it("writes a sheet for a channel whose certificate already exists", () => {
    // The recovery case: material minted, sheet lost. The script keeps the
    // certificate rather than re-minting it, so the pin still has to match.
    run(["add", "C0RECOVER"], dir);
    const sheet = join(dir, "channels", "C0RECOVER", "channel.toml");
    const pem = join(dir, "deploy", "certs", "agent", "client-C0RECOVER.pem");
    const fingerprint = fingerprintOf(pem);
    rmSync(sheet);

    const result = run(["add", "C0RECOVER"], dir);

    expect(result.code).toBe(EXIT_OK);
    expect(result.text).toContain("exists — kept");
    expect(fingerprintOf(pem)).toBe(fingerprint);
    expect(readFileSync(sheet, "utf8")).toContain(fingerprint);
  });

  it("honours --channels-root and --out", () => {
    const result = run(["add", "C0ELSEWHERE", "--channels-root", "sheets", "--out", "tls"], dir);

    expect(result.code).toBe(EXIT_OK);
    expect(existsSync(join(dir, "sheets", "C0ELSEWHERE", "channel.toml"))).toBe(true);
    expect(existsSync(join(dir, "tls", "agent", "client-C0ELSEWHERE.pem"))).toBe(true);
  });
});

describe("rotation stays two acts", () => {
  it("stages a replacement and changes nothing in service", () => {
    run(["add", "C0ROTATE"], dir);
    const pem = join(dir, "deploy", "certs", "agent", "client-C0ROTATE.pem");
    const inService = fingerprintOf(pem);

    const result = run(["rotate", "C0ROTATE"], dir);

    expect(result.code).toBe(EXIT_OK);
    expect(fingerprintOf(pem)).toBe(inService);
    expect(existsSync(join(dir, "deploy", "certs", "agent", "staged", "client-C0ROTATE.pem"))).toBe(true);
  });

  it("tells the operator to finish with a command they have", () => {
    // Driven through the CLI, the script must not name its own path — under an
    // npm install that is a directory nobody should be told to type.
    run(["add", "C0HINT"], dir);

    const result = run(["rotate", "C0HINT"], dir);

    expect(result.text).toContain("libero channel promote C0HINT");
    expect(result.text).not.toContain("dev-certs.sh --promote");
  });

  it("refuses to promote before the sheet pins the staged fingerprint", () => {
    run(["add", "C0EARLY"], dir);
    run(["rotate", "C0EARLY"], dir);
    const pem = join(dir, "deploy", "certs", "agent", "client-C0EARLY.pem");
    const inService = fingerprintOf(pem);

    const result = run(["promote", "C0EARLY"], dir);

    expect(result.code).toBe(EXIT_ERROR);
    expect(result.text).toContain("does not pin the staged fingerprint");
    expect(fingerprintOf(pem)).toBe(inService);
  });

  it("promotes once the sheet pins it", () => {
    run(["add", "C0LATE"], dir);
    run(["rotate", "C0LATE"], dir);
    const sheet = join(dir, "channels", "C0LATE", "channel.toml");
    const staged = fingerprintOf(join(dir, "deploy", "certs", "agent", "staged", "client-C0LATE.pem"));
    writeFileSync(sheet, readFileSync(sheet, "utf8").replace("]", `  "${staged}",\n]`));

    const result = run(["promote", "C0LATE"], dir);

    expect(result.code).toBe(EXIT_OK);
    expect(fingerprintOf(join(dir, "deploy", "certs", "agent", "client-C0LATE.pem"))).toBe(staged);
  });

  it("prints every channel's pin", () => {
    const result = run(["pins"], dir);

    expect(result.code).toBe(EXIT_OK);
    expect(result.text).toContain("certificate_sha256");
  });
});

describe("what it refuses before minting anything", () => {
  each([
    [["add", "../escape"], "not a channel id"],
    [["add", "example"], "documented starter sheet"],
    [["add"], "takes one channel id"],
    [["add", "a", "b"], "takes one channel id"],
    [["rotate", "C0X", "--name", "n"], "--name is only for channel add"],
    [["pins", "C0X"], "takes no arguments"],
    [["add", "C0X", "--chanels-root", "x"], "unknown option"]
  ])("%s exits 2 and runs nothing", (argv, expected) => {
    const { run: result, calls } = withRunner([...argv], dir, OK);

    expect(result.code).toBe(EXIT_USAGE);
    expect(result.err.join("\n")).toContain(expected as string);
    expect(calls).toEqual([]);
  });

  it("refuses an unknown subcommand", () => {
    const { run: result, calls } = withRunner(["remove", "C0X"], dir, OK);

    expect(result.code).toBe(EXIT_USAGE);
    expect(result.err.join("\n")).toContain("unknown channel command: remove");
    expect(calls).toEqual([]);
  });

  it("prints usage on stdout for --help, and exits 0", () => {
    const { run: result } = withRunner(["--help"], dir, OK);

    expect(result.code).toBe(EXIT_OK);
    expect(result.out.join("\n")).toContain("usage: libero channel");
  });

  it("asks for a subcommand when given none", () => {
    const { run: result } = withRunner([], dir, OK);

    expect(result.code).toBe(EXIT_USAGE);
    expect(result.err.join("\n")).toContain("channel needs a command");
  });
});

describe("what it passes to the script", () => {
  it("maps each subcommand to the flag the script takes", () => {
    const root = mkdtempSync(join(tmpdir(), "libero-cli-args-"));
    try {
      expect(withRunner(["rotate", "C0ARGS"], root, OK).calls).toEqual([
        ["--rotate", "C0ARGS", "--out", "deploy/certs", "--channels-root", "channels"]
      ]);
      expect(withRunner(["promote", "C0ARGS"], root, OK).calls).toEqual([
        ["--promote", "C0ARGS", "--out", "deploy/certs", "--channels-root", "channels"]
      ]);
      expect(withRunner(["pins"], root, OK).calls).toEqual([
        ["--print-pins", "--out", "deploy/certs", "--channels-root", "channels"]
      ]);
      expect(withRunner(["add", "C0ARGS", "--out", "tls"], root, OK).calls).toEqual([
        ["--channels", "C0ARGS", "--out", "tls", "--channels-root", "channels"]
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reports a script that failed, and writes no sheet", () => {
    const root = mkdtempSync(join(tmpdir(), "libero-cli-fail-"));
    try {
      const { run: result } = withRunner(["add", "C0FAIL"], root, {
        code: 1,
        out: [],
        err: ["dev-certs: openssl is required and was not found on PATH"]
      });

      expect(result.code).toBe(EXIT_ERROR);
      expect(result.err.join("\n")).toContain("openssl is required");
      expect(existsSync(join(root, "channels", "C0FAIL", "channel.toml"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

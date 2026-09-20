// `libero skill` — publishing a shared skill into the root an operator's
// repository tracks.
//
// One subcommand today, and a subcommand rather than a top-level verb because
// the shared root has more than one thing that could be done to it and #439's
// siblings are where they would go. `channel`'s shape, exactly: its own command
// table, `parseArgs` in strict mode, one `try` around parsing and one around
// execution, and an exhaustive switch with no default so a verb added later
// cannot be forgotten here.
//
// **It runs on the host, under the operator, and writes into git.** That is
// #98's line and this is on the near side of it: the shared skills root is
// bind-mounted read-only into the agent, nothing at runtime writes there, and
// the model has no install verb — #373 declined a runtime marketplace client
// outright, because auto-updating text that enters a model's context is an
// injection subscription. A command on the operator's host, whose output is a
// diff they review, is none of that.

import { parseArgs } from "node:util";
import { EXIT_ERROR, EXIT_OK, EXIT_USAGE, UsageError, messageOf } from "./io.js";
import type { CliIo } from "./io.js";
import { runGit } from "./git.js";
import type { GitRunner } from "./git.js";
import { vendorSkill } from "./skill-vendor.js";
import type { VendorOptions } from "./skill-vendor.js";

/** Where shared skills live, as `libero doctor` already defaults. */
const DEFAULT_SHARED_SKILLS_ROOT = "shared-skills";

export const USAGE = [
  "usage: libero skill <command>",
  "",
  "  vendor <address>        copy a skill directory out of a git repository at a",
  "                          pinned commit, into your shared skills root",
  "",
  "  --skill NAME            publish it under this name (default: the last",
  "                          segment of the address)",
  "  --shared-skills-root DIR",
  "                          where shared skills live (default: shared-skills)",
  "  --force                 replace a skill already published under that name",
  "",
  "An address is owner/repo/path@ref, or a git URL:",
  "",
  "  libero skill vendor anthropics/skills/skills/pdf@main",
  "  libero skill vendor git@git.example.com:team/skills.git/pdf@v1.2.0",
  "",
  "The ref is required — it is the pin, and it is written into the file as",
  "three metadata: lines so the copy says where it came from. A ref is resolved",
  "to a 40-character commit before anything is read.",
  "",
  "In a git URL the repository ends at the last segment spelled with .git;",
  "without one the whole URL is the repository. Spell it with the suffix when",
  "the skill is a directory inside the repository.",
  "",
  "The skill is copied whole — SKILL.md and every file beside it, with its",
  "mode bits — and refused whole if it holds a symlink or a submodule. Its",
  "SKILL.md has to parse as a shared skill; it is not rewritten to fit, because",
  "the copy is meant to be a reviewable diff against what upstream wrote.",
  "",
  "This runs your git, with your credentials: whatever `git ls-remote <url>`",
  "reaches, this reaches. Nothing is written until every check has passed.",
  "",
  "Reads no environment. Every path is resolved from the working directory."
].join("\n");

const COMMANDS = ["vendor"] as const;
type Command = (typeof COMMANDS)[number];

function isCommand(value: string): value is Command {
  return (COMMANDS as readonly string[]).includes(value);
}

/** Injected so a test can assert what is passed to git without running one. */
export interface SkillDeps {
  readonly run: GitRunner;
}

export function runSkillCommand(io: CliIo, argv: readonly string[], deps?: Partial<SkillDeps>): number {
  const [command, ...rest] = argv;
  const run = deps?.run ?? runGit;

  if (command === undefined) {
    io.err("libero: skill needs a command");
    io.err(USAGE);
    return EXIT_USAGE;
  }
  if (command === "--help" || command === "-h" || command === "help") {
    io.out(USAGE);
    return EXIT_OK;
  }
  if (!isCommand(command)) {
    io.err(`libero: unknown skill command: ${command}`);
    io.err(USAGE);
    return EXIT_USAGE;
  }

  let options: VendorOptions;
  try {
    options = parseVendor(rest);
  } catch (error) {
    if (error instanceof UsageError) {
      io.err(error.message);
      return EXIT_USAGE;
    }
    throw error;
  }

  try {
    switch (command) {
      case "vendor":
        return vendorSkill(io, options, run);
    }
  } catch (error) {
    if (error instanceof UsageError) {
      io.err(error.message);
      return EXIT_USAGE;
    }
    io.err(`libero: ${messageOf(error)}`);
    return EXIT_ERROR;
  }
}

function parseVendor(rest: readonly string[]): VendorOptions {
  let values: Record<string, string | boolean | undefined>;
  let positionals: string[];
  try {
    const parsed = parseArgs({
      args: [...rest],
      strict: true,
      allowPositionals: true,
      options: {
        skill: { type: "string" },
        "shared-skills-root": { type: "string" },
        force: { type: "boolean" }
      }
    });
    values = parsed.values;
    positionals = parsed.positionals;
  } catch (error) {
    const message = error instanceof Error ? error.message : "bad arguments";
    throw new UsageError(`libero: ${message.charAt(0).toLowerCase()}${message.slice(1)}`);
  }

  if (positionals.length !== 1) {
    throw new UsageError("libero: skill vendor takes one address: owner/repo/path@ref");
  }

  const skill = values["skill"];
  const root = values["shared-skills-root"];
  return {
    address: positionals[0] as string,
    ...(typeof skill === "string" ? { skill } : {}),
    sharedSkillsRoot: typeof root === "string" ? root : DEFAULT_SHARED_SKILLS_ROOT,
    force: values["force"] === true
  };
}

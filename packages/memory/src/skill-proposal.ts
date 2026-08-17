// One channel's open merge proposals: `proposals/*.md`, beside `skills/` and
// never inside it (#295).
//
// The curator drafts a merge of two playbooks and writes it here. **It changes no
// skill file.** A person reads the proposal, applies it by replacing one skill
// and deleting the other, and deletes the proposal — or declines it by deleting
// the proposal and nothing else. Reconciliation is how either takes effect,
// exactly as it is for any other hand edit to that directory.
//
// ## A sibling of `skills/`, not a child, and that is load-bearing
//
// `openSkillFiles` lists `skills/` by round-tripping each filename stem through
// `SkillName`. A proposal dropped in there whose stem happened to parse would
// therefore be *indexed as a skill* — a third playbook, quoting two others,
// retrievable into a later task's context. So the directory is a sibling, and the
// filename carries a double dash, which `SKILL_NAME_PATTERN` cannot produce.
//
// ## There is no `read`, and that is the design rather than an omission
//
// Nothing in this process ever reads a proposal back. What stops a pair being
// proposed twice is `skill_merge_proposal` in the index; what finds a proposal
// whose skill is gone is `orphanedSkillMergeProposals`; what applies one is a
// person with an editor. Three things follow, and the middle one is the reason:
//
//   - **There is no path by which model-authored text in this directory re-enters
//     a model's context.** A `read` would create one, and "a file the agent
//     wrote, quoting two skills, that the agent later reads" is exactly the shape
//     `e2e/skill-poisoning.test.ts` exists to keep closed.
//   - The format needs no parser, no version, and no `proposal_unusable` log
//     word, because nothing here will ever be asked to understand one again.
//   - A team can **edit** a proposal before applying it — annotate it, reorder
//     it, cut half of it — and nothing notices or cares. That is the right
//     relationship with a file that is a suggestion.
//
// ## What this object cannot do
//
// It cannot name a skill file. There is no method that takes one and no path it
// can build into `skills/`, which is the structural half of "the curator writes
// no skill file" — the other half being that `packages/agent`'s merge turn takes
// no handler at all.

import { existsSync, mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { ChannelId, SkillName, serializeSkillFile } from "@getlibero/schema";
import type { SkillFile, SkillMergeDraft } from "@getlibero/schema";
import { replaceFileAtomically } from "@getlibero/atomic-write";
import type { SkillPairKey } from "./store-db.js";
import type { Logger } from "./log.js";

/**
 * The directory's name inside the channel's state directory.
 *
 * Module-private with no exported path helper, `SKILLS_DIRNAME`'s rule: a test
 * that computes the path itself is asserting the layout, and one that called our
 * own helper would assert nothing.
 */
const PROPOSALS_DIRNAME = "proposals";

const PROPOSAL_SUFFIX = ".md";

/**
 * What joins the two names in a proposal's filename.
 *
 * A double dash, which is a thing `SKILL_NAME_PATTERN` cannot produce — it is
 * lowercase words joined by *single* dashes — so splitting on it is unambiguous
 * however many dashes either name carries.
 */
const PAIR_SEPARATOR = "--";

export interface SkillProposalsOptions {
  /** The channel these proposals belong to. Validated as a `ChannelId`. */
  readonly channel: string;
  /** `<root>/<channel>` must already exist. `proposals/` is created lazily. */
  readonly root: string;
  readonly logger?: Logger;
}

/**
 * Everything one proposal says, before it is rendered.
 *
 * The two `Before` files are the skills exactly as they are on disk now, read by
 * the caller through `openSkillFiles().read` — so a proposal quotes what a person
 * opening the directory would see, rather than what an index remembered.
 */
export interface SkillMergeProposal {
  readonly draft: SkillMergeDraft;
  /** The skill the merge keeps, as it is now. */
  readonly keepBefore: SkillFile;
  /** The skill the merge would delete, as it is now. */
  readonly dropBefore: SkillFile;
  /**
   * The merged file as it should read once applied — the whole document,
   * frontmatter included, so applying it is a paste rather than surgery.
   */
  readonly after: SkillFile;
  /** The model that drafted it, when the provider echoed one. */
  readonly model?: string;
  /** When it was drafted, rendered as a UTC date. */
  readonly at: number;
}

/**
 * One channel's open merge proposals, as three named operations.
 *
 * **No method takes a channel id and none returns one**, `SkillFiles`' rule: the
 * factory closed over exactly one directory.
 *
 * **There is no `read`** — see the header, where that is the module's central
 * decision rather than a missing convenience.
 */
export interface SkillProposals {
  /**
   * How many proposals are waiting.
   *
   * A `readdir` and nothing else; no file is opened. It is the count a caller
   * bounds itself against, and counting the *directory* rather than the index is
   * what makes deleting a file both the decline and the way to unblock the pass.
   */
  count(): number;
  /**
   * Write one pair's proposal, replacing any proposal for the same pair.
   *
   * The filename is built from the pair, in name order, and **never from
   * anything the model wrote** — so a `keep` that somehow escaped its parser
   * still could not name a path. Lands by rename, so a person reading the
   * directory sees the old draft or the new one and never a torn file.
   */
  write(proposal: SkillMergeProposal): void;
  /** Remove one pair's proposal. `false` when there was none. */
  remove(pair: SkillPairKey): boolean;
}

export function openSkillProposals(options: SkillProposalsOptions): SkillProposals {
  const { channel, root, logger } = options;

  if (!ChannelId.safeParse(channel).success) {
    throw new Error(`memory store: ${JSON.stringify(channel)} is not a valid channel id`);
  }

  const stateDirectory = join(root, channel);
  const directory = join(stateDirectory, PROPOSALS_DIRNAME);

  // Not created here, `openSkillFiles`' rule and its reason: the channel's state
  // directory existing is the operator's statement that the channel exists.
  if (!existsSync(stateDirectory)) {
    throw new Error(
      `memory store: ${stateDirectory} has no state directory, so this channel has nowhere to ` +
        `keep a merge proposal. The agent creates one after checking the channel has a team sheet.`
    );
  }

  /**
   * `proposals/` on the first write, and never before.
   *
   * Non-recursive, `ensureDirectory`'s argument in ./skill-file.ts exactly: one
   * level down the "never invent a channel" hazard is unreachable, and a
   * `<channel>/` that vanished throws `ENOENT` here rather than being recreated
   * underneath us. Lazy, so a channel whose sheet says `curate = false` never
   * acquires an empty directory.
   */
  const ensureDirectory = (): void => {
    try {
      mkdirSync(directory);
    } catch (error) {
      if (!isErrno(error, "EEXIST")) throw error;
    }
  };

  const fileFor = (pair: SkillPairKey): string => {
    const [first, second] = pair.a <= pair.b ? [pair.a, pair.b] : [pair.b, pair.a];
    return join(directory, `${first}${PAIR_SEPARATOR}${second}${PROPOSAL_SUFFIX}`);
  };

  /**
   * The proposals in the directory, as filename stems.
   *
   * The filter is two `SkillName` round-trips rather than a suffix check, which
   * is `names()`'s rule in ./skill-file.ts: it excludes anything a person or a
   * half-finished write left behind, including the temporary files
   * `replaceFileAtomically` plants.
   */
  const names = (): string[] => {
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch (error) {
      // Only `ENOENT` reads as empty, `names()`' rule and its reason sharpened:
      // this count is what a caller stops proposing against, so answering "none
      // waiting" for a directory we could not read would resume proposing into a
      // backlog nobody can see.
      if (isErrno(error, "ENOENT")) return [];
      throw error;
    }

    const found: string[] = [];
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (!entry.name.endsWith(PROPOSAL_SUFFIX)) continue;
      const stem = entry.name.slice(0, -PROPOSAL_SUFFIX.length);
      const halves = stem.split(PAIR_SEPARATOR);
      if (halves.length !== 2) continue;
      if (!halves.every(half => SkillName.safeParse(half).success)) continue;
      found.push(stem);
    }
    return found.sort();
  };

  logger?.log("info", { event: "proposals_opened", channel, file: directory });

  return {
    count() {
      return names().length;
    },

    write(proposal) {
      ensureDirectory();
      const file = fileFor({ a: proposal.draft.keep, b: proposal.draft.drop });
      replaceFileAtomically(file, Buffer.from(renderMergeProposal(proposal), "utf8"));
    },

    remove(pair) {
      try {
        unlinkSync(fileFor(pair));
        return true;
      } catch (error) {
        if (isErrno(error, "ENOENT")) return false;
        throw error;
      }
    }
  };
}

/**
 * The proposal, as the file a person opens.
 *
 * Exported for its own test and absent from the barrel, `planSkillOp`'s standing:
 * a caller holding this would be a caller deciding for itself what a proposal
 * looks like.
 *
 * Four things about the shape are decisions rather than layout.
 *
 * **The After block is a whole file, frontmatter included.** `created` and
 * `status` come from the kept skill, so applying the proposal is a paste over one
 * file rather than a surgical edit inside it — which is what makes "apply" one
 * unambiguous act somebody can do at 5pm without re-reading this comment.
 *
 * **`old → new` is a human diff and not a machine one.** No unified-diff hunks: a
 * merged body is a rewrite rather than an edit, so hunks over two rewritten
 * playbooks are unreadable, and a diff format would imply a patch tool that does
 * not exist here. Three whole documents under three headings is what a person can
 * actually read, and anyone who wants hunks has `diff` once they have applied it.
 *
 * **The fence length is computed rather than fixed at three.** Skill bodies are
 * markdown and routinely contain fenced code; a fixed fence would let a body
 * break out of its block, which is both a rendering bug and a way for a body
 * somebody planted to forge this file's own instructions.
 *
 * **The instructions come first, above every quoted body.** So text that tries to
 * impersonate the framing is below the real framing and inside a fence.
 */
export function renderMergeProposal(proposal: SkillMergeProposal): string {
  const { draft, keepBefore, dropBefore, after } = proposal;
  const keepFile = `skills/${draft.keep}.md`;
  const dropFile = `skills/${draft.drop}.md`;

  const afterText = serializeSkillFile(after);
  const keepText = serializeSkillFile(keepBefore);
  const dropText = serializeSkillFile(dropBefore);

  const drafted =
    proposal.model === undefined
      ? `Drafted ${utcDate(proposal.at)}.`
      : `Drafted ${utcDate(proposal.at)} by \`${proposal.model}\`.`;

  return [
    `# Proposed merge: \`${draft.keep}\` + \`${draft.drop}\``,
    "",
    "Two of this channel's playbooks look like one playbook written twice. The",
    "agent drafted the merge below and **changed nothing**. Nothing happens until",
    "somebody here acts.",
    "",
    `**To apply it:** replace \`${keepFile}\` with the After block below, delete`,
    `\`${dropFile}\`, and delete this file. The merged skill keeps the name`,
    `\`${draft.keep}\` so that its use counts and the date it first appeared`,
    "survive the merge; a third name would reset both.",
    "",
    "**To decline it:** delete this file. Nothing else is needed and nothing needs",
    "telling. This pair will not be raised again until one of the two descriptions",
    "changes.",
    "",
    drafted,
    "",
    `## After — \`${keepFile}\``,
    "",
    fenced(afterText),
    "",
    `## Before — \`${keepFile}\``,
    "",
    fenced(keepText),
    "",
    `## Before — \`${dropFile}\` (delete this file)`,
    "",
    fenced(dropText),
    ""
  ].join("\n");
}

/**
 * One block, fenced wide enough to hold whatever is in it.
 *
 * The fence is one backtick longer than the longest run the text contains, with a
 * floor of three. A skill body containing a ```` ``` ```` block therefore stays
 * inside its block rather than ending it early — see `renderMergeProposal`.
 */
function fenced(text: string): string {
  const longest = [...text.matchAll(/`+/g)].reduce((most, run) => Math.max(most, run[0].length), 0);
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}markdown\n${text}${text.endsWith("\n") ? "" : "\n"}${fence}`;
}

/** The instant as a UTC calendar date. `utcDate`'s twin in ./skill-file.ts. */
function utcDate(at: number): string {
  return new Date(at).toISOString().slice(0, 10);
}

function isErrno(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === code
  );
}

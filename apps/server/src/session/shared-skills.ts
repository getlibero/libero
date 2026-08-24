// The standing region's contents: the shared skills a sheet asks for on every
// task (#435).
//
// `[[shared_skill]] load = "always"` is the consistency case #373 exists for.
// Retrieval will never load `brand-voice` for a task about a database migration,
// and shaping every reply is the point of a voice skill — so these are not
// retrieved, they stand. `MEMORY.md`'s standing, where the summaries have the
// other one.
//
// ## What this reads, and what it never does
//
// It reads the operator's shared root through `openSharedSkillFiles`, which has
// three methods and no writer. Nothing here writes, indexes, embeds, or records
// a use: an always-loaded skill is never in a channel's index at all (#434 holds
// the retrieved half only), so there is no row for a counter to sit on and no
// clock that would read one. What answers "what is this channel loading" is the
// log line per skill below, which is what the operator wanted the counter for.
//
// ## Two bounds, and only one of them is enforced here
//
// `max_always_skills` is the schema's: its root `.check()` refuses a sheet that
// names more `always` entries than the cap, so a sheet that parsed is already
// inside it. It is applied again here anyway, because it costs a `slice` and it
// makes the region bound itself whatever it is one day assembled from — #270's
// persona is the case that stops that being hypothetical.
//
// `max_always_chars` can only be enforced here. The schema can see how many
// entries a sheet names and cannot see what those files weigh, and the weight is
// the thing that matters: this text is in the input of *every* turn for the rest
// of the task, competing with the transcript and `MEMORY.md`.
//
// ## Three ways a named skill does not load, and all three are log lines
//
// The root is not configured or not there; the file is missing or unreadable;
// the file would breach the region's ceiling. **A dangling name is dropped with
// a log line naming it, and so is an over-long one** — the same outcome for both,
// which is what `packages/schema/src/team-sheet.ts`'s `shared_skill` header
// settled when the entries landed. A dangling name cannot be a parse error: the
// file is in another root, read by another process at another time, so a sheet
// that parsed on Tuesday would stop parsing on Wednesday because somebody moved
// a file the schema has no business reading.
//
// It is the operator's failure and it reaches the operator's log. `libero
// doctor` (#433) is what catches it before a deploy — it fails when a sheet
// names a skill the shared root does not hold — so what reaches here is a root
// that changed after that ran. The channel is told nothing, because the channel
// cannot fix it and the text would be charged against every turn of every task
// for as long as the mistake stood.
//
// ## Never truncated
//
// A skill that would breach the ceiling is dropped **whole**. Half a playbook is
// worse than none of it: the half that survives reads as complete, and the
// sentence that mattered may be the one that went. That is `max_skill_chars`'
// rule in ./skill-recall.ts arriving at the region rather than at the file.

import { openSharedSkillFiles } from "@getlibero/memory";
import { sharedSkillRef } from "@getlibero/schema";
import type { SharedSkillEntry } from "@getlibero/schema";
import { createSilentLogger } from "@getlibero/gateway";
import type { Logger } from "@getlibero/gateway";
import type { LoadedSkill } from "./skill-recall.js";

export interface SharedSkillReaderOptions {
  /**
   * `AGENT_SHARED_SKILLS_ROOT`, or `null` when this deployment publishes none.
   *
   * `null` is a supported deployment and not a failure — see `env.ts`. What it
   * changes here is only that a sheet naming an entry gets a log line saying the
   * root is unset, rather than one saying the file is missing.
   */
  readonly root: string | null;
  readonly logger?: Logger;
}

export interface SharedSkillRequest {
  readonly channel: string;
  /** The sheet's entries, both modes, in the order it named them. */
  readonly entries: readonly SharedSkillEntry[];
  /** `[skills] max_always_skills`. */
  readonly maxSkills: number;
  /** `[skills] max_always_chars`. */
  readonly maxChars: number;
}

/**
 * What the standing region is assembled from, or `[]`.
 *
 * Named by the **address** rather than the filename — `shared/brand-voice`, not
 * `brand-voice` — which is `sharedSkillRef`'s second stated caller. The region
 * renders what it is handed, so this is where a channel-grown `brand-voice` and
 * an operator's stop being able to look like each other.
 */
export type SharedSkillReader = (request: SharedSkillRequest) => readonly LoadedSkill[];

/**
 * The rendered weight of one skill in the region.
 *
 * The heading and the body, because that is what the region will print — a
 * ceiling measured against something other than what is rendered is a ceiling
 * that does not bind. The description is not counted because it is not printed:
 * it is the line retrieval matches against, and nothing retrieves these.
 */
function weigh(name: string, body: string): number {
  return `## ${name}\n${body}`.length;
}

export function createSharedSkillReader(options: SharedSkillReaderOptions): SharedSkillReader {
  const logger = options.logger ?? createSilentLogger();
  const { root } = options;

  return request => {
    const { channel, entries, maxSkills, maxChars } = request;

    const wanted = entries.filter(entry => entry.load === "always").slice(0, maxSkills);
    if (wanted.length === 0) return [];

    if (root === null) {
      logger.log("warn", {
        event: "shared_skills_unavailable",
        channel,
        reason: "shared_skills_root_unset"
      });
      return [];
    }

    // Opened per task rather than once at startup, which is `SkillFilesOpener`'s
    // shape and buys the same thing: an operator who publishes a skill, or fixes
    // a mount, does not have to restart the process for the next task to see it.
    // It is an `existsSync` and a closure.
    const files = openSharedSkillFiles({ root, logger });
    if (files === null) {
      logger.log("warn", {
        event: "shared_skills_unavailable",
        channel,
        reason: "shared_skills_root_missing",
        file: root
      });
      return [];
    }

    const loaded: LoadedSkill[] = [];
    let chars = 0;

    for (const entry of wanted) {
      const ref = sharedSkillRef(entry.name);
      // Read by the bare name, because that is the filename. The file layer has
      // already logged an unparseable or misnamed file; what is left to say here
      // is that a name this channel's sheet asked for did not resolve.
      const skill = files.read(entry.name);
      if (skill === null) {
        logger.log("warn", { event: "shared_skill_missing", channel, file: ref });
        continue;
      }

      const weight = weigh(ref, skill.body.trim());
      if (chars + weight > maxChars) {
        // Dropped whole, and the log names it. Not a `break`: the entries are in
        // the sheet's order rather than in size order, so a later one may still
        // fit — and stopping at the first that does not would make which skills
        // load depend on where an operator put a long one in the file.
        logger.log("warn", { event: "shared_skill_oversize", channel, file: ref });
        continue;
      }

      chars += weight;
      loaded.push({ name: ref, description: skill.frontmatter.description, body: skill.body });
      // One line per skill, which is `recall_hit`'s shape and its reason: this is
      // the answer to "what is this channel standing on", and a count alone does
      // not give the names.
      logger.log("info", { event: "shared_skill_loaded", channel, file: ref });
    }

    return loaded;
  };
}

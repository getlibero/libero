// The operator's shared skill root, as this suite has one (#437).
//
// The third root (#433) is the one directory in the deployment that is **the
// operator's rather than either service's**: bind-mounted `:ro` into the agent
// side, holding text an operator published through git, named per channel by
// `[[shared_skill]]` entries on a team sheet.
//
// ## Off unless a case asks, and here that is not tidiness
//
// `RigOptions.sharedSkills` absent means `AGENT_SHARED_SKILLS_ROOT` is unset,
// exactly as `runner`, `ambient` and `passes` are absent. That is what keeps
// every other file in this suite unchanged: a rig that quietly acquired a root
// would give every channel whose sheet named a skill a standing region in its
// system prompt, and every case that counts a task's tokens or reads its opening
// context would start answering a question nobody asked it.
//
// ## Why the writer is here rather than in a case
//
// A shared skill arrives from **outside every process this suite runs**. It is
// not authored by a model, not written through `SkillFiles.apply`, and not
// reachable by any verb the agent side has. So the rig writes it the way an
// operator's git checkout would — bytes into a directory — and the fact that
// nothing else can is the claim `shared-skill-poisoning.test.ts` makes with
// `fingerprint`.
//
// **`fingerprint` hashes contents, not names.** The claim is that the agent side
// never writes here, and a `readdir` would miss a rewrite in place: `setStatus`
// rewrites the frontmatter of a file that already exists and changes no name.
// Content is what has to be identical, so content is what is hashed.

import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** One skill an operator published, as its file's fields and its body. */
export interface SharedSkillFile {
  readonly name: string;
  /** The line retrieval matches against. Worded to reach the question a case asks. */
  readonly description: string;
  readonly body: string;
  /** The frontmatter's own status. `active` unless a case is about another. */
  readonly status?: "active" | "stale" | "archived";
}

export interface SharedSkillRoot {
  /** `AGENT_SHARED_SKILLS_ROOT`, as the agent side is given it. */
  readonly path: string;
  /** Publishes one skill, the way an operator's checkout does: bytes in a directory. */
  publish(skill: SharedSkillFile): void;
  /**
   * A hash of every file in the root, by name and content.
   *
   * What "the agent side wrote nothing here" is asserted with. Taken before and
   * after the writes a case provokes; equal digests are the claim.
   */
  fingerprint(): string;
}

/** Serializes one skill to the file format `packages/schema`'s grammar defines. */
function fileFor(skill: SharedSkillFile): string {
  return [
    "---",
    `name: ${skill.name}`,
    `description: ${skill.description}`,
    "created: 2026-08-01",
    `status: ${skill.status ?? "active"}`,
    "---",
    "",
    skill.body,
    ""
  ].join("\n");
}

export function sharedSkillRoot(skills: readonly SharedSkillFile[]): SharedSkillRoot {
  const path = mkdtempSync(join(tmpdir(), "libero-e2e-shared-"));

  const root: SharedSkillRoot = {
    path,
    publish(skill) {
      writeFileSync(join(path, `${skill.name}.md`), fileFor(skill), "utf8");
    },
    fingerprint() {
      const hash = createHash("sha256");
      // Sorted, so the digest is a fact about the contents rather than about the
      // order the filesystem happened to answer in.
      for (const entry of readdirSync(path).sort()) {
        hash.update(entry, "utf8");
        hash.update(" ", "utf8");
        hash.update(readFileSync(join(path, entry)));
        hash.update(" ", "utf8");
      }
      return hash.digest("hex");
    }
  };

  for (const skill of skills) root.publish(skill);
  return root;
}

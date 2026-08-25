// The operator's way to empty a channel's own skill index (#452).
//
// `apps/server`'s third operator entrypoint, beside `./tasks-cli.ts` and
// `./rebuild-cli.ts`, and for their reason: `store.db` lives in a named volume
// the host cannot open, so this is not the published `libero` CLI's — #98's rule
// that the CLI owns what an operator authors and a service's entrypoints own
// what it holds. Not the proxy's either, because the proxy mounts that volume
// `readOnly` by design and this deletes.
//
//   docker compose run --rm server node dist/skill-purge.js C024BE91L --yes
//
// ## What it is for, which is a cost #436 recorded rather than fixed
//
// `searchSkills` and `nearest` are origin-blind on purpose: a `retrieved` shared
// skill has to be a candidate in both legs like any other. Each applies its own
// limit before `./session/skill-recall.ts` sees a row.
//
// So a channel that once had skills and has since set `[skills] enabled = false`
// keeps its channel-authored rows, and those rows still spend those limits. They
// can crowd a shared skill out of both rank lists before the membership filter
// ever sees them. That filter stops such a row taking one of `top_k`'s slots or
// resolving as `unresolved`; it cannot un-spend a limit spent upstream.
//
// The rows are unreachable in every other sense. With the switch off there is no
// opener for them, so they never resolve, never embed and never age — the
// lifecycle clocks are scoped `origin = 'channel'` but gated on the same switch.
// They are dead weight that degrades retrieval for the shared skills the sheet
// *did* name.
//
// ## Why the switch does not do this by itself
//
// It nearly could, and it must not. `DEFAULT_SKILL_SETTINGS` falls back to
// `enabled: false` for a sheet that **would not parse** — the direction that
// header argues is the right one to fail in — so an automatic purge on the
// switch would let one typo in a `channel.toml` destroy that channel's
// `skill_use` counters and `first_seen_at` clocks on the next mention. State
// deletion triggered by a config flip is the wrong default.
//
// State deletion an operator asked for is not, and until this command there was
// no way to ask. That is the whole of why this exists: the same act, moved from
// something that happens to a channel to something a person does to it.
//
// ## What it deletes, and the three things it does not
//
// It empties the **channel half** of one channel's skill index. The rows go, and
// the `skill_delete` trigger takes each one's vector and its `skill_use` row with
// it — which is the loss worth naming out loud, because `uses`, `last_used_at`
// and `first_seen_at` are the only record of a playbook's history and nothing
// re-derives them. `--yes` is what makes that a decision rather than a surprise.
//
// It does **not** touch:
//
//   - **`skills/` on disk.** The files are the team's. What this drops is the
//     index built over them, and `reconcileSkillIndex` rebuilds it from those
//     files the moment the switch goes back on — minus the clocks, which is the
//     cost the preview states.
//   - **The shared half.** `reconcileSkills` deletes by origin, so `shared/*`
//     rows are outside the statement rather than filtered out of it. That half is
//     `reconcileSharedSkillIndex`'s and is already exactly what the sheet and the
//     root say.
//   - **Anything in another channel.** One file is one channel, which is
//     `packages/memory`'s isolation boundary rather than a check here.
//
// ## No new writer in packages/memory, deliberately
//
// The purge is `reconcileSkills({ present: [], changed: [], origin: "channel" })`
// — the delete pass that module already has, told the directory holds nothing of
// this origin. That is exactly the state it is asked to reconcile to when a team
// deletes their `skills/` directory, so there is nothing here it has not always
// done.
//
// A `purgeSkills` beside it would be a second way to delete a skill row, in a
// package whose one rule about the skill tables is that `reconcileSkills` is
// their only writer. What this command supplies is the *decision*, and a decision
// is not a storage primitive.
//
// Everything is injected — argv, env, both writers, the opener and the clock — so
// the behaviour is testable without a process. ./skill-purge.ts is the handful of
// lines that supply the real ones.

import { openMessageStore } from "@getlibero/memory";
import type { MessageStore } from "@getlibero/memory";
import { ChannelId } from "@getlibero/schema";
import { storeRootFromEnv } from "./env.js";
import type { Env } from "./env.js";

/** 0 ok, 1 an operator error, 2 a usage error. `./rebuild-cli.ts`'s set. */
export const EXIT_OK = 0;
export const EXIT_ERROR = 1;
export const EXIT_USAGE = 2;

const USAGE = [
  "usage: skill-purge <channel> [--yes]",
  "",
  "Empties the channel half of one channel's skill index. The rows go, and each",
  "one's vector and its use counters go with it — uses, last-used and first-seen",
  "are the only record of a playbook's history and nothing re-derives them.",
  "",
  "Without --yes it says what would go and deletes nothing.",
  "",
  "Leaves the channel's skills/ directory alone: the files are the team's, and",
  "the index is rebuilt from them the next time a task runs with [skills]",
  "enabled. Leaves shared skills alone — that half is the sheet's.",
  "",
  "Reads AGENT_STORE_ROOT. Costs nothing and calls no model."
].join("\n");

export interface SkillPurgeCliIo {
  argv: readonly string[];
  env: Env;
  out: (line: string) => void;
  err: (line: string) => void;
  /** Injected so a test drives a store it built. Defaults to the real opener. */
  open?: (channel: string, root: string) => MessageStore;
  /** Injected so a test states the clock rather than reading one. */
  now?: () => number;
}

/** A date an operator reads, from a stamp the index keeps in milliseconds. */
function on(at: number): string {
  return new Date(at).toISOString().slice(0, 10);
}

export function runSkillPurgeCommand(io: SkillPurgeCliIo): number {
  const args = [...io.argv];
  // Pulled out before the positional, so `--yes` may sit on either side of the
  // channel id — an operator retrying with it appends it, and a command that
  // then called the channel id an argument error would be a poor answer.
  const confirmedAt = args.indexOf("--yes");
  const confirmed = confirmedAt !== -1;
  if (confirmed) args.splice(confirmedAt, 1);

  const [channel, ...rest] = args;
  if (channel === undefined || rest.length > 0) {
    io.err(USAGE);
    return EXIT_USAGE;
  }

  // ./rebuild-cli.ts's check and its reason: the id becomes a path segment, and
  // this one comes off a command line.
  if (!ChannelId.safeParse(channel).success) {
    io.err(`skill-purge: ${JSON.stringify(channel)} is not a valid channel id`);
    return EXIT_USAGE;
  }

  let root: string;
  try {
    root = storeRootFromEnv(io.env);
  } catch (error) {
    io.err(
      `skill-purge: ${error instanceof Error ? error.message : "AGENT_STORE_ROOT is not set"}`
    );
    return EXIT_ERROR;
  }

  let store: MessageStore;
  try {
    store = (io.open ?? ((name, at) => openMessageStore({ channel: name, root: at })))(
      channel,
      root
    );
  } catch (error) {
    // ./rebuild-cli.ts's wording: "no such channel" and "nothing to do" are
    // different answers and an empty one would blur them.
    io.err(`skill-purge: no store for ${channel} (${error instanceof Error ? error.name : "unknown"})`);
    return EXIT_ERROR;
  }

  try {
    // Scoped to `origin = 'channel'` by the query itself, so the shared half is
    // outside this listing rather than filtered out of it.
    const clocks = store.skillClocks();

    if (clocks.length === 0) {
      io.out(`${channel} has no skills of its own in the index. Nothing to purge.`);
      return EXIT_OK;
    }

    const used = clocks.filter(clock => clock.lastUsedAt !== null).length;
    const oldest = Math.min(...clocks.map(clock => clock.firstSeenAt));
    const plural = clocks.length === 1 ? "skill" : "skills";

    io.out(`${channel}: ${String(clocks.length)} ${plural} in the index, first seen ${on(oldest)}.`);
    // Spelled rather than templated, because an operator reads this once and a
    // count that disagrees with its own verb reads as a bug in the thing about
    // to delete their data.
    const loaded =
      used === 0 ? "None have" : used === 1 ? "One has" : `${String(used)} have`;
    io.out(`${loaded} been loaded by a task. Their use counts, last-used and first-seen`);
    io.out("stamps go with the rows and nothing re-derives them.");
    io.out("The files in skills/ are untouched, and shared skills are untouched.");

    if (!confirmed) {
      io.out("");
      io.out("Nothing was deleted. Run again with --yes to purge.");
      return EXIT_OK;
    }

    const at = (io.now ?? Date.now)();
    // The delete pass `packages/memory` already has, told this origin's directory
    // holds nothing — see the header on why there is no second writer.
    const result = store.reconcileSkills({ present: [], changed: [], origin: "channel" }, at);

    io.out("");
    io.out(
      `Purged ${String(result.dropped)} ${result.dropped === 1 ? "row" : "rows"} from ${channel}.`
    );
    io.out("The index rebuilds from skills/ the next time a task runs with [skills] enabled.");
    return EXIT_OK;
  } catch (error) {
    io.err(`skill-purge: ${error instanceof Error ? error.message : "the purge failed"}`);
    return EXIT_ERROR;
  } finally {
    store.close();
  }
}

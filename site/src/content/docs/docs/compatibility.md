---
title: What 1.0 freezes
description: The seven surfaces a self-hoster may build on across 1.x, each marked frozen or explicitly not, with the reason. A surface marked "not frozen" is as useful as one marked frozen.
---

The roadmap says 1.0 "hardens every one of those one-way doors". This page is
that sentence as a list.

For each surface below: **frozen** at 1.0, or **not frozen**, with the reason. A
surface marked not frozen is as useful to you as one marked frozen, because it
tells you what not to build on.

## The seven, at a glance

| Surface | 1.0 |
| --- | --- |
| [The team sheet](#the-team-sheet--frozen) — `channel.toml`'s fields, bounds and defaults | **frozen** |
| [The skill file grammar](#the-skill-file-grammar--frozen) — frontmatter, name alphabet, identity rule | **frozen** |
| [The environment contract](#the-environment-contract--frozen) — every `AGENT_*`, `PROXY_*`, `RUNNER_*` | **frozen** |
| [The audit record](#the-audit-record--frozen) — the CSV header, the row shape, the exit codes | **frozen** |
| [The on-disk stores](#the-on-disk-stores--frozen-and-the-migration-rules-differ-per-store) — what an upgrade may migrate | **frozen**, per store |
| [The operator entrypoints and the CLI](#the-operator-entrypoints-and-the-cli--frozen) — commands, flags, exit codes | **frozen** |
| [The wire between the services](#the-wire-between-the-two-services--not-frozen-and-not-meant-to-be) — mTLS, `/v1/` | **not frozen** |

## What frozen means here

A frozen surface does not change in a way that breaks a working deployment for
the life of 1.x. Concretely, across a minor or patch release:

- a field, variable, command, flag or exit code is **not removed**, and does not
  change meaning
- a default does **not** move, because a sheet that never mentioned a field
  would start behaving differently with nothing in its own file changed
- a bound is **not tightened**, because a file that parses today must parse
  tomorrow

Additions are not breaks. A new optional field, a new variable with a default, a
new subcommand or a new exit code may arrive in a minor release. Loosening a
bound is an addition in this sense; tightening one is not.

This is a statement about compatibility, not about semantics. `RELEASING.md` in
the repository holds the version policy itself, which is a paragraph rather than
a page.

## What this page is not

It is not a migration guide, and it changes nothing. Where writing it turned up
a surface that looks wrong, that is its own issue and this page records the
surface as it is rather than as it should be.

## The team sheet — **frozen**

`channel.toml` is the surface an operator's own repository holds under version
control, and it is the one the changelog already calls out loudest. Eleven
blocks: `[channel]`, `[llm]`, `[budget]`, `[memory]`, `[skills]`,
`[[shared_skill]]`, `[[mcp_server]]` with its `[[mcp_server.tool]]` children,
`[[builtin]]`, `[egress]`, `[ambient]`, and `[[ambient.rule]]`.

Frozen across 1.x: every field's **name**, its **type**, its **default**, and
its **bounds**. `packages/schema/src/team-sheet.ts` already argues why each of
those is a one-way door, and the argument it makes for `[skills]` is the general
case — flipping a cap looser later "is `enabled`'s hazard in reverse and worse:
a sheet that never mentioned them would start paying more on every turn of every
task with nothing in its own file changed."

**Nothing in the sheet is marked provisional today**, and that is a decision this
page makes rather than one it inherits: there is no field carrying a "may
change" note in the schema, so freezing the block list means freezing all of it.
A field added in a 1.x minor is optional with a default, which is what makes it
an addition rather than a break.

The figures themselves — which bound is what number — are on the
[Limits](/docs/limits/) page, and the ones an operator may move are there too.
**A limit being deployment-configurable does not unfreeze it**: the variable's
name, its default and its meaning are frozen exactly as a sheet field is.

## The skill file grammar — **frozen**

`skills/<name>.md` in a channel's state root, and `<name>/SKILL.md` in the
operator's shared root, are files your repository holds and your team edits. The
grammar is therefore a compatibility surface rather than an implementation
detail, and `libero skill vendor` writes into it.

Frozen: the fence, the field vocabulary, the name alphabet, and the identity
rule.

- **`---`-fenced, `key: value`, one per line, then a markdown body.** Not YAML
  and deliberately so — YAML's implicit typing reads `description: no` as
  `false` and `created: 2026-09-07` as a date in whatever zone the runtime
  prefers. A value is the rest of its line, trimmed, with one matching pair of
  surrounding quotes removed. No escaping, no folded or literal scalars, no
  comments, and no format imposed on the body.
- **The fields**: `name`, `description` (1–512 characters), `created`
  (`YYYY-MM-DD`, a date that exists), `status` — one of `active`, `stale`,
  `archived`, defaulting to `active` — and `metadata`, a block of indented
  `key: value` lines read as a string→string map.
- **`created` is required of a channel's own skill and optional on a shared
  one.** The store stamps one on every skill a model creates, so a channel file
  without one is damaged; the Agent Skills spec does not define the key, so a
  skill you vendored simply has not got one. Nothing decides anything by it
  either way — the index stamps its own `first_seen_at`.
- **`name` is lowercase words joined by single dashes**, letters and digits
  only, 1–64 characters. That alphabet is load-bearing beyond tidiness: a name
  that parses is already canonical, so it is the filename stem on every
  filesystem with no slug function anywhere, and `/` being absent is what
  reserves `shared/<name>` as an address no file can collide with.
- **The filesystem name is the identity.** A `deploy.md` whose frontmatter says
  `name: rollback` is not re-keyed and not repaired; the stem wins and the file
  is left exactly as your team wrote it. On the shared root the directory's name
  is what has to agree, which is the spec's own rule.

Three properties are worth relying on because they are what make an upgrade
safe.

**An unknown frontmatter key is kept, not rejected and not dropped.** That is
the deliberate departure from every other shape parsed out of text in this
project. A `license:` or `compatibility:` line you add survives every rewrite:
the lifecycle job changing a status, and a model revising a skill's body, both
write the file back with your keys after the four it knows and your `metadata`
block last. A key given *twice* is still refused — there is no answer to which
one you meant, and silently taking the last is how a status a human set gets
dropped.

**`allowed-tools` is read and dropped.** The spec defines it; the team sheet is
the allowlist here. A second statement of permission in a file the model can
retrieve would look exactly like the one that binds, so it is not kept and not
written back.

**A file that does not parse is skipped and logged, never fatal.**
`skill_file_unusable` for one that does not parse and `skill_file_misnamed` for
one whose frontmatter names something else — two events rather than one because
the fix is different. Nothing throws, and the rest of the library still loads.

What is **not** frozen here is the body's length. The parser does not bound it
at all: `[skills] max_skill_chars` does, and that is a sheet field you set. The
4096-character figure is a bound on what the *model* may write in one operation,
not on what your team may keep in a file.

### The shared root's layout changed in v0.9.0

A shared skill is `<name>/SKILL.md` with `scripts/`, `references/` and `assets/`
beside it — the [Agent Skills](https://code.claude.com/docs/en/skills) layout —
where v0.5.0 through v0.8.0 read a flat `<name>.md`. A flat file is passed over
and logged; `libero doctor` reports one as unpublished and names the move.
A channel's own `skills/` directory is unaffected and stays flat, because a
model writes those one file at a time and has no operation that could produce a
sidecar.

This is the one part of this page that moved rather than widened, and it moved
before 1.0 on purpose: adopting the spec's layout means a skill you vendored
arrives whole instead of flattened into its body, and a wider grammar breaks no
file that parses today where a narrower one later would.

## The environment contract — **frozen**

Sixty-nine variables across the three services, and the contract is that a
deployment which sets them today keeps working: **no variable is removed, and
none changes meaning, in 1.x.** A variable may be added in a minor release, with
a default that leaves an existing deployment unchanged.

| Service | Variables | The per-variable record |
| --- | --- | --- |
| gateway + agent | 24 `AGENT_*`, `SLACK_*`, provider keys, `PROXY_URL` and its TLS material | `apps/server/README.md` |
| tool proxy | 29 `PROXY_*`, the custody backend's, and the runner client's | `apps/proxy-server/README.md` |
| sandbox runner | 16 `RUNNER_*` and `HOP_*` | `apps/runner/src/env.ts` |

The tables are not copied here on purpose. Three READMEs already carry each
variable with the argument for why it is a deployment setting rather than a
sheet field, and a fourth copy would be a fourth thing to keep in step — which
is the failure this repository has been bitten by more than once. What is frozen
is the behaviour above; where a variable *means* something is those files.

Two things inside the contract are worth stating separately, because they are
the ones a deployment is most likely to have opinions about:

- **`AGENT_STORE_ROOT` and `AGENT_CHANNELS_ROOT` are different roots, and stay
  different.** The agent must not be able to write where the proxy reads
  authorization. Since v0.5.0 `AGENT_SHARED_SKILLS_ROOT` is a third, and it is
  neither of the first two.
- **The master key arrives as exactly one of `PROXY_VAULT_KEY` or
  `PROXY_VAULT_KEY_FILE`.** "Exactly one" is the frozen part: setting both is a
  refusal, not a precedence rule.

## The audit record — **frozen**

The audit log is read by `audit verify`, by `audit csv`, and by whatever an
operator points at the CSV. Three things are frozen and they are frozen
separately.

**The CSV header row**, which the code already calls the contract: the columns,
their names, and their order. A new column is **appended to the end** even when
the table declares it in the middle, because someone's script indexes
positionally and shifting a column under them turns a correct script into a
wrong one with no error. Twenty-three columns today.

**The row shape**, which is twenty fields and an eight-value `outcome` —
`ran`, `held`, `refused`, `unavailable`, `unanswered`, `approved`, `denied`,
`expired`. A field is not removed and does not change meaning. A field may be
added, and adding a **nullable** one is safe by construction: the hash preimage
omits NULL columns, so a column added later does not change the preimage of a
row already written. Versions 6 and 7 were each exactly that, and the rows on
disk hashed to what they always had.

That is a property of nullable additions rather than of additions in general.
Version 5, which added the chain itself, is the one the code calls "the first
one that is not a widening" — it added two NOT NULL columns, so there was no
value an older row could be given, and the migration had to compute one for
every row it copied. Rows written before it are chained *as of that migration*:
vouched for from then on, and asserting nothing about what happened to them
earlier. A future non-nullable addition would owe the same kind of answer.

**The four exit codes** of `audit`: `0` ok, `1` an operator error, `2` a usage
error, and `3` for `verify` alone when the chain is broken. The fourth is the
one worth relying on, and it is deliberate — a broken chain is not an operator
error, because nothing failed and the command did exactly what it was asked.
"The audit log has been altered" and "the audit log could not be opened" want
different people.

What is **not** frozen is the hashing itself. `CHAINED_COLUMNS` fixes the
serialization order, and changing it is a chain break by construction — every
row on disk would stop verifying. That is not a compatibility promise you can
build on so much as a thing the project cannot do without a major version and a
stated migration.

## The on-disk stores — **frozen, and the migration rules differ per store**

What matters here is what an upgrade may do to a file you have backed up. The
rule is per store, and the differences are deliberate rather than accidental.

| Store | Version | What an upgrade does |
| --- | --- | --- |
| audit log | 7 | **Migrates** 1–6 in place, preserving existing row hashes. A version it does not know — including one from the future — refuses to start. |
| budget meter | 2 | **Migrates** 1 in place. Anything else refuses to start. |
| price drift | 1 | No migration path yet, deliberately. An unrecognised version refuses to start. |
| message store | 1 | **Never migrates.** A version mismatch refuses to open the file. |
| vault, tokens, signing key | envelope 1 | No migration. An unknown version byte is `unsupported_version` before the key is touched. |
| attempt store | none | Content-addressed, no version, and **deletable by design**. |

Two of those rows carry a promise worth spelling out.

**The audit migration preserves hashes rather than recomputing them.** An
operator can delete the version stamp from a file and make the next open rebuild
it; recomputing there would quietly re-bless every row, including any that had
been edited, which is exactly what the chain exists to prevent.

**The signing key is created and never replaced.** The write is an exclusive
create, and a process that loses the race adopts the key already there —
overwriting it would strand every grant bound to it. (The managed GCP backend
reaches the same guarantee differently, by stacking versions and always reading
the first, because destroying a version there would do the same damage.)

The **attempt store is the one you may delete**, and that is a supported
operation rather than a tolerated one. Removing a record degrades the audit row
it belongs to back to hash-only and `audit verify` stays green, because the
store is not chained.

## The operator entrypoints and the CLI — **frozen**

Three surfaces, and they are frozen to different depths.

**The published CLI.** `libero init`, `libero channel add|rotate|promote|pins`,
and `libero doctor`, with the flags each documents. It requires Node 24 or
newer, and enforces that rather than advising it.

**The entrypoints inside the images**, which the CLI deliberately does not wrap
because their files live in volumes the host cannot open: `node dist/<name>.js`
for `vault`, `grant`, `budget`, `audit` and `drift` on the proxy, and `tasks`,
`rebuild` and `skill-purge` on the agent.

**The exit codes, which are the machine-readable part and the part to script
against.** `0` ok, `1` an operator error, `2` a usage error, everywhere — plus
`audit verify`'s `3` for a broken chain, which the proxy's own README already
calls a contract for anything running it on a timer.

The shared dispatch rule is frozen with them, because a wrapper script depends
on it: no arguments prints usage on **stdout** and exits `2`; an explicit
`--help` prints usage on stdout and exits `0`; an unknown command goes to
**stderr** and exits `2`. Nothing emits colour, ever.

What is **not** frozen is the shape of what these print, with one exception.
`doctor`'s columns, `tasks`' tab-separated rows and `budget show`'s layout are
output for a person to read, and pinning their wording would make every
improvement a breaking change. The exception is `audit csv`, whose **header row
is the contract** and whose new columns are appended at the end, so positional
indexing keeps working.

A command or a subcommand may be added in a minor — `libero skill vendor` is
one that is coming — and an exit code may be added the way `audit`'s fourth
was. Neither removes anything you are already using.

## The wire between the two services — **not frozen, and not meant to be**

The agent reaches the proxy over mutual TLS at seven routes, six of them under
`/v1/`. That prefix is not a promise. **Running the two images at different
versions is not supported**: one `v*` tag releases the CLI and all three images
together, `deploy/docker-compose.yml` pins every image to one `LIBERO_VERSION`,
and the schema declines to carry compatibility shims for "a version skew this
deployment cannot have."

So there is no operator-facing contract here to freeze, and saying otherwise
would invite exactly the deployment the lockstep exists to prevent.

**It is not supported and it is also not prevented**, which is worth knowing
before you try it. Nothing checks a peer's version at connect time. `libero
doctor` warns — not fails — when the pinned release and the CLI disagree,
because running one release behind is a choice rather than a fault. If you point
the two services at different tags, you are on your own, and the failure will
look like a schema parse error rather than like a version check.

# Shared skills

Skills an operator publishes, read by every channel whose team sheet names one.
One directory per skill in the **Agent Skills layout** — `<name>/SKILL.md`, with
`scripts/`, `references/` and `assets/` beside it — read by the grammar
`packages/schema/src/skill.ts` defines.

```
shared-skills/
  brand-voice/
    SKILL.md
  code-review-standards/
    SKILL.md
    references/
      checklist.md
```

The directory name is the skill's name, and `SKILL.md`'s own `name:` has to
agree with it; a directory with no `SKILL.md` is passed over, and so is a flat
`<name>.md` left from the layout before v0.9.0.

A channel's own `skills/` directory stays flat `<name>.md`, because a model
writes those one file at a time and has no operation that could produce a
sidecar. The two roots differ in who writes them, and now in layout too.

`deploy/docker-compose.yml` bind-mounts this directory at
`/data/shared-skills:ro` and sets `AGENT_SHARED_SKILLS_ROOT` to it. **Read-only
is the point**: a shared skill is read by every channel that names it, so one
writable file would poison all of them at once rather than one. Nothing in
either service writes here, and the agent has no verb that could.

An empty directory is a supported deployment. Every channel's own skills work
exactly as before and the agent logs `shared_skills_unconfigured` at startup if
the root is not set at all.

## Naming one from a sheet

```toml
[[shared_skill]]
name = "brand-voice"
load = "always"                 # every task, charged against every turn

[[shared_skill]]
name = "code-review-standards"
load = "retrieved"              # joins the pool beside the channel's own skills
```

`load` has no default: an entry that does not say is a line somebody
half-wrote. `[skills] max_always_skills` and `max_always_chars` bound the
standing half. `channels/example/channel.toml` is the worked example, and the
two files here are what it names.

Shared skills are addressed as `shared/<name>` inside the runtime, which no
channel-grown name can collide with — `/` is not in a skill name. The skill is
`<name>/SKILL.md`; the qualified form is an address, never a path.

## The frontmatter

```markdown
---
name: brand-voice
description: How this company writes — for any reply or document read outside the team.
status: active
license: Apache-2.0
metadata:
  author: example-org
  version: "2.1"
---

Plain, terse, technical.
```

`name` and `description` are required. `description` is what retrieval matches
against and is capped at 512 characters; the body holds the specific strings a
lexical search is better at.

`status` is yours — `active`, `stale` or `archived` — and nothing in the runtime
writes one. `created` is optional here and absent from the two examples beside
this file, because the Agent Skills spec does not define it and nothing decides
anything by it; a channel's own skill still carries one, stamped on create.

Every other key is **kept as you wrote it**, in the order you wrote it, and a
`metadata:` block of indented `key: value` lines is read as a map. The one
exception is `allowed-tools`, which is read and then dropped: the team sheet is
the allowlist, and a second statement of permission in a file the model can
retrieve would look exactly like the one that binds.

There is no YAML parser behind this. A value is the rest of its line with one
matching pair of quotes removed; there are no folded scalars, no escapes and no
comments.

## Getting content in here

**Vendoring, not fetching.** A skill enters this directory by a host-side act
that puts it in your git repository, where an update is a reviewed diff — the
`packages/proxy/src/vendor/` pattern, a copy and not a fork. Your CI copying a
file in, pinned however you pin, is the whole of the supported path in v0.5.0;
[#439](https://github.com/getlibero/libero/issues/439) is the parked issue for a
`libero skill vendor` command that would do the copying at a pinned SHA. Since
the layout is the spec's, a `git subtree` of a skill directory needs no verb at
all.

A runtime marketplace client is declined rather than unbuilt, and
[#373](https://github.com/getlibero/libero/issues/373) says why: auto-updating
text that enters the model's context is an injection subscription. The model
gets no install verb for the same reason — a prompt-injected model importing a
skill would be injection installing persistent injection.

## What ages, and what does not

Nothing here. The lifecycle job that moves a channel's own skills to `stale` and
then `archived` never sees these, and the merge curator never proposes blending
one into a channel's. A skill here stays until you drop it from the sheet or
delete the directory. `status` in the frontmatter is yours, read like any other
field; nothing in the runtime writes one.

# Shared skills

Skills an operator publishes, read by every channel whose team sheet names one.
One `<name>.md` per skill, in the grammar `packages/schema/src/skill.ts` defines
— the same file a channel's own `skills/` directory holds, authored by a person
here rather than by a task there.

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
channel-grown name can collide with — `/` is not in a skill name. The file is
`<name>.md`; the qualified form is an address, never a filename.

## Getting content in here

**Vendoring, not fetching.** A skill enters this directory by a host-side act
that puts it in your git repository, where an update is a reviewed diff — the
`packages/proxy/src/vendor/` pattern, a copy and not a fork. Your CI copying a
file in, pinned however you pin, is the whole of the supported path in v0.5.0;
[#439](https://github.com/getlibero/libero/issues/439) is the parked issue for a
`libero skill vendor` command that would do the copying and normalize a
marketplace `SKILL.md` into this grammar.

A runtime marketplace client is declined rather than unbuilt, and
[#373](https://github.com/getlibero/libero/issues/373) says why: auto-updating
text that enters the model's context is an injection subscription. The model
gets no install verb for the same reason — a prompt-injected model importing a
skill would be injection installing persistent injection.

## What ages, and what does not

Nothing here. The lifecycle job that moves a channel's own skills to `stale` and
then `archived` never sees these, and the merge curator never proposes blending
one into a channel's. A skill here stays until you drop it from the sheet or
delete the file. `status` in the frontmatter is yours, read like any other
field; nothing in the runtime writes one.

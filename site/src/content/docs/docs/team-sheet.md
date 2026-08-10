---
title: Team sheets
description: The per-channel TOML manifest that declares which tools exist, which need a human click, what the budget is, and where traffic may go.
---

The team sheet is the admin surface: one TOML file per channel, intended to live in the operator's
own git repo.

The name is the football one. It is the sheet the manager submits before a match declaring who is
allowed on the pitch, what position they play, and what needs the gaffer's sign-off. Everything
the proxy enforces at runtime is a lookup into this file.

Nothing in a team sheet is a secret. Credentials appear as **names**, resolved only inside the
proxy's vault — never in the sheet, the logs, an error message, or anything returned to the agent.

## A documented starter

This is `channels/example/channel.toml` in the repository, kept in sync with the zod schema in
`@getlibero/schema`.

```toml
# Example team sheet — copy to channels/<CHANNEL_ID>/channel.toml

[channel]
name        = "engineering"
description = "Deploys, code review, incident response."

# Hard caps on a single task, how much of the channel's conversation it starts
# with, and how long a thread it has worked in goes on answering without a
# mention. The proxy's daily meter below is the authoritative spend limit; the
# caps stop one task running away, the two history bounds decide what a task
# costs before the model has done anything, and the follow-up window decides
# how many tasks a thread can start without anyone addressing the app again.
[llm]
model                    = "claude-sonnet-4-6"   # per-channel override
max_tool_calls_per_task  = 25
max_task_seconds         = 300                   # wall time, seconds
max_tokens_per_task      = 60000
max_tokens_per_turn      = 8192                  # ceiling on one turn's output
max_history_messages     = 40                    # recent messages in the prompt; 0 for none
max_history_chars        = 12000                 # and the character budget they share
max_result_chars         = 32768                 # one tool answer's ceiling; past it the result
                                                 # is truncated and says so. How many bytes the
                                                 # proxy will read off an upstream at all is
                                                 # PROXY_MAX_RESPONSE_BYTES, a deployment
                                                 # setting: that heap is shared by every channel.
follow_up_window_seconds = 900                   # replies in a worked thread need no re-mention; 0 for off

[budget]
daily_tokens     = 2_000_000
daily_tool_calls = 400
cache_read_weight  = 0.1                    # what a cached token costs
cache_write_weight = 1.25

[[mcp_server]]
name       = "github"
transport  = "http"
url        = "http://mcp-github:3001/mcp"
credential = "github_service_account"       # name only; value lives in the vault

  # Tools not listed here do not exist as far as this channel is concerned.
  [[mcp_server.tool]]
  name             = "list_prs"
  max_result_chars = 8000                   # this one lists; a channel-wide 32k is more
                                            # context than a PR list is worth. Overrides
                                            # [llm] max_result_chars for this tool alone.

  [[mcp_server.tool]]
  name     = "trigger_workflow"
  approval = "required"                     # held for a human Approve click

[egress]
allow = ["api.github.com", "*.internal.example.com"]

[ambient]
enabled  = false                            # off by default, always
schedule = "0 9 * * 1-5"
```

## What each block does

### `[channel]`

Identity and a description. The description is part of the agent's context, so it is worth
writing: it is how the model knows what kind of channel it is in.

### `[llm]`

The per-channel model override and the four hard caps on a single task: tool calls, wall time,
total tokens, and one turn's output. The agent loop enforces them, and a task that hits one stops
and says which. They bound a single runaway task — the per-day spend limit is `[budget]` below,
metered in the proxy. Every cap has a default, so a channel with no `[llm]` block is still capped.

`max_history_messages` and `max_history_chars` are a different kind of setting, and the difference
is worth knowing. A cap stops a task that is already running; these two decide how much of the
channel's recent conversation the task *starts* with — the transcript the model reads before it
does anything, with each message attributed to its author. Every character of it is charged against
`max_tokens_per_task`, so raising them buys context and spends budget, and `0` is a real answer:
a channel that sets it sends the model the question and nothing around it.

The message count is capped at 200, which is the most one read of a channel's store returns.
Whichever bound is reached first wins, the oldest messages are dropped first, and a single message
is truncated at 2,000 characters so one wall of text cannot consume the whole budget — that last
number is the agent's rather than yours, for the same reason its network timeouts are.

A question asked inside a thread is answered from that thread rather than from the channel around
it. A question that starts one has no thread to read, so it sees the channel instead.

`max_result_chars` bounds the other direction: how much of a single tool's answer reaches the
model. A tool that lists files, reads a log, or returns a long diff can hand back more in one call
than the whole conversation cost, and every character of it is charged against
`max_tokens_per_task`. Past the bound the result is cut and carries a line saying so —
`[result truncated: 32768 of 412903 characters]` — so the model knows it is working from part of an
answer rather than assuming it has all of one. It is per channel and can be overridden per tool;
see `[[mcp_server.tool]]` below.

There is a second bound underneath it that is **not** yours to set. Before any of this, the proxy
decides how many bytes it will read off an upstream at all — `PROXY_MAX_RESPONSE_BYTES`, four
megabytes by default, set by whoever deployed the proxy. A response past it is abandoned mid-read
and the call fails; the model is told the answer was too large rather than shown part of it. The
split is deliberate: `max_result_chars` spends your channel's token budget, so it is yours, while
the wire bound spends memory in a process every channel shares, so it belongs to the operator who
sized that process. If tool answers are being refused rather than truncated, that is the number to
raise, and it is not in this file.

`follow_up_window_seconds` is a third kind of setting again: it decides whether there is a *next*
task at all. After the agent has worked in a thread, a reply in that thread reaches it with no
mention, for this long after the last answer — the clock restarts each time, so a conversation that
keeps going keeps going. Everywhere else in the channel still needs a mention; this does not make
the agent answer the channel. `0` switches it off, which is a channel saying the agent speaks only
when addressed. It is capped at 1800 seconds: the agent forgets a channel's threads 30 minutes
after its last task there, so a longer window is one it could not keep.

A follow-up is an ordinary task. It runs on this channel's model, these caps, and this channel's
daily budget, and every tool call it makes is enforced by the proxy exactly as a mention's is.

Libero is model-agnostic — Anthropic is supported natively; OpenAI, Groq, Ollama, and Gemini
work through their OpenAI-compatible endpoints, and the optional LiteLLM sidecar covers everything
else behind one.

### `[budget]`

Tokens and tool calls, per channel per day, metered in the proxy. The agent loop applies its own
caps, but this is the authoritative meter. A hard limit stops the loop until an admin resets it or
the day rolls over. The day is the UTC calendar day, and rollover is a property of the clock rather
than of the process: a proxy restarted at noon reads the same counters it wrote at eleven, and a
new day reads as zero because it is a key nothing has written yet. Yesterday's counters stay where
they are.

**The two limits are not equally strong, and the difference is worth knowing before you rely on
one.**

`daily_tool_calls` is counted by the proxy from calls it serves. It needs nobody's cooperation and
it holds even under full compromise of the agent process — a loop that ignores its own caps, or a
process rewritten by an attacker, still cannot get a call served past this number.

`daily_tokens` is counted from what the agent reports to the proxy after each turn. That is not
the same as trusting the model: the numbers are parsed out of the provider's HTTP response
envelope, and a prompt-injected model emits text, which has no reach into the envelope its own
tokens are counted in. So it holds against the documented threat. It does **not** hold under full
compromise of the agent process, which the [security model](/docs/security/) already states as an
assumption — and that scenario yields the union of that agent's channel tool surfaces, which is a
larger problem than an under-reported token count. The limit is worth having because it catches
what actually costs money: a runaway loop, a retry storm, an expensive model swapped into a sheet.

`cache_read_weight` and `cache_write_weight` decide what a cached token costs against
`daily_tokens`. Cache reads and cache writes bill differently from ordinary input tokens, and by
how much is your provider's decision — so these are settings rather than constants. The defaults
are Anthropic's ratios. A channel pins its provider by pinning `[llm] model`, which is what makes a
per-channel weight a per-provider weight; set `cache_read_weight = 0` to stop counting cache reads
against the budget at all.

The meter stores the four raw counts — input, output, cache read, cache write — and the weights are
applied when a call is decided. So changing a weight re-prices spend already recorded today, on the
channel's next call, rather than only what comes after the edit.

The limit is enforced within a small overshoot: the proxy reads the counters, decides, and then
records, so calls in flight at the same moment for one channel can each be admitted against the
same reading. A task's loop is sequential, so that is bounded by how many tasks a channel is
running at once — and the property that matters survives it, because a runaway loop overshoots once
and is then refused for the rest of the day. Token counts lag further by construction, since a
turn's tokens are reported after the calls they paid for.

**Resetting a channel.** The reset is an operator command against the proxy's own data, not a route
on the proxy — a state-clearing verb on the listener the agent talks to would let a compromised
agent clear its own hard limit, which is the one property `daily_tool_calls` is worth having for.
It takes effect on the next call, with no restart:

```bash
docker compose run --rm proxy node dist/budget.js reset C024BE91L
docker compose run --rm proxy node dist/budget.js show  C024BE91L
```

(Until the images build — see [self-hosting](/docs/self-hosting) — run the same entrypoint
directly: `pnpm budget` in `apps/proxy-server`.)

A soft limit that warns in-thread before the hard one bites is on the roadmap and is not built:
today the hard limit is the only one, and it refuses rather than warns.

### `[[mcp_server]]`

One block per MCP server this channel may reach. `credential` is a name; the proxy resolves it
against the vault and injects it into the outbound call. The agent never receives the value and
never learns it exists beyond the name.

`transport` decides whether `url` is permitted. `transport = "http"` requires one — an HTTP
upstream with no address cannot be called. `transport = "stdio"` rejects one, because a stdio
upstream is a process rather than an address, and a field that is silently ignored is a field an
operator writes and then trusts. Either mistake is rejected at load, naming the block and the
field, rather than surfacing as a failed call later.

Server, tool, and credential names are short identifiers: letters, digits, dot, dash, and
underscore, starting with a letter or digit, up to 64 characters. The same shape applies wherever
a name crosses between the agent and the proxy, so a name that validates in a sheet is a name that
survives a call and a refusal.

Two blocks may share a name — splitting a long tool list across blocks is fine — as long as every
block carrying a given tool agrees on the upstream. If they point at different upstreams, a call
to that tool is refused as `server_ambiguous`: a sheet whose blocks contradict each other is a
structural fault for an admin to resolve, not something the proxy guesses its way past. The
refusal comes before the budget and before approval, so no human is ever asked to approve a call
that has nowhere to go.

### `[[mcp_server.tool]]`

The allowlist. **A tool that is not listed does not exist as far as this channel is concerned** —
it is not in the tool definitions the agent fetches at session start, and a call to it is refused
in the proxy regardless.

`approval = "required"` holds the call and renders an Approve once / Deny card in the
thread. Approvals are per-call, recorded with the approver's Slack user id, and expire after 15
minutes by default. Destructive verbs — delete, drop, transfer, deploy — default to
approval-required unless the sheet explicitly opts out.

The verb check is a plain substring match on the tool's name, and it errs towards holding calls it
did not need to. A tool named `get_dropdown_options` contains "drop" and will ask for approval
until you add `approval = "none"` to its entry. That is the intended direction: an unnecessary
approval costs one click and one line, and the alternative errs towards running a destructive call
nobody reviewed. An explicit `approval` in the sheet always wins — the heuristic is only consulted
when the entry says nothing.

`max_result_chars` on an entry overrides `[llm] max_result_chars` for that tool alone, in either
direction. A tool that returns file listings usually wants less than the channel's default; one
that returns diffs may want more. Most entries should name nothing and take the channel's number.

Names are matched exactly. `GitHub` is not `github`, and a tool listed as `List_PRs` will not match
a call to `list_prs` — the call is refused as an unlisted tool. If a tool you allowlisted is being
refused, check the spelling before anything else. If the same tool appears twice they are resolved
the same way in both fields: the stricter approval applies, and the smaller result bound applies.

### `[egress]`

Where traffic may go when the sheet does not already say. The code-execution sandbox has no
network at all unless this list grants it, and anything later that takes a URL as an argument
answers to the same list.

**A server's own `url` does not go here.** Declaring it under `[[mcp_server]]` is what authorizes
it — that block also carries the tool allowlist and the credential name, so the destination has
already been stated by an admin, and restating it would add a second place to get it wrong.

The two are separate on purpose. Listing `api.github.com` here so a GitHub MCP server can be
reached would also let sandboxed code call the GitHub API directly, around the tool allowlist that
is the whole reason for going through an MCP server. Listing the MCP server's own host would let
sandboxed code dial the server. A channel can reach the GitHub MCP server without its sandbox
reaching GitHub.

Default deny: a channel with no `[egress]` block reaches nothing. An entry is a host, optionally
prefixed with `*.` — `api.github.com`, or `*.internal.example.com`. The wildcard stands for one or
more subdomain labels and nothing else: `*.internal.example.com` matches
`build.internal.example.com` and `a.b.internal.example.com`, and does **not** match
`internal.example.com` itself, `evil-internal.example.com`, or
`internal.example.com.attacker.com`. There is no allow-all pattern; a bare `*` is rejected when
the sheet loads, along with a wildcard anywhere but the leftmost label.

Redirects are not followed. An upstream answering `302` would send the proxy to a host no sheet
named, so the call fails instead.

### `[ambient]`

Proactive posting. Disabled by default, always, and metered by the same budget as everything else.

## How changes are applied

Team sheets are watched and validated against the schema on file change. An invalid sheet is
rejected loudly and **the previous valid version stays active** — a typo cannot silently widen or
disable enforcement.

Deleting a sheet is the exception, and the difference is deliberate. A typo leaves your intent
unknown, so the last good sheet keeps running. Removing the file states your intent plainly, and
removing a channel's sheet is how a channel is revoked — so it takes effect immediately rather
than leaving the old permissions in force. A channel with no sheet is refused every call, and that
refusal is distinct from the one a channel gets when its sheet exists but has never been readable:
the same denial, but different mistakes, and you should not go looking for a typo in a file that
was never there.

A sheet added while the services are running is picked up on first use. Provisioning a channel does
not need a restart.

Because the sheets are files in your git repo, the review trail for "who allowed the agent to
deploy" is your normal pull request history. That is deliberate: a web admin UI is an explicit
non-goal for v1, and the files *are* the admin UI.

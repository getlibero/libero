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
#
# The team sheet is the admin surface: the sheet the manager submits before a
# match declaring who is allowed on the pitch, what position they play, and
# what needs the gaffer's sign-off. Keep these files in your own git repo.
#
# Nothing in this file is a secret. Credentials are NAMES, resolved only
# inside the proxy's vault. Invalid sheets are rejected loudly and the
# previous valid version stays active.

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

# The daily meter, per channel, in the proxy. The two limits are not equally
# strong: daily_tool_calls is counted by the proxy from calls it serves, so it
# holds even if the agent process is fully compromised; daily_tokens is counted
# from what the agent reports, which a prompt-injected model cannot forge but a
# compromised agent process could. Both roll over at UTC midnight.
[budget]
daily_tokens     = 2_000_000
daily_tool_calls = 400

# What a cached token costs against daily_tokens. Cache reads and cache writes
# bill differently from ordinary input tokens; how differently is your
# provider's decision. These are Anthropic's ratios. Set cache_read_weight = 0
# to stop counting cache reads at all.
cache_read_weight  = 0.1
cache_write_weight = 1.25

# How far into either budget this channel gets before it is told once, in the
# thread, that it is close. The call carrying the notice still runs. Set to 0
# for no warning.
warn_at = 0.8

# GitHub's hosted MCP server. The url is the server's single MCP endpoint, path
# and all — and for this server the path is also the only configuration Libero
# can reach: /x/<toolset> picks the toolset and a trailing /readonly drops every
# write tool. The alternative is a set of X-MCP-* request headers, and a team
# sheet has no field for those on purpose. Redirects are not followed, so get
# the url exactly right. See the docs: /docs/github/
[[mcp_server]]
name       = "github"
transport  = "http"
url        = "https://api.githubcopilot.com/mcp/x/pull_requests"
credential = "github_service_account"       # name only; value lives in the vault

  # Tools not listed here do not exist as far as this channel is concerned.
  [[mcp_server.tool]]
  name             = "list_pull_requests"
  approval         = "none"
  max_result_chars = 8000                   # this one lists; a channel-wide 32k is more
                                            # context than a PR list is worth. Overrides
                                            # [llm] max_result_chars for this tool alone.

  [[mcp_server.tool]]
  name     = "pull_request_read"
  approval = "none"

  [[mcp_server.tool]]
  name     = "merge_pull_request"
  approval = "required"                     # held for a human Approve click.
                                            # Written out because the heuristic
                                            # would NOT hold this one: it looks
                                            # for delete/drop/transfer/deploy in
                                            # the name, and "merge" is none of
                                            # them. Same for push_files,
                                            # create_or_update_file, issue_write.

# A second toolset is a second block, because GitHub's scoping is the url. Two
# blocks may also share a name — that is how a long tool list gets split — as
# long as every block carrying a given tool agrees on the upstream. These do not
# share one, so nothing here has to agree with anything above.
[[mcp_server]]
name       = "github_repos"
transport  = "http"
url        = "https://api.githubcopilot.com/mcp/x/repos"
credential = "github_service_account"       # one credential, however many blocks

  [[mcp_server.tool]]
  name     = "get_file_contents"
  approval = "none"

  [[mcp_server.tool]]
  name = "delete_file"                      # no approval line at all: "delete"
                                            # is a destructive verb, so the
                                            # heuristic holds this one for a
                                            # click without being told to.

# Tools the proxy implements itself rather than dialling an upstream for. One
# provider — the proxy — so the block is flat: no url and no credential, because
# there is nothing to address and nothing to authenticate to.
#
# A built-in is not a bypass. Listed here it is refused when the sheet omits it,
# held when this block asks for a click, charged to the daily meter above, and
# written to the audit log, exactly as an [[mcp_server.tool]] is. Delete the
# block and the channel does not get the tool.
#
# "libero" is the server name these travel under, and it is reserved: an
# [[mcp_server]] claiming it is a parse error rather than a channel whose
# search_channel_history quietly left the process.
[[builtin]]
name             = "search_channel_history"   # this channel's own messages, full-text.
                                              # The channel comes from the client
                                              # certificate, so no argument can name
                                              # another one.
approval         = "none"
max_result_chars = 8000                       # whole messages come back; a channel-wide
                                              # 32k is a lot of other people's
                                              # conversation to put in front of the
                                              # model at once.

# Where traffic may go when this sheet does not already say. The MCP servers
# above are NOT listed here: declaring a url in [[mcp_server]] is what
# authorizes it. This list is for the destinations nothing pinned — the
# code-execution sandbox today. Keeping them apart is why allowing the GitHub
# MCP server (api.githubcopilot.com) does not also let sandboxed code call
# api.github.com directly, and why allowing the API does not let it dial the
# MCP server.
#
# Default deny. "*." stands for one or more subdomain labels, so
# *.internal.example.com covers build.internal.example.com but not
# internal.example.com itself. There is no allow-all.
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

**The soft limit.** `warn_at` is how far into either budget a channel gets before it is told, once,
in the thread. The call that carries the notice still runs — only `daily_tokens` and
`daily_tool_calls` stop anything — and the message names the limit and the channel's position
against it:

> Budget: this channel has made 320 of its 400 daily tool calls. Calls run until it reaches the
> limit.

It is a fraction of the hard limits rather than a pair of soft numbers, so a sheet cannot express a
warning that fires after the refusal it exists to precede, and raising `daily_tokens` moves the
warning with it rather than leaving a stale number behind. `warn_at = 0` turns it off; anything at
or past `1` is rejected at load, naming the field.

Once per channel per day, per limit — a warning repeated on every call after the threshold is a
warning nobody reads. The two limits are two facts, so a channel told about its tokens can still be
told about its tool calls. A `budget.js reset` re-arms it along with the counters, and the day's
rollover does the same. The proxy is what decides and what remembers, so a channel cannot be warned
twice by asking twice.

The notice is addressed to the people in the channel and is never shown to the model: the remedy is
a larger number in this file, which is not something a model can reach for, and a sentence in a tool
result would be re-sent as context on every later turn of the task.

### `[[mcp_server]]`

One block per MCP server this channel may reach. `credential` is a name; the proxy resolves it
against the vault and injects it into the outbound call. The agent never receives the value and
never learns it exists beyond the name.

`transport` decides whether `url` is permitted. `transport = "http"` requires one — an HTTP
upstream with no address cannot be called. `transport = "stdio"` rejects one, because a stdio
upstream is a process rather than an address, and a field that is silently ignored is a field an
operator writes and then trusts. Either mistake is rejected at load, naming the block and the
field, rather than surfacing as a failed call later.

**The url is the whole endpoint, and there is no field for request headers.** Some servers put
configuration in both — GitHub's hosted server scopes itself by `/x/<toolset>` and `/readonly` in
the path *or* by `X-MCP-Toolsets` and `X-MCP-Readonly` headers. Only the path is reachable from a
sheet, deliberately: a headers field would be a place to write a token into the one file that is
meant to hold none, and the path is already reviewed as part of the url. Redirects are not
followed, so a url that is nearly right fails the call rather than being corrected by the
upstream. [Connecting GitHub](/docs/github/) works one through.

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

**It is a default, not a policy, and an upstream's naming decides how much of one it is.** GitHub
is the worked example: `delete_file` is caught, and `merge_pull_request`, `push_files`,
`create_or_update_file`, `issue_write` and `pull_request_review_write` are not, because none of
them contains one of the four verbs. Read the tool names you are allowlisting and write
`approval = "required"` where you mean it. The heuristic is what catches the entry you forgot to
think about; it is not a substitute for having thought about them.

`max_result_chars` on an entry overrides `[llm] max_result_chars` for that tool alone, in either
direction. A tool that returns file listings usually wants less than the channel's default; one
that returns diffs may want more. Most entries should name nothing and take the channel's number.

Names are matched exactly. `GitHub` is not `github`, and a tool listed as `List_Pull_Requests` will
not match a call to `list_pull_requests` — the call is refused as an unlisted tool. If a tool you
allowlisted is being refused, check the spelling before anything else. If the same tool appears twice they are resolved
the same way in both fields: the stricter approval applies, and the smaller result bound applies.

### `[[builtin]]`

Tools the proxy implements itself, rather than dialling an upstream for. One block per tool, flat:
there is a single provider — the proxy — so there is no server to group under, no `url` to name and
no `credential` to reference.

| Field | Required | Meaning |
| --- | --- | --- |
| `name` | yes | Which built-in. A closed set; anything else is a parse error naming the field. |
| `approval` | no | `"required"` or `"none"`, exactly as on `[[mcp_server.tool]]`. |
| `max_result_chars` | no | This tool's own ceiling, overriding `[llm] max_result_chars`. |

**A built-in is not a bypass.** Listed here it is refused when the sheet omits it, held when this
block asks for a click, charged to the channel's daily meter, and written to the audit log — the
same path an `[[mcp_server.tool]]` takes, resolved by the same code. Delete the block and the
channel does not get the tool. Duplicates resolve the way they do everywhere else in this file: the
stricter approval and the smaller result bound win.

`libero` is the server name these travel under, and it is **reserved**. An `[[mcp_server]]` claiming
that name is a parse error rather than a channel whose `search_channel_history` quietly leaves the
process.

There is one built-in today:

| Name | What it does |
| --- | --- |
| `search_channel_history` | Full-text search over **this channel's** stored messages. Takes words, not a query language; results are ranked by relevance rather than recency. |

Its scope is not negotiable and is not a setting. The channel comes from the client certificate, the
tool's input schema has no field for one, and the arguments are parsed strictly — so a model that
sends `{"query": "…", "channel": "C0OTHER"}` gets an error naming the key rather than another
channel's conversation. The proxy opens that channel's store read-only and can reach no other file.

Only messages the app has seen are searchable. It is not a Slack search API: nothing backfills, so
history starts when the app joined the channel. The author shown is the display name as it was when
the message was stored, and `<@U…>` mentions inside message text stay as ids — the proxy holds no
Slack token and inventing a name would be worse than showing an id.

### `[egress]`

Where traffic may go when the sheet does not already say. The code-execution sandbox has no
network at all unless this list grants it, and anything later that takes a URL as an argument
answers to the same list.

**A server's own `url` does not go here.** Declaring it under `[[mcp_server]]` is what authorizes
it — that block also carries the tool allowlist and the credential name, so the destination has
already been stated by an admin, and restating it would add a second place to get it wrong.

The two are separate on purpose, and the starter sheet shows why by naming two different hosts. The
GitHub MCP server is `api.githubcopilot.com`, declared in its `[[mcp_server]]` block; `api.github.com`
in `[egress]` is the REST API, and it is there for sandboxed code. Listing the API here does not let
anything dial the MCP server, and listing the MCP server's host here would — around the tool
allowlist that is the whole reason for going through it. A channel can reach the GitHub MCP server
without its sandbox reaching GitHub, and either grant can be made without the other.

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

---
title: Team sheets
description: The per-channel TOML manifest that declares which tools exist, which need a human click, what the budget is, and where traffic may go.
---

The team sheet is the admin surface: one TOML file per channel, intended to live in the operator's
own git repo.

The name is the football one. It is the sheet the manager submits before a match declaring who is
allowed on the pitch, what position they play, and what needs the gaffer's sign-off. Everything
enforced at runtime is a lookup into this file — all of it by the proxy except two blocks, and
[`[memory]`](#memory) says why they are the exception.

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

# Which client certificates may speak for this channel. The certificate says
# which channel is calling; this says which key is allowed to say it, so a
# leaked key is revoked by dropping its fingerprint here rather than by
# retiring the channel. Print the real value with:
#
#   sh scripts/dev-certs.sh --print-pins
#
# THE VALUE BELOW IS A PLACEHOLDER and matches no certificate. A channel
# carrying it cannot authenticate at all — every call is answered 401 until it
# is replaced. Two entries are a rotation in progress: add the new fingerprint,
# swap the material, then drop the old one.
certificate_sha256 = [
  "00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00",
]

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

# The invoice, in US dollars (#62).
#
# Beside daily_tokens rather than instead of it. Tokens are the right unit for a
# runaway brake and need no pricing knowledge at all, which is what a channel on
# self-hosted models wants; they are the wrong unit for a budget, because with
# the model switching per task the same 60k tokens is an order-of-magnitude cost
# swing. Set both and whichever binds first refuses.
#
# Priced against the model the PROVIDER SAYS IT SERVED, not the one [llm] model
# above asks for — under a router those differ, which is the whole reason this
# field exists. Spend on a model absent from the proxy's price table cannot be
# priced, and a channel with this set is refused rather than metered at zero.
# Spend reported by an agent that named no model cannot be priced either, and
# refuses the same way — that one is an agent to look at rather than a price to
# add, and the two refusals say which.
#
# There is no default: a default token count is a brake, a default dollar cap is
# a bill. Commented out here because a starter sheet must not invent one. Set it
# and the proxy needs a price table; see PROXY_PRICE_TABLE and prices/example/.
#
# daily_usd = 25.00

# What a cached token costs against daily_tokens. Cache reads and cache writes
# bill differently from ordinary input tokens; how differently is your
# provider's decision. These are Anthropic's ratios. Set cache_read_weight = 0
# to stop counting cache reads at all.
cache_read_weight  = 0.1
cache_write_weight = 1.25

# The soft limit: how far into either budget this channel gets before it is told
# once, in its thread, that it is close. The call that carries the notice still
# runs — only the hard limits above stop anything. A fraction rather than a pair
# of numbers, so there is no way to write a warning that fires after the refusal
# it exists to precede; set it to 0 to turn the warning off.
warn_at = 0.8

# What the agent remembers between tasks. MEMORY.md is one freeform markdown
# file per channel, written by a short curation turn after each reply and read
# back into the context the next task starts from. No format is imposed on it:
# your team can read it, edit it, and delete it. It lives in the agent's own
# state root, never in this directory.
#
# ON BY DEFAULT. Omit this block and the channel curates with the figures below.
# Set enabled = false and no curation turn runs at all — nothing is written and
# nothing is read back. That is the whole switch, and it is a channel's call.
#
# Unlike everything above, THIS BLOCK IS HONOURED BY THE AGENT AND NOT BY THE
# PROXY. The proxy never opens MEMORY.md, so it holds no second copy of these
# numbers to check the first against. This therefore has the standing
# daily_tokens has and not the standing daily_tool_calls has: it holds against a
# model that has been talked into filling the file, and not against a
# compromised agent process. A sheet the agent cannot read falls back to NO
# curation — the opposite of the default here, and deliberately so, because a
# typo should be able to cost a channel its memory and never to switch a feature
# on.
#
# max_file_chars is the whole file, and it is spent on every task in this
# channel: MEMORY.md goes into the context a task starts from, so its size is
# charged against max_tokens_per_task before the model has done anything. That
# is why it is the order of max_result_chars rather than the size of a document.
# At the cap an operation is REFUSED and the file is left unchanged — nothing is
# truncated and nothing is dropped from the front. Compaction is the model's own
# work, done by replacing text with a shorter version of itself.
#
# How much one operation may carry is not a field here: 4096 characters, fixed
# in @getlibero/schema, because it bounds what the MODEL may write rather than
# what this channel may spend, and the file cap already bounds the total.
[memory]
enabled        = true                       # curation: MEMORY.md, written after a reply
max_file_chars = 32768                      # the whole file; one operation may carry 4096

# Thread summaries. A thread that has been quiet for this long is summarized
# into the channel's searchable memory, whether or not anyone addressed the
# agent in it — which makes this the one setting here that spends model tokens
# with nobody waiting on the answer — the first of two, [skills] curate below
# being the other. Two switches rather than one, because a
# channel may reasonably want the agent to remember what it was asked and not to
# read conversations it was never part of.
#
# Quiet matters for correctness and not politeness: summarizing a thread that is
# still going records a conclusion the team had not reached yet. Five minutes is
# the floor, a week the ceiling.
summarize                    = true
summarize_after_idle_minutes = 60

# Skills: reusable playbooks the agent writes for itself. After a task that
# spent more than author_after_tool_calls tool calls, one extra model turn asks
# whether a playbook emerged — most of the time the answer is no — and if it did,
# writes it as a markdown file under skills/ in the agent's state root, beside
# MEMORY.md. At the head of a later task the incoming request is matched against
# the library and only the top_k best matches are loaded. Never the whole
# library, and never a skill that has been archived.
#
# ON BY DEFAULT, for the same reason curation is: a skill comes out of a task
# somebody asked for, into capped text your team can read, edit and delete, on a
# turn metered like every other. Set enabled = false and no author turn runs and
# nothing is loaded.
#
# Two things to know before leaving it on. A skill is PROCEDURAL where a memory
# fact is declarative: "the team decided X" steers a reply, "to deploy, run Y
# then Z" steers tool use. And it arrives by retrieval rather than as one file
# read whole, so you may not see a given skill unless you open the directory —
# which is why the directory is yours, in plain markdown, in your own state root.
# Nothing a skill says widens what this channel may do: every call it induces
# meets the proxy's gates exactly as if the same words had arrived in a mention.
#
# Like [memory] above, THIS BLOCK IS HONOURED BY THE AGENT AND NOT BY THE PROXY,
# with everything that follows from it — including that a sheet the agent cannot
# read falls back to NO skills, the opposite of the default here.
#
# The files are the source of truth. A skill you edit is re-indexed, one you
# delete is gone, one you write by hand joins the library. How much text one
# operation may write is not a field here — it is fixed in @getlibero/schema,
# because it bounds what the MODEL may write; max_skill_chars below bounds what a
# skill may BE, which is why it may not be set below the model's own ceiling.
#
# curate is the merge curator, and it is the SECOND setting in this file that
# spends model tokens with nobody waiting on the answer — [memory] summarize
# being the first. Once a day at most, it looks for two playbooks that are one
# playbook written twice, drafts the merge, and writes it as a PROPOSAL into
# proposals/ beside skills/. It rewrites nothing. You apply a proposal by
# replacing one skill file with the block it shows you and deleting the other;
# you decline it by deleting the proposal, and nothing needs telling.
#
# A pair is raised once and not again until one of the two descriptions changes,
# so ignoring a proposal and declining it are the same act. Three unread
# proposals stop it making more. And a deployment with NO EMBEDDING PROVIDER
# proposes nothing at all — overlap is a question about two vectors, and unlike
# retrieval there is no lexical answer to fall back on.
#
# The last two fields are the lifecycle clocks. A playbook nothing has loaded for
# stale_after_days is marked `stale` in its own frontmatter — still retrieved,
# just visibly ageing in your git history — and one nothing has loaded for
# archive_after_days is marked `archived` and leaves retrieval. The job that does
# this runs no model call and spends nothing.
#
# Three things it will not do. It NEVER DELETES A FILE: archiving is a status,
# and removing a playbook is your team's act. Loading a skill resets both clocks,
# so a playbook in use stays active. And a status YOU set by hand is respected —
# the job adopts it and starts the clock again from that moment, so archiving
# something early or reactivating something it retired both stick, and you get a
# full stale window before it has an opinion again. What ages a skill is when a
# task last loaded it, never the `created:` line in the file.
[skills]
enabled                 = true              # the author turn, and loading at task start
curate                  = true              # propose merges of overlapping playbooks
author_after_tool_calls = 5                 # strictly more than this many served calls
top_k                   = 3                 # how many skills a task may open with
max_skill_chars         = 8192              # a skill's body; one operation may write 4096
max_skills              = 100               # the whole library; nothing else bounds it
stale_after_days        = 30                # unloaded this long and a skill is marked stale
archive_after_days      = 90                # unloaded this long and it leaves retrieval

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

# An upstream secured by OAuth rather than a service token. Nothing in the
# auth block is a secret: no token, no lifetime, no endpoint. The credential is
# still a name — but this one keys a grant in the proxy's token store, written
# by the grant flow, not a vault entry an operator set. The token endpoint is
# not a field: it is discovered from the issuer and refused unless it sits on
# the issuer's own origin. Asking for scopes wider than the stored grant is a
# re-grant, not an escalation — the proxy fails closed until the grant flow is
# re-run. See "Two credential stores" in the security docs.
[[mcp_server]]
name       = "notion"
transport  = "http"
url        = "https://mcp.notion.example/mcp"
credential = "notion_grant"                 # name only; keys the stored grant

  [mcp_server.auth]
  scheme = "oauth"
  issuer = "https://auth.notion.example"    # compared byte-for-byte, never normalized
  scopes = ["mcp.read"]

  [[mcp_server.tool]]
  name     = "search_pages"
  approval = "none"

# Tools the proxy implements itself rather than dialling an upstream for. One
# provider — the proxy — so the block is flat: no url and no credential, because
# there is nothing to address and nothing to authenticate to.
#
# A built-in is not a bypass. Listed here it is refused when the sheet omits it,
# held when this block asks for a click, charged to the daily meter above, and
# written to the audit log, exactly as an [[mcp_server.tool]] is. Delete the
# block and the channel does not get the tool.
#
# Omitting `approval` does not mean here what it means on an [[mcp_server.tool]].
# There the destructive-verb heuristic decides, because those names were chosen
# by somebody else. These were chosen in this repository, so each built-in
# declares its own default: search is "none", scheduling is "required".
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

# The agent's own future checks. It asks for one now — a question, and how many
# minutes from now to ask it — and something runs that check at that time and
# posts if there is anything to say. The exact time is worked out when the create
# is approved, so nothing has to trust a language model's arithmetic about clocks.
#
# NOTE THE MISSING approval LINE, AND THAT IT MEANS THE OPPOSITE OF delete_file's.
# There, no line means the destructive-verb heuristic decides and happens to hold
# it. Here, no line IS the hold: a built-in's default is declared rather than
# guessed, and this one's is "required". Loosening it is writing approval = "none",
# which is a channel deciding that unbidden future work needs no click. Deleting
# the block is how a channel does not get this at all.
#
# TWO SWITCHES, AND BOTH HAVE TO BE ON. Listing it here is one. The other is
# [ambient] enabled below, which is false in this file — so as written, a create
# is refused, because nothing would ever run the check. That is deliberate: the
# starter sheet does not turn on unbidden speech, and this block is here to be
# read rather than to work out of the box.
#
# The channel is not a field. It comes from the client certificate when the check
# is created and from the channel's own file when it fires, so there is nothing an
# argument could name.
#
# A check runs once. It posts an answer, or it has nothing to say, or — if this
# channel is over its budget, or it could not be run — it says so in the channel
# so you can act on the timer yourself. There is no retry and no queue.
[[builtin]]
name = "schedule_task"

# Where traffic may go when this sheet does not already say.
#
# PARSED BUT NOT YET ENFORCED. Nothing in the deployment reaches a destination
# this sheet has not already pinned, so nothing consults this list — entries are
# validated when the sheet loads and permit nothing and forbid nothing. The
# surface that needs it is a code-execution sandbox, which is later work (#219).
# Write the list as though it were enforced; it is the contract it will be
# enforced against.
#
# The MCP servers above are NOT listed here: declaring a url in [[mcp_server]]
# is what authorizes it. This list is for the destinations nothing pinned.
# Keeping them apart is why allowing the GitHub MCP server
# (api.githubcopilot.com) does not also let sandboxed code call api.github.com
# directly, and why allowing the API does not let it dial the MCP server.
#
# Default deny. "*." stands for one or more subdomain labels, so
# *.internal.example.com covers build.internal.example.com but not
# internal.example.com itself. There is no allow-all.
[egress]
allow = ["api.github.com", "*.internal.example.com"]

# Proactive posting: the agent starting a task nobody asked for, on a clock of
# its own. Off by default, always — every other block on this sheet argues its
# own default by contrast with this one.
#
# Every field here has a reader: the agent process wakes on a clock, enumerates
# the channels that opted in, and runs a heartbeat for each one that is due. The
# evaluation weighs what changed since it last spoke, answers a question only
# once it has sat idle past the threshold below, and its ordinary answer is
# nothing — a post happens when something merits one, at most once per rate
# window.
#
# Two things follow from how the clock is built. A newly enabled channel waits
# one full cadence before its first heartbeat, and so does every enabled channel
# after a restart: windows the process was down for are skipped rather than
# replayed, because a heartbeat asks what merits a post *now*. And an edit here
# lands on the next tick — nothing caches this file, and nothing restarts.
#
# The cadence is an interval, not a cron expression, and there are no quiet
# hours and no timezone. A tick with nothing new to weigh is silent and spends
# nothing, so 03:00 already costs you nothing and says nothing — which is the
# whole thing a schedule with sleeping hours would have bought.
[ambient]
enabled                 = false             # off by default, always. Also the
                                            # precondition for [[builtin]]
                                            # schedule_task above: with this
                                            # false, a create is refused.
heartbeat_every_minutes = 15                # how often anyone looks; 1 to 1440

# How long a question must sit before the heartbeat may answer it — the sibling
# of [memory] summarize_after_idle_minutes, and the same rule: acting on
# something before it has gone quiet says what the moment has not earned. A
# question typed thirty seconds before a tick looks exactly like one your team
# has ignored for an hour, and answering the first front-runs the people it was
# addressed to. Want the answer now? Tag the agent; that is the designed path.
#
# This and the cadence answer different questions — this one is what counts as
# unanswered, the cadence is how often anyone looks — so the worst case for a
# proactive answer is their SUM: 75 minutes as written here.
answer_after_idle_minutes = 60              # five minutes to a week

# How often the agent may post unbidden is NOT a field. At most one
# heartbeat-initiated post per channel per rate window, stated in time rather
# than in ticks, fixed in the architecture and enforced where the post is made —
# so tightening the cadence above cannot quietly loosen the throttle.
```

## What each block does

### `[channel]`

Identity and a description. The description reaches the model: when it is non-empty it is appended
to the system prompt of every task the channel runs, so it is how the model knows what kind of
channel it is in, and it is worth writing. At most 500 characters — a longer one is a parse failure,
not a truncation — because it is charged against `max_tokens_per_task` on every task: a sentence or
two about what the channel is for, not a wiki page.

`certificate_sha256` is required, and it is the one field here that is about *authentication* rather
than about what the channel may do. It lists the SHA-256 fingerprints of the client certificates
allowed to speak for this channel; a request arriving on any other certificate is refused with a
401 before it reaches a route, even though its subject names this channel and the local CA signed
it. That is what makes a leaked private key revocable without retiring the channel — dropping a
fingerprint revokes one key, where removing the whole sheet revokes the channel.

At least one, at most four. Either written form parses — the colon-separated pairs `openssl` and
the script print, or the same digest with the colons stripped — and case does not matter. Two at
once is a rotation in progress; the whole procedure is
[rotating and revoking a certificate](/docs/self-hosting#rotating-and-revoking-a-certificate).

A fingerprint is not a secret. It is a digest of a certificate, which is a public document sent in
the clear at the start of every handshake, and holding one gets you nothing.

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

`PROXY_MAX_UPSTREAM_CONCURRENCY` is the operator's for a sharper reason: there is nowhere in this
file to put it. It caps how many calls run against one tool server at once, and a tool server is a
url and a credential that any number of channels may name — so two sheets could disagree about it
and whichever loaded first would win. If calls are coming back saying the proxy is already running
as many as it allows, that is the number to raise, and it is not in this file either.

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

`daily_usd` caps the invoice. Tokens are the right unit for a runaway brake and need no pricing
knowledge at all — a self-hosted channel has no dollar cost, and a router picking a model absent
from any price table still needs stopping — but they are the wrong unit for a *budget*: with the
model switching per task the same 60,000 tokens is an order-of-magnitude cost swing, and the number
you wrote stops meaning what you thought. Set it beside `daily_tokens` rather than instead of it,
and whichever binds first refuses. It is the one field in this block with no default, because a
default token count is a brake and a default dollar cap is a bill.

It is priced against the model the **provider says it served**, not against `[llm] model` above.
Under a router those differ, which is the whole reason the field exists. Spend on a model absent
from the proxy's [price table](/docs/price-table/) cannot be priced, so a channel with `daily_usd`
set is **refused** rather than metered at zero — a cap whose position cannot be computed is not a
cap. The same holds for spend an older agent reported without naming a model at all; the two are
different refusals with different remedies, and the proxy's log names which.

**The limits are not equally strong, and the difference is worth knowing before you rely on
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

`daily_usd` inherits `daily_tokens`' standing exactly: it is computed from the same reported
counts, so it holds against a prompt-injected model and not against a compromised agent process.

`cache_read_weight` and `cache_write_weight` decide what a cached token costs against
`daily_tokens`. Cache reads and cache writes bill differently from ordinary input tokens, and by
how much is your provider's decision — so these are settings rather than constants. The defaults
are Anthropic's ratios. A channel pins its provider by pinning `[llm] model`, which is what makes a
per-channel weight a per-provider weight; set `cache_read_weight = 0` to stop counting cache reads
against the budget at all.

That last point is about **these weights only** and does not extend to `daily_usd`. A weight is per
channel because you wrote it here; a price is per *model*, resolved against whichever model the
provider says it served — which under a router need not be the one this sheet asked for.

The meter stores the four raw counts — input, output, cache read, cache write — per model, and both
the weights and the prices are applied when a call is decided. So changing a weight, or correcting a
mistyped price, re-prices spend already recorded today on the channel's next call, rather than only
what comes after the edit. That is the reason cost is computed rather than accumulated: a price
table will eventually contain a typo, and under a stored total the only remedy would be a reset that
also discards the spend that was right.

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

**The soft limit.** `warn_at` is how far into any of the budgets a channel gets before it is told, once,
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

### `[memory]`

What the agent remembers between tasks. `MEMORY.md` is one freeform markdown file per channel,
written by a short curation turn after each reply and read back into the context the next task
starts from. No format is imposed on it, so your team can read it, edit it, and delete it. It lives
in the agent's own state root, never in the directory holding this sheet.

| Field | Required | Meaning |
| --- | --- | --- |
| `enabled` | no | Whether the curation turn runs at all. **Defaults to `true`** — the one block on this page that is on when it is absent. `false` writes nothing and reads nothing back. |
| `max_file_chars` | no | The whole file's ceiling, in characters. Defaults to `32768`. May not be set below `4096`, the most one operation may carry, or above `262144`. |
| `summarize` | no | Whether quiet threads are summarized into searchable memory. **Defaults to `true`.** |
| `summarize_after_idle_minutes` | no | How long a thread must be quiet first. Defaults to `60`. May not be set below `5` or above `10080` (a week). |

On by default, unlike `[ambient]` below, and the asymmetry is deliberate. Ambient is the agent
starting work nobody asked for. Curation is the agent remembering something it was already asked
about, into a capped file your team can read and edit, on a turn metered through the same per-turn
spend report as every other turn. Opting out is one line.

**`summarize` is two switches rather than one, and it is worth understanding before you leave it
on.** Curation follows a reply, so somebody had already asked the agent for something.
Summarization follows a thread going quiet — including threads nobody addressed the agent in — so
it is one of two settings on this page that spend your model tokens with nobody waiting on the
answer — [`[skills] curate`](#skills) is the other. It is on by default because the corpus it builds is what makes "what did we decide about
X" work at all: a team's decisions are overwhelmingly reached without the bot in the room, and a
memory that only covers threads the agent joined is a memory of the agent rather than of the team.
Turn it off with one line if you would rather it did not.

`summarize_after_idle_minutes` is the only number here that is about how your team talks rather
than about a resource, and getting it wrong is a correctness problem rather than a cost one. Too
short and a conversation still in progress gets recorded as though it had concluded — a summary
saying the team was weighing X against Y, kept and searchable, when they went on to settle on Y.
Too long and a concluded thread stays out of search while the answer in it is still wanted. Sixty
minutes is long enough that ordinary gaps do not cut a thread in half.

A thread that wakes up is re-summarized whole and its old summary replaced, and an edit or a
deletion of any message in it drops the summary and its embedding outright — so nothing derived
from a message outlives the message.

**This block is honoured by the agent, not the proxy** — and it is the first one on this page of
which that is true; [`[skills]`](#skills) below is the second and the only other. Everything else
here is enforced by the tool proxy from its own copy of this
file, and that second copy is what makes an agent process under an attacker's control unable to
widen its own permissions. The proxy never opens `MEMORY.md`; its only reach into a channel's store
is a read-only opener, so there is no second copy of these two numbers. In the terms
[`[budget]`](#budget) already uses, `[memory]` has the standing `daily_tokens` has and not the
standing `daily_tool_calls` has: it holds against a model that has been talked into filling the
file, and not against a compromised agent process.

It is consequently one of the two blocks where a sheet the agent cannot read falls back to *off*
rather than to the default above. A typo costing a channel its memory is a degradation the reply
survives; a typo switching curation on for a channel that wrote `enabled = false` would be a policy
violation.

`max_file_chars` is spent on every task in the channel, which is why the default is the order of
`max_result_chars` rather than the size of a document: `MEMORY.md` goes into the context a task
starts from, so its size is charged against `max_tokens_per_task` before the model has done
anything. At the cap an operation is **refused and the file is left unchanged**. Nothing is
truncated, nothing is dropped from the front, and the model is told which cap it hit. Compaction is
the model's own work: the two operations it gets are appending text and replacing an exact string,
and deleting is replacing with nothing. There is no operation that rewrites the whole file.

How much one operation may carry is fixed at **4096 characters** in `@getlibero/schema` and is not
a field here. It bounds what the model may write rather than what this channel may spend — the same
reason a tool description's length and a search's result limit are not fields either — and
`max_file_chars` already bounds the total.

### `[skills]`

Reusable playbooks the agent writes for itself. After a task that spent more than
`author_after_tool_calls` tool calls, one extra model turn asks whether a playbook emerged — most of
the time the answer is no, and that is the intended answer — and if one did, it is written as a
markdown file under `skills/` in the agent's state root, beside `MEMORY.md`. At the head of a later
task the incoming request is matched against the library and only the `top_k` best matches are
loaded into the opening context. Never the whole library.

| Field | Required | Meaning |
| --- | --- | --- |
| `enabled` | no | Whether the author turn runs and skills are loaded at all. **Defaults to `true`.** `false` writes nothing and loads nothing. |
| `curate` | no | Whether the merge curator proposes merges of overlapping playbooks. **Defaults to `true`.** `false` stops only that pass. |
| `author_after_tool_calls` | no | How many tool calls a task must exceed before the author turn runs. Defaults to `5`. Strictly more than this, and it counts calls the proxy served rather than calls the model attempted. |
| `top_k` | no | How many skills a task may open with. Defaults to `3`. May not be set below `1` or above `10`. |
| `max_skill_chars` | no | The longest a skill's body may be, in characters. Defaults to `8192`. May not be set below `4096`, the most one operation may write, or above `65536`. |
| `max_skills` | no | How many skills this channel may hold. Defaults to `100`. |
| `stale_after_days` | no | How long a skill goes unloaded before it is marked `stale`. Defaults to `30`. |
| `archive_after_days` | no | How long a skill goes unloaded before it is marked `archived` and leaves retrieval. Defaults to `90`. May not be below `stale_after_days`. |

**On by default, for the reason [`[memory]`](#memory) is.** A skill comes out of a task somebody
asked for, into capped text your team can read, edit and delete, on a turn metered through the same
per-turn spend report as every other turn. Opting out is one line.

Two things are worth understanding before you leave it on, and they are the honest half of the same
paragraph. **A skill is procedural where a memory fact is declarative**: "the team decided X" steers
a reply, while "to deploy, run Y then Z" steers tool use. And **a skill arrives by retrieval rather
than as one file read whole**, so you may never see a given skill unless you open the directory —
which is why the directory is yours, in plain markdown, in the agent's state root and not somewhere
you need a tool to read.

What a skill cannot do is widen anything. It is text loaded into a model's context, so every call it
induces still meets the proxy's gates — the allowlist, approvals, the budget, egress — exactly as if
the same words had arrived in a message from a person. A skill that says to run a tool this channel
does not grant produces a refusal and an audit row, not a tool call.

**Like `[memory]`, this block is honoured by the agent and not the proxy**, with everything that
follows: there is no second copy of these numbers, so it has the standing `daily_tokens` has and not
the standing `daily_tool_calls` has, and a sheet the agent cannot read falls back to *no skills*
rather than to the defaults above.

**The files are the source of truth.** A skill your team edits is re-indexed, one you delete is gone,
one you write by hand joins the library — the index follows the files and never the reverse. What
the index holds instead is what the runtime observed: when a skill was last retrieved and how often,
which is what the stale and archive clocks run on. That is deliberately not in the file. Recording a
use would otherwise mean rewriting `top_k` of your files at the head of every task, and a rewrite
from a stale read is how an edit somebody made in between gets lost.

`max_skill_chars` may not be set *below* the 4096 characters one operation may write, which is the
opposite of `max_file_chars`'s floor only in appearance: there the file accretes across operations,
here one operation writes a whole skill. A cap below what the model is told it may write would
promise a length this channel refuses. Above it is room for a longer playbook written by hand.

`max_skills` is the only thing bounding the library's size. There is no operation that deletes a
skill — archiving is a status, and removing a file is your team's act — so the count only ever grows
on its own, and what grows with it is the work of re-reading the directory and of comparing skills
against each other for overlap.

**The two clocks are the last two fields, and what they will not do matters more than what they
will.** A playbook nothing has loaded for `stale_after_days` is marked `stale` in its own
frontmatter — still retrieved exactly as before, just visibly ageing in your git history — and one
nothing has loaded for `archive_after_days` is marked `archived` and drops out of retrieval. The job
that does this runs on channel activity, makes no model call, and spends nothing.

It **never deletes a file**: archiving is a status, and removing a playbook is your team's act.
Loading a skill resets both clocks, so a playbook in use stays active. And **a status you set by
hand is input the job respects rather than fights** — it adopts what your file says and restarts the
clock from that moment, so archiving something early or reactivating something it retired both
stick, and you get a full stale window before it has an opinion again. Archiving by hand is
permanent unless you undo it, because what would bring a skill back is a task loading it and nothing
archived is ever loaded.

What ages a skill is when a task last loaded it, or, for one no task ever has, when the agent first
saw the file. Never the `created:` line — that is documentation you may edit, and no clock reads it.

**`curate` is the merge curator, and it is the second setting on this page that spends your model
tokens with nobody waiting.** Once a day at most, it looks for two playbooks that are one playbook
written twice, drafts the merge, and writes it as a **proposal** — a markdown file in `proposals/`,
beside `skills/` in the agent's state root. It rewrites nothing.

Applying a proposal is replacing one skill file with the block it shows you and deleting the other,
then deleting the proposal. Declining it is deleting the proposal, and nothing else — the agent
never hears about it either way, and a pair is not raised again until one of the two descriptions
changes. So ignoring a proposal and declining it are the same act, and there is no state you can get
wrong. Three unread proposals stop it making more, which means clearing the directory is also how
you unblock it.

The merged playbook keeps one of the two existing names, so its use counts and the date it first
appeared survive the merge. That is why applying one is two file operations rather than three.

A deployment with **no embedding provider proposes nothing at all**. Unlike retrieval, which falls
back to full text, there is no lexical answer to "are these two playbooks near each other" — so this
is off in practice wherever `AGENT_EMBEDDING_PROVIDER` is unset, without a setting saying so.

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

### `[mcp_server.auth]`

Declares an http upstream as secured by an OAuth 2.1 authorization server rather than a service
token. Only http blocks may carry it — on a stdio block it is rejected at load, naming the field,
the same way a stdio `url` is. An auth block requires a `credential` name: that name keys the
grant material the operator's grant flow stored in the proxy's token store
(`docker compose run --rm proxy node dist/grant.js add <name>` — the walkthrough is in
[Self-hosting](/docs/self-hosting/)), and it is the scheme
that decides which store a name resolves in — a bearer credential resolves in the vault, an OAuth
credential in the token store, and neither ever falls through to the other.

| Field | Required | What it is |
| --- | --- | --- |
| `scheme` | yes | `"oauth"`, the only member today. |
| `issuer` | yes | The authorization server's issuer identifier: a URL with no query and no fragment, compared byte-for-byte — against the server's own discovery metadata and against the stored grant — so write it exactly as the server publishes it. |
| `scopes` | no | The scopes the channel's calls are made under. Words, not secrets; defaults to none. |

Nothing in the block is a secret, and nothing in it can express one: there is no field for a
token, a lifetime, or an endpoint. The token endpoint is discovered from the issuer at mint time
and refused unless it sits on the issuer's own origin — an authorization server that hosts its
token endpoint elsewhere is not one this proxy will send a refresh token to.

Two edits to this block are re-grants rather than reconfigurations, and both fail closed until the
grant flow is re-run: naming a different `issuer` (the stored grant is bound to the one it was
made under), and widening `scopes` past what the grant holds. Narrowing scopes is fine. Widening a
grant is an operator act, like widening a sheet.

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
| `approval` | no | `"required"` or `"none"`, exactly as on `[[mcp_server.tool]]`. Omitted, the **default is the built-in's own** — see below. |
| `max_result_chars` | no | This tool's own ceiling, overriding `[llm] max_result_chars`. |

**A built-in is not a bypass.** Listed here it is refused when the sheet omits it, held when this
block asks for a click, charged to the channel's daily meter, and written to the audit log — the
same path an `[[mcp_server.tool]]` takes, resolved by the same code. Delete the block and the
channel does not get the tool. Duplicates resolve the way they do everywhere else in this file: the
stricter approval and the smaller result bound win.

`libero` is the server name these travel under, and it is **reserved**. An `[[mcp_server]]` claiming
that name is a parse error rather than a channel whose `search_channel_history` quietly leaves the
process.

**Omitting `approval` does not mean the same thing here as it does on an `[[mcp_server.tool]]`.**
There, the destructive-verb heuristic decides, because those names were chosen by somebody else and
a guess from the verb is the only thing available. These names were chosen in this repository, so
each built-in **declares** its own default and the table below states it. Writing the line always
wins; leaving it out gets you the declared default rather than a guess.

There are two built-ins today:

| Name | Default `approval` | What it does |
| --- | --- | --- |
| `search_channel_history` | `none` | Full-text search over **this channel's** stored messages. Takes words, not a query language; results are ranked by relevance rather than recency. |
| `schedule_task` | **`required`** | Creates one future check: a question, and how many minutes from now to ask it. At that time the agent runs that check and posts if there is anything to say. |

Its scope is not negotiable and is not a setting. The channel comes from the client certificate, the
tool's input schema has no field for one, and the arguments are parsed strictly — so a model that
sends `{"query": "…", "channel": "C0OTHER"}` gets an error naming the key rather than another
channel's conversation. The proxy opens that channel's store read-only and can reach no other file.

Only messages the app has seen are searchable. It is not a Slack search API: nothing backfills, so
history starts when the app joined the channel. The author shown is the display name as it was when
the message was stored, and `<@U…>` mentions inside message text stay as ids — the proxy holds no
Slack token and inventing a name would be worse than showing an id.

#### `schedule_task`

**Two switches, and both have to be on.** Listing it here is one; [`[ambient] enabled`](#ambient) is
the other. A create against a channel with ambient off is refused, because nothing would ever run
the check.

**It is held by default, and that is the whole of its governance.** A create is a served tool call
like any other — allowlisted, held for a click, charged to the meter, written to the audit log — and
the card the approver clicks shows the question and the time, so a human reads the text before it
becomes future work. Writing `approval = "none"` is a channel deciding that unbidden future work
needs no click. That is a real choice and the sheet lets you make it; it is not the default because
forgetting a line should not be how a channel makes it.

**The model sends an offset, not a time.** How many minutes from now, and the exact instant is
worked out when the create is served — so nothing depends on a language model knowing what time it
is, and there is no timezone anywhere in this. A check fires at its instant rather than at the next
heartbeat, once, and late counts as due: one that came due while the process was down fires when it
comes back, not once per window it missed.

**A check runs once, and says so when it cannot.** It fires, and one of four things happens: it
posts an answer, it runs and has nothing to say (the ordinary outcome of a conditional check), or —
if the channel is over its daily budget, or the check could not be run at all — **the channel is
told, in that one post, that the check did not happen**. Either way the check is done: there is no
queue, no retry and no second attempt. That is deliberate. A reminder that silently slips is worse
than one that says it could not run, because the team can still act on the timer themselves.

The one exception is `[ambient] enabled`. Switched off between the approved create and the due
time, nothing fires and nothing is said — that switch means *do not speak here*, and a notice would
be the agent speaking after being told not to. The check waits, and fires once, late, if the
channel turns ambient back on.

**What bounds it is fixed, not configurable.** How many checks may be waiting, how far out one may
be scheduled, how soon, and how long the question may be are architecture constants rather than
fields on this sheet — the same argument `[ambient]` makes for the rate limit on unbidden posts.
Each has its own refusal, so a model that asks for more is told which bound it met. There is no
recurrence, and no path to improvise one: a fired check makes no tool calls at all, so it cannot
schedule its own successor. Giving a fired check the governed tool path is
[#348](https://github.com/getlibero/libero/issues/348), and standing schedules at a clock time are
a parked design of their own ([#358](https://github.com/getlibero/libero/issues/358)).

The channel is not a field, here or anywhere. It comes from the client certificate when the check is
created and from the channel's own file when it fires.

### `[egress]`

Where traffic may go when the sheet does not already say — the code-execution sandbox, and
anything later that takes a URL as an argument.

:::note[Validated today, enforced when its first caller lands]
Nothing in the deployment consults this list yet, because nothing in it reaches a destination the
sheet has not already pinned. Entries are still parsed and checked when the sheet loads, so a
malformed one is rejected where you can see it rather than sitting inert in a list you believe
grants something — but a channel's `[egress]` block currently permits and forbids nothing. The
surface that needs it is a code-execution sandbox, which is later work; the matcher and its
adversarial tests are [#73](https://github.com/getlibero/libero/issues/73), and wiring the first
caller is [#219](https://github.com/getlibero/libero/issues/219). Write the block as though it
were enforced — everything below is the contract it will be enforced against.
:::

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

Redirects are not followed, and that half **is** live today: an upstream answering `302` would
send the proxy to a host no sheet named, so the call fails instead.

### `[ambient]`

Proactive posting: the agent starting a task nobody asked for, on a clock of its own.

:::note[Read, and by both services]
This block is live. `enabled` and `heartbeat_every_minutes` drive the agent's clock, which wakes at
the next due instant and reaches a channel through the same session a task does;
`answer_after_idle_minutes` is read by the heartbeat evaluation, before any model call, to decide
whether a question has sat long enough to be worth answering. Setting `enabled = true` turns
something on.

`enabled` is also the one field on this page the **tool proxy** reads, and it reads nothing else
here. A [`schedule_task`](#builtin) create against a channel with this switched off is refused,
because nothing would ever run the check — and a channel quietly accumulating approved future work
that no clock will enumerate is worse than a refusal, since a human clicked Approve on each of them.
:::

| Field | Required | Meaning |
| --- | --- | --- |
| `enabled` | no | Whether the heartbeat runs at all. **Defaults to `false`** — the block every other `enabled` on this page argues its own default against. |
| `heartbeat_every_minutes` | no | How often the agent looks. Defaults to `15`. May not be set below `1` or above `1440` (a day). |
| `answer_after_idle_minutes` | no | How long a question must sit before the heartbeat may answer it. Defaults to `60`. May not be set below `5` or above `10080` (a week). |

Off by default, always, and it is the one block on this page where that is the whole guard.
Turning it on is one line, and the figures beside it default like every other figure on this
sheet — `enabled = true` on its own is a valid sheet, not an error.

**The cadence is an interval, not a cron expression.** There are no quiet hours and no timezone,
and they are not omissions. A tick with nothing new to weigh is silent by construction and spends
nothing, so a 03:00 tick already costs you nothing and says nothing — which is everything a
schedule with sleeping hours would have bought. What it would have cost is a timezone on your
sheet, because `0 9 * * 1-5` is 09:00 for nobody in particular.

**A question is not unanswered until it has sat.** Sampled at an instant, "unanswered" is
meaningless: a question typed thirty seconds before a tick looks exactly like one your team has
ignored for an hour, and answering the first front-runs the people it was addressed to. So
`answer_after_idle_minutes` is the sibling of [`summarize_after_idle_minutes`](#memory) in name
and in kind — both say that acting on something before it has gone quiet says what the moment has
not earned. If you want the answer now, tag the agent; that costs one word and is the designed
path.

The two figures answer different questions — the threshold is what counts as unanswered, the
cadence is how often anyone looks — so **the worst case for a proactive answer is their sum**: 75
minutes at the defaults. That is the number to move if proactive answers feel late, and the
threshold is usually the half worth moving.

**How often the agent may post unbidden is not a field.** At most one heartbeat-initiated post per
channel per rate window, stated in time rather than in ticks — one post per tick is no throttle
once ticks are minutes apart — and it is fixed in the architecture, enforced where the post is
made rather than asked of the model. So tightening `heartbeat_every_minutes` cannot quietly loosen
the throttle.

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

The retain rule is worth reading once more in the context of `certificate_sha256`, because it is the
one field where "the previous version stays active" can mean "the key you were revoking is still
accepted". An edit that removes a fingerprint has not taken effect until the sheet parses — watch
for `team_sheet_reloaded` in the proxy's log, and treat `team_sheet_invalid` with
`effect: "previous_sheet_retained"` as the revocation not having landed — unless a later
`team_sheet_reloaded` carries `supersedes: "team_sheet_invalid"`, which means the proxy read the
file mid-write and the sheet on disk is fine. When a key is known to be
compromised and the edit is not going smoothly, delete the sheet: that is exempt from the retain
rule, takes effect immediately, and takes the channel offline until you restore it.

Because the sheets are files in your git repo, the review trail for "who allowed the agent to
deploy" is your normal pull request history. That is deliberate: a web admin UI is an explicit
non-goal for v1, and the files *are* the admin UI.

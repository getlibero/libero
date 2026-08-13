---
title: The price table
description: What a model's tokens cost, so a channel's daily_usd can mean something. Micro-USD per million tokens, four tiers per model, and a model with no price refuses rather than costing nothing.
---

A team sheet's [`[budget] daily_usd`](/docs/team-sheet/#budget) caps a channel's invoice. The proxy
cannot resolve that without knowing what a model's tokens cost, and no provider tells it — so the
prices are a file you write, review, and mount read-only, exactly as you do the team sheets.

You need one only if a channel sets `daily_usd`. A workspace capping tokens and tool calls needs no
prices, and `PROXY_PRICE_TABLE` can stay unset.

```toml
[[model]]
id          = "claude-sonnet-4-6"
input       = 3_000_000
output      = 15_000_000
cache_write = 3_750_000
cache_read  = 300_000
```

`prices/example/prices.toml` in the repository is the starter file to copy.

## Units

**Micro-USD per million tokens, as integers.** Money is not a float: a budget that accumulates a
fraction per token drifts, and the drift is invisible until someone disputes a refusal. Per
*million* rather than per token because a per-token price in micro-USD would round to zero for every
model on the market, and a table of zeroes is a table nobody can review.

| what you mean | what you write |
| --- | --- |
| $3.00 per million input tokens | `input = 3_000_000` |
| $0.30 per million cache reads | `cache_read = 300_000` |
| free | `0` |

**All four tiers are required.** Cache reads run about a tenth of input price and cache writes above
it, so a table that gave them one number would be wrong by an order of magnitude on a cache-heavy
agent — which is every agent here. The meter keeps the four counts apart all the way to the decision
precisely so this can.

`0` is legal and means free: a self-hosted model whose real dollar cost is nothing, said out loud.
Leaving a model out is the *different* statement that its spend cannot be priced at all.

## Key it by the model that served, not the model you asked for

The `id` must be the one the **provider echoes back**. Usually that is the one your team sheet's
`[llm] model` asked for, and under a router it is not: a LiteLLM sidecar resolves an alias, and
Bedrock and Vertex carry their own prefixes. That difference is the whole reason `daily_usd` exists
— a cap in tokens is only a cap on spend if the model is fixed.

The proxy logs the served id on every spend report, which is where to read the spelling this file
needs:

```
{"event":"spend_reported","channel":"C024BE91L","model":"claude-sonnet-4-6","tokens":1247,…}
```

`node dist/budget.js show <channel>` prints the same thing as a per-model split of the day.

## A model with no price refuses

**Spend the table cannot price stops the channel**, rather than costing nothing. A model absent from
the table is like a tool absent from the allowlist: the answer is a refusal. It reads oddly the
first time, because the channel may be nowhere near its cap — but a cap whose position cannot be
computed is not a cap, and the alternative prices unknown models free, which is exactly how a router
becomes an uncapped spend path.

Two faults, because the remedies differ and the proxy says which:

| the channel is told | what happened | what to do |
| --- | --- | --- |
| *…is not in the proxy's price table* | a model was reported that this file does not list | add it, naming the id in the message |
| *…was reported without naming a model* | the agent reported counts but no model | upgrade or look at the agent; the proxy log names the reports |

Neither can happen to a channel that does not set `daily_usd`. Without that field the price table is
never consulted at all.

Two reserved ids appear in `budget.js show` and never in this file. `(unreported)` is spend whose
report named no model — it is the second row above. `(legacy)` is spend recorded before the meter
had a model column at all; it is priced at zero, because no sheet asked for it to be capped when it
was spent, and it ages out with one UTC day.

## Editing it while the proxy runs

The file is re-read when it changes, so **correcting a price re-prices spend already recorded
today**, on the channel's next call. That is deliberate: a price table is config you author, so it
will eventually contain a typo, and if cost were accumulated as it was metered the only remedy would
be a budget reset — which also discards the spend that was right.

A file that stops parsing keeps the last good table and says so in the log, so a syntax error
mid-edit does not widen or narrow anything. A file that is **removed** drops it, because serving
prices out of bytes that are no longer on disk is serving a number nobody can review — and dropping
it fails closed.

There is **no shipped default table**. A price list baked into a released image goes stale on the
provider's schedule and is then trusted, which is the failure this whole feature exists to fix.

## Versions

The version recorded against a decision is the **digest of the file's bytes**, not a line in it. A
declared `version = "3"` is a claim about the bytes that nothing checks, and two tables that differed
by a digit could call themselves the same thing. The digest is logged when the table loads:

```
{"event":"price_table_loaded","file":"/data/prices/prices.toml","version":"a3f1c02e5b7d9e14","count":4}
```

Keep the file in git, and that digest ties a running proxy's prices to a commit.

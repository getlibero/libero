# @getlibero/agent

The half of the system that talks to a model. A provider-agnostic completion
layer, the ReAct loop that drives it, and the client that reaches tools — which
is a network call to the tool proxy service and nothing else.

Unpublished workspace package. The specification is
[the architecture page](https://getlibero.com/docs/architecture); this file is
what the code does and why, which is a narrower thing.

## The boundary

**This package may never import the tool proxy's package.** The only path from
here to a tool is the network call, and it is enforced twice — an ESLint
`no-restricted-imports` rule and a grep-level `pnpm boundary-check`, which is a
raw string match rather than an import match so it also catches a comment and a
`package.json` dependency edge. On this side of the line, write "the tool proxy
service" rather than naming the package.

What follows from it: this package constructs no tool client of its own,
resolves no allowlist, and holds no credential a tool would take. Compromising
the process that runs this code yields no tool credentials. It is *not*
credential-free — the model provider key is here, and the composing app holds
the Slack tokens — which is why the claim is always written as **tool**
credentials.

## The loop

`runAgentTask` is one task: a model turn, its tool calls, their results, repeat
until the model stops or a cap ends it.

It **never rejects for a cap or a tool failure** — both are results, because the
channel has to be told which limit ended its task. It does reject when the tool
listing cannot be fetched or the provider fails for a reason that is not
cancellation: an unreachable provider is an operator problem, and answering it
with a synthesized reply would look like it worked.

`AgentLoopCaps` has four fields and **no defaults on the interface**, so a caller
cannot leave a task uncapped by omission. They are defence in depth: the proxy's
meter is authoritative and enforces the channel's real budget. These exist so a
task that runs away terminates here too rather than relying on a single control.

Tool calls in a batch are dispatched **sequentially, not concurrently**.
Dispatching at once would let a cap with one call of allowance left run all of
them, would put a whole batch in front of a human at the same moment when
approvals land, and would make the order of metering and audit records
nondeterministic. The cost is latency on parallel calls, which is not the binding
constraint on a task answering in a Slack thread.

Every tool call gets a result message even when a cap stopped it before it ran.
A transcript holding a tool call with no matching result is not a valid
conversation to continue from, so skipping those would make a capped task
unresumable.

## This package cannot log, and should not learn how

There is no logger here and none should be added. What a log line wants — the
channel, the front-end's trace id — is held by the composing app and not by a
client pinned to one task, and a package that logged would be one deciding what
an operator sees about a channel it cannot name.

So anything worth recording leaves through a callback, and the composing app
turns it into a line. That is why `spend_reported` and `tool_not_permitted` are
words in `apps/server` rather than here.

**Every one of those callbacks must not throw.** Nothing catches them: a
rejection propagates into the loop and ends a task, losing a user's answer
because a counter or a card could not be written. Catching them here would be
worse — with no way to log, a swallowed failure vanishes instead of being
reported. A caller that can fail swallows its own failure where it has a logger.

| Callback | Awaited | What it is for |
| --- | --- | --- |
| `onTurn(usage, turn)` | **yes** | What the turn cost, to the proxy's meter |
| `onToolCall(step)` | no | Progress, for the live checklist |
| `onUnmappedCall(call)` | no | A name the model invented, for the operator |
| `onBudgetWarning(warning)` | no | The channel crossed its soft limit |

`onTurn` is the one that is awaited, and deliberately: a detached call would let
the next turn start before this one reached the meter, which is the ordering the
meter is being told about. `onToolCall` is the opposite for the opposite reason —
its consumer edits a Slack message, and awaiting that would put a network round
trip between every tool call and the next, making a task as slow as the surface
watching it.

## Reaching tools

`src/proxy/` is the client: an mTLS transport over `node:https`, `ToolSource`
over `GET /v1/tools`, `ToolExecutor` over `POST /v1/tools/call`. Both halves come
from one object because they share one thing — the mapping from the flat name a
model calls to the `(server, tool)` pair the proxy takes.

**Pinned to one channel at construction.** The channel is not a parameter on
`execute`, so there is no call this object can make that a different certificate
would authenticate.

**The agent does not filter the list.** The proxy has already resolved it against
the channel's team sheet, and a second opinion here would either agree — dead
code that can drift — or disagree, which would mean the model's tools are decided
by the process running the model. There is exactly one enforcement point and it
is not this one.

### Names are looked up, never parsed

Two things about the mapping are load-bearing:

- **The flat name is decoded to a pair by a map built from the listing.**
  `ResourceName` permits dots and underscores, so any separator is ambiguous, and
  a name the proxy did not publish has no pair to become.
- **A name is chosen from `server` and `tool` alone**, which keeps names stable
  across sessions now that a listing carries more than the sheet: an upstream
  that reorders its catalog changes a description, not a name.

A name with no pair is refused without sending anything, and reported through
`onUnmappedCall` — the only record of it, since the proxy never saw the call and
rightly writes no audit row. Without that, a model can probe fifty names and the
audit log shows a task that made no tool calls. The name is model-authored text,
so it travels as a value and never as part of a sentence.

### A held call

With an `onHeld` prompter, a hold is waited out and the identical call
re-submitted carrying the ticket — **on every wait outcome**: approve, deny,
expiry, even a prompter that threw. The proxy answers a re-submission with either
the result or the precise refusal and is the authority on what the call became,
so there is one code path rather than four. The model sees one tool result either
way and never the ticket id.

Re-submitting the *identical* body is load-bearing: redemption matches server,
tool, and the argument hash, so any drift turns an approval into a mismatch
refusal.

Without a prompter — a front-end with no one to ask — a hold degrades to the
refusal-shaped result it is. Safe, and it abandons a call a human could have
approved.

A prompter may resolve to a `HeldCallCompletion`, which this client calls with
what the re-submission became. That is the *opposite* direction and carries no
authority either — it tells, it does not ask — and it exists so a card can go
green only once the call has actually run.

## What a turn costs

`src/proxy/spend.ts` reports four raw token counts to `POST /v1/spend`, fired
from `onTurn` after every model turn rather than once when the task ends.

**Per turn is the load-bearing part.** A task-end report means a long task spends
its whole cost before the meter hears any of it, so a channel over its cap is
refused starting with the *next* mention rather than this task's next tool call —
and a task that dies mid-flight spends silently, because `runAgentTask` rejects
and everything counted so far goes with the rejection.

The turn id is `<task>.<n>`, so each turn is its own idempotency key and a retry
is a `duplicate` rather than a double charge.

### And whether to spend it at all

`src/proxy/budget.ts` is that client's mirror (#335): `GET /v1/budget`, answering
what the tool gate would say about spending in this channel right now. The
asymmetry between the two is deliberate on both ends — the spend client writes a
counter and can read nothing, this one reads and can write nothing.

It exists because a completion does not go through the tool proxy service at all.
That service enforces `[budget]` on a tool call, which is the only spend it
observes, so a turn that calls no tool met no bound however far over its caps a
channel was. The four background passes in `apps/server` are the callers; three
of them spend, and each asks before it does.

**It is advisory rather than a boundary**, and the header says so: a compromised
agent process does not ask. What it buys is a correctly-functioning deployment
not spending a channel's budget on work nobody requested.

Two shapes differ from the spend client, and both invert its stated reasoning.
It **takes the caller's `AbortSignal`** — that one refuses a signal because a
cancelled task still spent tokens, and this one is asked *before* anything is
spent, so cancelling is exactly right. And it carries a short deadline of its
own as well, because a background pass holds only the shutdown signal and runs on
its channel's session mutex: a question left hanging would stall the next task's
context read behind it.

A failure throws. What an unanswerable question *means* is the composer's, and
`apps/server` answers "do not spend".

**Four numbers, never a total.** Weighting is the proxy's, from `[budget]
cache_read_weight` and `cache_write_weight` — cache reads run about a tenth of
input price, so a meter that collapsed the tiers would be wrong by an order of
magnitude on a cache-heavy agent, which is every agent here.

**And which model spent them** (#62), when the provider echoed one. The report
carries it beside `usage`, and the proxy prices a channel's spend by it.

The distinction that field exists for: `CompletionRequest.model` is what the
channel's `[llm] model` or `AGENT_MODEL` *asked for*, and
`CompletionResponse.model` is what actually served the turn. A router — the
LiteLLM sidecar behind an `OPENAI_BASE_URL` is the case — resolves an alias, so
under one they are different strings, and only the second has a price. Both
adapters read it off the response envelope beside the counts, and **neither falls
back to the requested id**: substituting it would price a router's `smart` as
`smart`, silently wrong in exactly the deployment a dollar cap exists for.

`completion/served-model.ts` is the one rule both adapters read it through, and
it validates there rather than at the wire. `SpendReport` is strict, so a
malformed id would fail the whole report — and the report is what carries the
*token counts*. The degradation has to be "unreported", never "unmetered": the
proxy meters a turn with no model under a bucket no price table can name, which
refuses a channel capped in dollars and changes nothing for one that is not.

The counts are the provider's response envelope's, so the report holds against a
**prompt-injected model** and not against a **compromised agent process**. The
narrower claim is the true one, as with tool credentials. The model id is in that
same class and no weaker: it is a **dimension of a count, never a permission** —
it selects a price and nothing else, naming a cheaper model buys exactly what
under-reporting the counts already buys, and naming an unpriced one refuses the
channel. The lie that would help most, naming nothing, is the one that stops it.

`loop/caps.ts:totalTokens` stays as defence in depth rather than as a stand-in
for the meter.

One gap is deliberate rather than overlooked: a report still in flight when the
process exits is lost, since neither the gateway's stop nor the task abort drains
one (#118). At most one turn per task, and it under-reports, so the budget fails
open.

## The curation turn

`src/curation/turn.ts` is one extra model call after a task's reply has already
posted, offered the two memory tools and nothing else. Layer 2's inner loop — the
pattern the architecture credits to Letta.

**It is one call, not a second loop, and the shape is what bounds it.** The only
definitions offered are `MEMORY_TOOLS` from `@getlibero/schema`; a name that is
not one of the two is answered `unknown_tool` by `parseMemoryOp` and dispatched
nowhere, because there is no executor here that could reach a proxied tool. The
instructions in `CURATION_SYSTEM_PROMPT` ask for durable team facts, and a model
that ignores them is still bounded by the tool set, by
`MEMORY_OP_MAX_TEXT_CHARS`, by the store's own file cap, and by the meter.

**Nothing here writes a file.** Operations go to `applyOp`, the same callback
shape `onTurn`, `ToolSource` and `HeldCallPrompter` already use, and it is why
this package still depends on `@getlibero/schema` and nothing else. The
composition root wires it to `openMemoryFile`; the loop has never known what is
on the other end of a side effect, and a memory write is not the thing to change
that for.

**The model is not told what its operations did.** There is no second call to
read a result in, and that is deliberate: the model is holding the file's
contents when it writes a `find`, and the prompt carries the file's size and its
cap, so a failure is a model that ignored what was in front of it rather than one
that lacked information. Whatever is left over corrects itself one task later,
because the next curation turn reads the real file. `memoryOpMessage`'s sentences
go to the caller's log, which is where an operator reads them.

Spend is reported through `onTurn` exactly as the loop's own turns are, with the
turn number the caller supplies — the loop's count plus one, so the id stays
`<task>.<n>`. **`max_tokens_per_task` deliberately does not apply**: the turn runs
after the reply posted, so the task is over, and a task that ended by spending its
cap is exactly the one most worth remembering. One call bounded by
`max_tokens_per_turn`, with the proxy's daily meter as the backstop.

`curationTranscript` strips the task's tool traffic before the model sees it —
`tool` messages, the `toolCalls` that produced them, any assistant turn that was
only calls, and `providerState`. The first forces the rest: a tool-use block with
no matching result is not a conversation a provider will accept. The cost is that
a fact which appeared only inside a tool result and never reached the model's own
prose is invisible to curation, which is the price of not re-sending a whole tool
conversation to record one sentence.

## Embeddings are a second seam, not a method on the first

`src/embedding/` is `EmbeddingClient`, its OpenAI-compatible adapter, and its own
conformance suite. It exists separately from `CompletionClient` for a reason that
is not symmetry: **Anthropic publishes no embeddings endpoint**, so an `embed()`
on the completion client would be a method one of the two shipped adapters must
throw from — a contract with a hole in it, and a conformance suite that has to
learn to skip. Two client types, each wholly implemented by whoever implements
it, is the shape that stays honest.

It follows that the embedding provider is **configured separately** and is
usually a different vendor: `AGENT_EMBEDDING_PROVIDER` and its three companions,
none of them derived from `AGENT_PROVIDER`. All four are optional together, and
that is the only optional provider in the deployment — memory Layers 1 and 2 are
whole without embeddings, so an unset provider logs `embeddings_unconfigured`
once and the process carries on. `apps/server/README.md` has the contract.

**The OpenAI-compatible dialect ships first, and there is no incumbent to be
native to.** On the completion side the Anthropic adapter exists because that is
what the deployment completes against; here there is no such vendor, so what is
left is coverage per adapter. `/v1/embeddings` is what OpenAI, Voyage, Together,
Gemini's compatibility endpoint, Ollama and a LiteLLM sidecar all implement, and
one adapter reaches every one of them by base URL. A native Voyage or Cohere
adapter is a separate argument, and the same one Azure, Bedrock and Gemini's
native API have on the completion side: they differ in auth or wire format, not
just endpoint.

Three decisions inside the adapter are worth knowing. **The interface takes
texts, plural, always**, because every endpoint batches and an interface taking
one string makes the caller's loop the place batching gets forgotten. **Vectors
are ordered by the response's own `index`**, never by arrival — the API documents
that field precisely because order is not guaranteed, and a vector paired with
the wrong text is the failure with no symptom: nothing errors, recall just
answers with the wrong thing. And **`encoding_format: "float"` is sent
explicitly**, because several compatible servers default to base64, which would
arrive as strings where the adapter expects numbers.

Spend needs nothing new on the wire. A `SpendReport` is `{ turn, model, usage }`
and an embedding call fills `usage` with input tokens and no output ones, so
`EmbeddingUsage.inputTokens` is named exactly as `TokenUsage.inputTokens` is and
the mapping stays a copy rather than a translation. `EmbeddingResponse.model` is
the **served** model for #62's reason plus one of its own: `packages/memory`
stamps that id against a channel's vectors and refuses a later one from a
different model, so an id quietly substituted from the request would be a file
claiming its vectors are comparable when they are not.

Nothing calls `embed()` yet. #232 decides where recall enters a task; this is the
surface it will call.

## The summarization turn

`src/summarize/turn.ts` is one model call over one thread that has gone quiet,
producing Layer 3's second corpus (#231). It is built to `curation/turn.ts`'s
shape — one call, no loop, no reachable proxied tool, spend through the same
`onTurn` — and differs in three ways that are the reason it is a separate turn.

**It is not triggered by a person.** Curation follows a reply, so a task happened
and somebody was waiting. This follows a thread going quiet, in a channel whose
members may never have addressed the agent. That is the first model spend in the
deployment that does not follow a mention, which is why `onTurn` is required here
rather than optional: a deployment that forgot to wire the meter should be a type
error, not a discovery. `[memory] summarize` is where a channel says no.

**Quiet is a correctness condition.** A summary written mid-conversation records
that the team was weighing X against Y, gets embedded, and is then retrieved by
exactly the question it is worst at answering, because they went on to settle it.
The caller decides a thread is quiet; this turn assumes it.

**The shape follows the thread.** `SummaryShape` in `@getlibero/schema` carries
the vocabulary and the argument. What matters here is that `nothing` is a
first-class answer and the prompt says so first and plainly — a model asked to
classify will otherwise reach for the nearest non-empty option, and every one it
reaches for is a vector diluting the corpus.

The one tool it offers writes nothing; it is the structured-output idiom, and its
definition lives in this module rather than in `@getlibero/schema` because
nothing else ever offers it. What crosses packages is the *result*,
`ThreadSummary`, which is in schema where the store can see it. A model that
answers with no tool call, or with arguments that do not fit, produces `nothing`
and a `malformed` reason — the caller records the row either way, because the
same thread with the same content will fail the same way and re-sweeping it
forever is the runaway this design is most exposed to. A provider that *throws*
is the other case entirely: it propagates, no row is written, and the thread is
swept again later.

Note it takes `SummarizationMessage` and not `StoredMessage`. This package
depends on `@getlibero/schema` and nothing else, which is what keeps the package
whose job is talking to a model free of a state root, a file handle and a SQLite
dependency.

## The skill-author turn

`src/skill/turn.ts` is one model call after a tool-heavy task has replied,
deciding whether a reusable playbook emerged and writing it through the two
operations `@getlibero/schema` publishes (#291). Curation's shape again — one
call, no loop, no reachable proxied tool, nothing here that writes a file, spend
through the same `onTurn` before any operation runs — and it differs in three
ways.

**It is triggered by a count, and the caller owns the count.** Curation follows
every task; this follows only one whose *served* tool calls exceeded `[skills]
author_after_tool_calls`. The threshold is a channel's policy and this package
cannot read a team sheet, so the test lives in `apps/server`. Below the line the
task was a question with a lookup, and a playbook for that is a playbook for
reading. Declining is still the ordinary outcome above it, and there is no
`skill_none` to say so with: nothing re-triggers this turn, so absence is the
decline and a member for it would be a row nothing reads.

**It sees the tool traffic, where curation deliberately does not.**
`curationTranscript` strips it, on the argument that a durable fact reaches the
reply. That argument inverts here, because `SKILL_TOOLS` asks a body for exactly
the traffic curation throws away — the calls that worked, in an order that
matters, with the parts that are easy to get wrong. So `skillTranscript` renders
each assistant turn as its own words plus a line per call, and applies one rule:
**a success contributes its name and arguments and not its result; a failure
keeps its text.** A JSON response cut at `SKILL_STEP_MAX_CHARS` ends mid-object
and teaches nothing, where a refusal or a 404 is short, complete, and the thing a
playbook should warn about. It is rendered rather than replayed because a
tool-use block with no matching result is not a conversation a provider accepts,
and because `providerState` belongs to the conversation that produced it.

**Its neighbours are handed in.** `nearby` is what retrieval already loaded at
the head of this task (#292) — the nearest existing skills on its own subject,
resolved once, at no extra cost. That is what makes `skill_revise` usable at all:
a revision replaces a body outright, so a model that cannot see the body it is
replacing can only overwrite it blind. They are rendered in full, and the type is
`NearbySkill` rather than `SkillFile` deliberately: `created` and `status` are
not the model's, so they are not shown to it.

None of that is what governs the turn. The tool set is two, `parseSkillOp`
answers `unknown_tool` for anything else and dispatches it nowhere, the two size
caps and `max_skills` are the store's, and the tokens reach the proxy's meter
through the same per-turn report every other turn uses.

## The merge turn, and the option it does not have

`src/skill/merge.ts` is the curator's half of #295: one call handed two playbooks
in full and asked whether they are one, drafting a merge if they are and calling
nothing if they are not. Structurally it is `runSummarizationTurn` rather than the
author turn above it, and the difference between those two is the whole point.

**It takes no handler.** `runSkillAuthorTurn` takes an `applyOp` because authoring
writes; this produces a value and the caller decides what to do with it. So "the
curator writes no skill file" is not a promise this package makes but a shape it
has — there is no callback here that could be wired to one, and `packages/agent`
still writes nothing at all. What the caller does with the draft is render it into
a file that nothing ever reads back.

**Its tool is not a third `SkillToolName`**, and that is a schema decision this
turn depends on: that enum's totality drives `SKILL_TOOLS`, and
`skillToolDefinitions()` above maps over its options — so a third member would
hand the *author* turn a tool that writes nothing and names a pair it was never
given. The two vocabularies stay apart, and a test holds the enum at two.

Both skills are rendered whole, `nearby`'s argument sharpened: a merge replaces
the kept body outright, so a model that cannot see the body it is replacing can
only overwrite it blind. `created` and `status` are not shown — they are not the
model's, they play no part in whether two playbooks are one, and the merged skill
inherits them from whichever name survives.

The one thing the system prompt says that the tool description does not is why the
pair is in front of the model at all. Nomination is "these two are each other's
nearest", which on a small library is a statement about the library rather than
about the pair — and a model that believes two playbooks were selected *because*
they overlap will find the overlap. Declining is the ordinary answer here, and it
costs nothing.

## Layout

| Path | What it is |
| --- | --- |
| `completion/` | The provider-agnostic seam, its adapters, and `conformance.ts` |
| `embedding/` | The embedding seam, its OpenAI-compatible adapter, and its own `conformance.ts` |
| `loop/loop.ts` | The ReAct loop |
| `loop/caps.ts` | The cap tracker and the composed abort signal |
| `loop/types.ts` | `AgentLoopCaps`, `AgentStopReason`, the hook contracts |
| `curation/turn.ts` | The post-reply memory turn, its prompt, and `MemoryOpHandler` |
| `summarize/turn.ts` | The quiescence summarization turn and its prompt |
| `skill/turn.ts` | The post-reply skill-author turn, its prompt, `skillTranscript` and `SkillOpHandler` |
| `proxy/transport.ts` | mTLS over `node:https` |
| `proxy/tools.ts` | `ToolSource` + `ToolExecutor`, and the held-call path |
| `proxy/tool-names.ts` | Flat name to `(server, tool)`, and why it is a lookup |
| `proxy/spend.ts` | The spend sender |

Adapters are tested through `completion/conformance.ts`, which drives a real
adapter with fetch-level fixtures. The loop is faked at the `CompletionClient`
seam instead — reusing conformance there would tie every loop test to one
provider's JSON, which is the coupling the completion layer exists to remove.

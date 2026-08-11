---
title: Connecting GitHub
description: The first real upstream, end to end — a personal access token in the proxy's vault, GitHub's hosted MCP server in a team sheet, and an audit row at the end of it.
---

:::caution[Tool calls do not complete yet]
Connecting works: the proxy handshakes with GitHub, authenticates with your token, and publishes
GitHub's real tool definitions to the model. **Calls are then refused by GitHub.**

Its tool schemas annotate `owner` and `repo` with `x-mcp-header`, and the Streamable HTTP transport
requires a client to mirror those values into `Mcp-Param-{name}` request headers. Libero's MCP
client does not, so GitHub answers JSON-RPC `-32020`, *"header mismatch: missing Mcp-Param-owner
header"*. Since `owner` and `repo` are on nearly every GitHub tool, nearly every call is affected.

Nothing about your token, sheet, or vault is wrong when you see this, and there is no
configuration that works around it — it is a gap in the proxy. Everything below is accurate and
worth setting up now; the calls will start completing when that lands.
:::

GitHub publishes a hosted MCP server at `https://api.githubcopilot.com/mcp/`. It is the first real
upstream Libero was built against, and connecting it is three things: a token in the proxy's vault,
one `[[mcp_server]]` block per toolset in the channel's team sheet, and a mention.

The token goes into the proxy and stays there. The agent process — the one running the model, the
one a prompt injection reaches — never receives it, never learns its value, and knows it only by the
name written in the sheet. That is the property the whole two-service split exists for, and it is
the reason this page is longer than "paste a URL".

## 1. Mint a token

Use a [fine-grained personal access token](https://github.com/settings/personal-access-tokens/new),
on an account that exists for this and nothing else. The agent will act as whoever this token is.

Grant the least the toolsets you are about to allowlist actually need. For the pull-request reads
below that is **Metadata: read-only**, **Contents: read-only**, and **Pull requests: read-only**,
scoped to the repositories the channel should see. A classic PAT with the `repo` scope also works
and is worse: it is every repository the account can reach, with write.

Two separate boundaries are in play and you want both:

- **GitHub's**, the token's permissions. This is what stops a mistake in a team sheet from
  becoming a write.
- **Libero's**, the team sheet's tool allowlist and approval marks. This is what stops the model
  calling a tool nobody meant it to have, and what puts a human in front of the ones that matter.

Neither substitutes for the other. A read-only token with a careless sheet is noisy; a careful
sheet with an owner-scoped token is one bug away from a force-push.

## 2. Load it into the vault

From inside the proxy container, so the master key never has to exist on the host:

```bash
docker compose run --rm proxy node dist/vault.js set github_service_account < token.txt
docker compose run --rm proxy node dist/vault.js list    # names only
```

The value is read from stdin rather than an argument, because `ps` shows arguments to every user on
the box and a shell writes them to history. There is no command that prints a credential back. The
proxy reads the vault at startup, so a new entry takes effect on restart.

`github_service_account` is the name the team sheet will refer to. Names travel; values do not.

## 3. Point a channel at it

In `channels/<channel id>/channel.toml`:

```toml
[[mcp_server]]
name       = "github"
transport  = "http"
url        = "https://api.githubcopilot.com/mcp/x/pull_requests/readonly"
credential = "github_service_account"

  [[mcp_server.tool]]
  name     = "list_pull_requests"
  approval = "none"

  [[mcp_server.tool]]
  name     = "pull_request_read"
  approval = "none"
```

That is a complete, safe first connection: a server-side read-only endpoint, and a two-tool
allowlist inside it. Sheets are picked up on file change, so no restart is needed for this part.

### The url is the configuration

GitHub's hosted server takes its configuration two ways, and only one of them is reachable from a
team sheet.

| URL | What it publishes |
| --- | --- |
| `https://api.githubcopilot.com/mcp/` | the default toolsets |
| `https://api.githubcopilot.com/mcp/readonly` | the same, minus every write tool |
| `https://api.githubcopilot.com/mcp/x/pull_requests` | one toolset |
| `https://api.githubcopilot.com/mcp/x/pull_requests/readonly` | one toolset, reads only |

The toolset names are GitHub's: `pull_requests`, `issues`, `repos`, `actions`, `code_security`,
`dependabot`, `discussions`, `gists`, `notifications`, `orgs`, `projects`, `secret_protection`,
`security_advisories`, `users`, and about ten more. `/x/all` exists. Do not use it: the proxy
describes at most 100 tools per upstream to the model, and a catalog that large is a large per-turn
context cost for tools the channel is not allowed to call anyway.

The other way is a set of `X-MCP-Toolsets`, `X-MCP-Readonly` and `X-MCP-Tools` request headers.
**A team sheet has no field for request headers and should not grow one.** A headers field is a
place to write a token into the one file whose defining property is that it holds none, and the URL
path says the same thing in a field that is already reviewed.

### Get the url exactly right

**Redirects are not followed.** A redirect target is the one destination in the system that nothing
declared — the sheet named a url, and a `302` is chosen by the upstream at call time — so the proxy
refuses one rather than following it. In practice this means `https://api.githubcopilot.com/mcp` and
`https://api.githubcopilot.com/mcp/` are not interchangeable, and a near-miss surfaces as a failed
call rather than as a silently corrected one.

The `/x/<toolset>` forms carry no trailing slash. Copy them.

### One block per toolset

One block holds one url, and for this server one url is one toolset. A channel that needs pull
requests and repository contents gets two blocks:

```toml
[[mcp_server]]
name       = "github"
transport  = "http"
url        = "https://api.githubcopilot.com/mcp/x/pull_requests"
credential = "github_service_account"
# …tools…

[[mcp_server]]
name       = "github_repos"
transport  = "http"
url        = "https://api.githubcopilot.com/mcp/x/repos"
credential = "github_service_account"
# …tools…
```

One credential, however many blocks. Give them different `name`s: two blocks *may* share a name —
that is how a long tool list gets split — but only if every block carrying a given tool agrees on
the upstream, and these two do not point at the same url. Sharing a name here would refuse the call
as `server_ambiguous`.

The model sees the bare tool name, `list_pull_requests`, not `github__list_pull_requests`. The
server name only enters the model-facing name when two servers publish the same tool.

### The allowlist is still the boundary

A toolset path narrows what GitHub *publishes*. `[[mcp_server.tool]]` decides what exists for the
channel: a tool not listed is not in the definitions the agent fetches, and a call to it is refused
in the proxy regardless.

So `/readonly` is defence in depth rather than a replacement for reading the tool names. Both, or
neither will save you.

An entry naming a tool the toolset does not publish is not an error — it stays in the allowlist with
no description and no argument schema, and fails at GitHub when called. If a tool you allowlisted
answers "unknown tool", check which toolset it lives in before you check the spelling.

## 4. Approval, and GitHub's tool names

A tool marked `approval = "required"` is held in the proxy and raises an Approve once / Deny card in
the thread. A tool that says nothing falls to a heuristic: a name containing **delete**, **drop**,
**transfer**, or **deploy** is held.

**Read GitHub's tool names against that list before you rely on it.** Almost none of GitHub's
destructive tools are named in a way the heuristic catches:

| Held by the heuristic | Not held — mark these yourself |
| --- | --- |
| `delete_file` | `merge_pull_request` |
| `delete_workflow_run_logs` | `push_files` |
| | `create_or_update_file` |
| | `issue_write` |
| | `pull_request_review_write` |
| | `create_pull_request`, `update_pull_request` |
| | `fork_repository`, `create_repository` |
| | `run_workflow`, `cancel_workflow_run` |

This is the heuristic working as designed rather than failing. It is a default for the entry nobody
thought about, and an explicit `approval` in the sheet always wins. It is not a substitute for
having thought about them:

```toml
  [[mcp_server.tool]]
  name     = "merge_pull_request"
  approval = "required"
```

## 5. What the model is handed

The proxy asks GitHub for its `tools/list` and publishes each allowlisted tool's description and
argument schema to the model, so the model calls tools accurately rather than guessing.

Those descriptions are **upstream-authored text that enters the model's context on every turn**.
Nothing in Libero reads them or makes decisions from them — a rule that read a description is a rule
an upstream phrases its way around — so what bounds them is size, not content: a description is
truncated at 1,024 characters, a schema is dropped past 8 KB, at most 100 tools per upstream are
described, at most five catalog pages are walked, and the whole walk gets five seconds. Naming the
server in the sheet is what accepts that text. Name servers you would accept text from.

Tool *results* are bounded separately, by the channel: `[llm] max_result_chars` (32,768 by default),
overridable per tool. A GitHub PR list is worth less context than a diff, so:

```toml
  [[mcp_server.tool]]
  name             = "list_pull_requests"
  approval         = "none"
  max_result_chars = 8000
```

## 6. Verify it

Mention the app in the channel and ask it something the allowlist covers — "what's open on
getlibero/libero". Then read the log:

```bash
docker compose run --rm proxy node dist/audit.js list --channel C024BE91L
```

A served call is one row, `outcome = ran`, naming the server, the tool, the requester, a hash of the
arguments, and the size of the result. That row is the demonstration; the reply in the thread is
only the visible part of it.

Today the row appears and the reply carries GitHub's `-32020` refusal rather than an answer — see
the note at the top of this page. What that row still proves is worth knowing: the channel was
resolved from the client certificate, the sheet permitted the tool, the credential was found in the
vault and accepted by GitHub, and the call was metered and recorded. The gap is in one step, and it
is the last one.

The verification is also automated. `e2e/src/github-live.test.ts` in the repository runs exactly
this path against real GitHub and is skipped unless `LIBERO_GITHUB_PAT` is set:

```bash
pnpm -r build
LIBERO_GITHUB_PAT=… pnpm --filter @getlibero/e2e exec vitest run src/github-live.test.ts
```

From a channel whose sheet has no GitHub block, the same question gets *"This channel's team sheet
does not list the server `github`. The call was not made."* and an `outcome = refused` row. A
channel with no sheet at all gets *"This channel has no team sheet, so no tool call is permitted."*
and nothing leaves the proxy.

### When it does not work

The messages are deliberately specific about what did and did not happen.

- *"The credential `github_service_account` is named in this channel's team sheet but is not in the
  vault."* — the `vault.js set` did not land, or the proxy has not restarted since it did.
- *"The tool endpoint answered HTTP 401."* — GitHub rejected the token. Check it has not expired and
  that its permissions cover the toolset.
- *"The tool server could not be reached: `redirected`."* — the url. See above.
- *"The tool server does not speak a version of MCP this proxy supports."* — not something GitHub's
  hosted server should produce; if you see it, the url is reaching something else.
- *"The tool server's answer was larger than this proxy will accept."* — `PROXY_MAX_RESPONSE_BYTES`,
  a deployment setting, 4 MiB by default. The call was made; the answer was discarded.

The token appears in none of these, in no log line, and in no result relayed to the model. If you
ever find it in one, that is a security bug and [SECURITY.md](https://github.com/getlibero/libero/blob/main/SECURITY.md)
is the way to report it.

## GitHub Enterprise

**Enterprise Cloud** with a `ghe.com` subdomain has its own host, and the rest of this page is
unchanged:

```toml
url = "https://copilot-api.<subdomain>.ghe.com/mcp"
```

**Enterprise Server** has no hosted MCP endpoint; it needs GitHub's local server, which speaks stdio
rather than HTTP. `transport = "stdio"` is in the schema and is not implemented — a stdio upstream
is a process the proxy would have to spawn and sandbox, which is tracked and not built.

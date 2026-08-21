// The rebuild CLI's process shell. Composition only: everything it does lives in
// ./rebuild-cli.ts, where it can be tested without a process or a provider.
//
// Two things are built here and nowhere else, for ./tasks.ts's reason — a command
// that reached a network from the module under test would not be one. The
// embedding client is the same one the sweep uses, off the same variables. The
// meter is `./index.ts`'s `reportTurn` narrowed to what this needs.
//
// **The proxy transport is built on the first report and not at startup.** An
// argument error, a channel that has nothing to do, and a provider that reported
// no usage all reach the end without one — and an operator who mistyped a
// channel id should get the usage line rather than a stack trace about a
// variable their typo did not concern.
//
// **Nothing here logs JSON.** The server process does, because a log line there
// is read by whatever collects them; this writes to a terminal an operator is
// watching, and one interleaved JSON object in the middle of the run's output
// would be the only thing on screen that is not a sentence.

import {
  createEmbeddingClient,
  createProxySpendClient,
  createProxyTransport,
  totalTokens
} from "@getlibero/agent";
import type { ProxyTransport } from "@getlibero/agent";
import { embeddingConfigFromEnv, proxyConfigFromEnv } from "./env.js";
import { EXIT_ERROR, runRebuildCommand } from "./rebuild-cli.js";

const err = (line: string): void => void process.stderr.write(`${line}\n`);

let transport: ProxyTransport | undefined;

try {
  const embedding = embeddingConfigFromEnv(process.env);

  process.exitCode = await runRebuildCommand({
    argv: process.argv.slice(2),
    env: process.env,
    out: line => void process.stdout.write(`${line}\n`),
    err,
    embedding: embedding === null ? null : createEmbeddingClient(embedding.config),
    ...(embedding === null ? {} : { embeddingModel: embedding.model }),
    reportTurn: async (channel, turn) => {
      if (totalTokens(turn.usage) === 0) return;
      try {
        transport ??= createProxyTransport(proxyConfigFromEnv(process.env));
        await createProxySpendClient({ transport, channel }).report(
          turn.id,
          turn.usage,
          turn.model
        );
      } catch (error) {
        // A rebuild whose meter is unreachable still rebuilds. The alternative
        // is an operator repairing recall being stopped by a proxy that is down,
        // which trades a visible cost for an invisible outage. Said on stderr so
        // it is visible without being mistaken for the run's own output.
        err(
          `rebuild: ${totalTokens(turn.usage)} tokens for ${channel} could not be reported ` +
            `to the meter (${error instanceof Error ? error.name : "unknown"})`
        );
      }
    }
  });
} catch (error) {
  // Everything above the command: a missing or contradictory environment. One
  // line, because the message names the variable and a stack names this file.
  err(`rebuild: ${error instanceof Error ? error.message : "could not start"}`);
  process.exitCode = EXIT_ERROR;
}

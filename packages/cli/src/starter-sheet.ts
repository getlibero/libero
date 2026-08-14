// The team sheet `libero channel add` writes.
//
// Two required fields and nothing else, which is not laziness: a sheet with no
// `[[mcp_server]]` and no `[[builtin]]` grants no tools, and every other block
// has a default the schema supplies. So the channel this creates authenticates
// and is permitted nothing, which is the only safe state for a channel nobody
// has yet decided anything about. Granting is a separate act, done by editing
// this file, and `channels/example/channel.toml` is the annotated reference for
// what can go in it.
//
// The prose is deliberately short. The example sheet is two thirds comments
// because it is documentation; this one is a file an operator is about to edit
// and commit, and a generated header they have to read past every time is a
// header they stop reading.

import { CertificateSha256, ChannelId } from "@getlibero/schema";

export interface StarterSheet {
  readonly channel: string;
  readonly name: string;
  readonly fingerprint: string;
}

/**
 * TOML for a new channel, or a thrown error if either value is not what it
 * claims to be.
 *
 * The two interpolations are checked rather than escaped: a channel id and a
 * fingerprint both come from closed alphabets, so anything that could change
 * the shape of the file is rejected before it is written rather than quoted
 * into it. The name is the one free-text field, and it is escaped.
 */
export function renderStarterSheet(sheet: StarterSheet): string {
  if (!ChannelId.safeParse(sheet.channel).success) {
    throw new Error(`not a channel id: ${sheet.channel}`);
  }
  if (!CertificateSha256.safeParse(sheet.fingerprint).success) {
    throw new Error(`not a certificate fingerprint: ${sheet.fingerprint}`);
  }

  return [
    `# Team sheet for ${sheet.channel}.`,
    "#",
    "# The admin surface: what this channel's agent may do, what it must ask a",
    "# human about first, and what it may spend. Nothing here is a secret —",
    "# credentials are named, and resolved only inside the proxy's vault. Keep",
    "# this file in git; an invalid sheet is rejected loudly and the last valid",
    "# version stays active.",
    "#",
    "# As written, this channel can authenticate and call nothing. There is no",
    "# [[mcp_server]] and no [[builtin]], so it has no tools; the caps and the",
    "# daily budget are the schema's defaults. Adding a tool is adding a block",
    "# here — see channels/example/channel.toml for every field, annotated.",
    "#",
    "# One thing is on: the agent curates a MEMORY.md for this channel after each",
    "# reply, capped, in its own state root. That is not a tool call and reaches",
    "# nothing outside this channel. Turn it off with a [memory] block saying",
    "# enabled = false.",
    "",
    "[channel]",
    `name = ${quote(sheet.name)}`,
    "",
    "# Which client certificates may speak for this channel. The certificate",
    "# says which channel is calling; this says which key is allowed to say it,",
    "# so a leaked key is revoked by dropping its fingerprint here rather than",
    "# by retiring the channel. Written by `libero channel add` from the",
    "# certificate it had just minted.",
    "#",
    "# Two entries are a rotation in progress: `libero channel rotate` mints a",
    "# replacement and prints its fingerprint, you add it here, and",
    "# `libero channel promote` swaps the material once you have. Drop the old",
    "# line when a call has succeeded on the new one.",
    "certificate_sha256 = [",
    `  "${sheet.fingerprint}",`,
    "]",
    ""
  ].join("\n");
}

/** A TOML basic string. JSON's escapes are a subset of TOML's. */
function quote(value: string): string {
  return JSON.stringify(value);
}

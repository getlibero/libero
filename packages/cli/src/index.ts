#!/usr/bin/env node
// @getlibero/cli — placeholder release (defensive namespace claim).
//
// Still a placeholder at the close of phase 1, which did not build it: `init`,
// `channel add` and `doctor` — the host-authored half of a deployment — are
// #217, and #218 is this file learning to fail loudly on an argument instead of
// printing the banner and exiting 0. The vault, the budget and the audit log
// are read and written by the proxy's own entrypoints instead, because those
// files live in container volumes the host cannot see (#98).
// The short link, not the raw invite — the rule for everything outside site/,
// since a published version cannot be edited if the invite is rotated. Doubly
// so here: this is stdout, read off a screen and retyped rather than clicked.
console.log("libero: this is a placeholder release.");
console.log("  repo     https://github.com/getlibero/libero");
console.log("  discord  https://getlibero.com/discord");
